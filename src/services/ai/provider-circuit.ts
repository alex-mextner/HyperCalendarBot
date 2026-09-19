// src/services/ai/provider-circuit.ts
//
// A durable circuit per provider ACCOUNT. When a provider reports that the
// account itself cannot serve requests — credits spent, quota spent, key
// rejected — asking again changes nothing until a human or a billing period
// intervenes, yet every request of every chain used to pay that rejection before
// reaching a provider that works. This remembers "the account is out" so the
// chain skips it silently, and tells the admin once per incident.
//
// Contract:
//
//   • Scope is the account, not the chain. The key is a fingerprint of provider
//     id, endpoint and credential, so a depleted account is skipped by the smart
//     and the fast chain alike, and a rotated key starts with a clean record.
//   • Opening is immediate for account failures (402, quota-worded 429, 401/403)
//     and needs a streak for availability faults (5xx, connection errors) —
//     one blip must not silence a provider. A size rejection, a bad request and a caller abort say nothing about the account and never count;
//     the per-chain memory in provider-eligibility.ts still covers the first two.
//   • Open means skipped. When it may be tried again is decided by an explicit
//     signal (Retry-After, a reset timestamp that carries its zone) or bounded
//     exponential backoff. The deadline only makes a probe ALLOWED: the circuit
//     closes when a provider actually answers, never because time passed.
//   • Half-open is a lease. One UPDATE hands the probe to exactly one caller,
//     across processes sharing the file; a crashed holder's lease expires.
//   • One notice per incident. The incident starts with its notice `pending`; it
//     has a leased delivery claim and an acknowledged final state; failed sends
//     return to pending with a bounded retry delay, not a digest escalation.
//     Later probes never touch it, and a success starts the next incident clean.
//     The notice is built from class, status and the provider's stated reset —
//     never from the provider's error body.
//   • Healthy traffic takes no write lock: the ready path is one SELECT, and a
//     success writes only when a row exists.
//
// State lives in a sidecar SQLite file (`<DATABASE_PATH>.provider-state.sqlite`,
// mode 0600), not in the calendar database, so it needs no calendar migration and
// survives restarts and deploys. Tests default to memory. The shipped synthetic
// probe configures the same sidecar without configuring an admin sender. Storage
// errors fail open — a broken sidecar must not take the AI chain down with it.

import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  canSendProviderIncident,
  classifyProviderFailure,
  type ProviderChainKind,
  quotaResetHint,
  sendProviderIncident,
} from '../../utils/ai-provider-alert.ts';
import { logger } from '../../utils/logger.ts';
import { retryAfterMs } from './provider-eligibility.ts';
import type { ProviderId } from './provider-ids.ts';

const circuitLogger = logger.child({ module: 'ai-circuit' });

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Longest an explicit reset is trusted; bounds damage from a malformed timestamp. */
const MAX_EXPLICIT_RESET_MS = 32 * DAY_MS;
/** How long a probe holder owns the half-open attempt before it is presumed crashed. */
export const CIRCUIT_LEASE_MS = 2 * MINUTE_MS;
/** Consecutive availability faults, with no answer in between, that open a circuit. */
export const TRANSIENT_OPEN_THRESHOLD = 3;

export type CircuitFailureClass = 'quota_exhausted' | 'auth_failed' | 'unavailable';

const BACKOFF: { [failureClass in CircuitFailureClass]: { baseMs: number; capMs: number } } = {
  quota_exhausted: { baseMs: 5 * MINUTE_MS, capMs: 6 * 60 * MINUTE_MS },
  auth_failed: { baseMs: 5 * MINUTE_MS, capMs: 6 * 60 * MINUTE_MS },
  unavailable: { baseMs: 15_000, capMs: 10 * MINUTE_MS },
};

/** The retry delay after `step` failed probes: exponential, capped per class. */
export function circuitBackoffMs(failureClass: CircuitFailureClass, step: number): number {
  const { baseMs, capMs } = BACKOFF[failureClass];
  return Math.min(baseMs * 2 ** Math.min(step, 30), capMs);
}

/** Test seam for the clock; production reads the wall clock. */
export const providerCircuitClock = { now: (): number => Date.now() };

// ── Classification ─────────────────────────────────────────────────────────

export interface CircuitFailureInput {
  status: number | undefined;
  message: string;
  headers?: unknown;
  /** The provider looked unreachable or broken (5xx, timeout, connection error). */
  providerDown: boolean;
}

export interface CircuitVerdict {
  failureClass: CircuitFailureClass;
  status: number | null;
  /** When the provider itself said it recovers; null means "use backoff". */
  retryAtMs: number | null;
  /** The reset the provider quoted, verbatim (its timezone is unknown). */
  resetHint: string | null;
}

/** Only a reset that names its zone is unambiguous enough to schedule on. */
const ZONED_RESET =
  /(?:resets?|restored)(?:\s+\w+){0,4}\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))/i;

function explicitResetAt(input: CircuitFailureInput, now: number): number | null {
  const header = retryAfterMs(input.headers, now);
  if (header !== null) return now + Math.min(header, MAX_EXPLICIT_RESET_MS);
  const stated = input.message.match(ZONED_RESET)?.[1];
  if (!stated) return null;
  const at = Date.parse(stated.replace(' ', 'T'));
  return Number.isNaN(at) || at <= now ? null : Math.min(at, now + MAX_EXPLICIT_RESET_MS);
}

/**
 * Decides whether a failure is a statement about the ACCOUNT. The status must
 * be present for account classes: error text echoes the request, which makes
 * text alone a way for a user to open a circuit.
 */
export function classifyCircuitFailure(input: CircuitFailureInput, now: number): CircuitVerdict | null {
  const { status } = input;
  // Rejections about this request must not silence unrelated, valid requests.
  if (
    status === 429 &&
    /request (?:is )?too (?:large|big)|context (?:length|window)|maximum (?:context|input)/i.test(input.message)
  )
    return null;
  if (status === 403 && /content policy|safety (?:policy|filter)/i.test(input.message)) return null;
  if (status === 401 || status === 402 || status === 403 || status === 429) {
    const classified = classifyProviderFailure({ provider: 'circuit', status, message: input.message });
    const failureClass = status === 429 ? 'quota_exhausted' : classified;
    if (failureClass === 'quota_exhausted') {
      return {
        failureClass,
        status,
        retryAtMs: explicitResetAt(input, now),
        resetHint: quotaResetHint(input.message),
      };
    }
    if (failureClass === 'auth_failed') return { failureClass, status, retryAtMs: null, resetHint: null };
  }
  if (input.providerDown) {
    return { failureClass: 'unavailable', status: status ?? null, retryAtMs: null, resetHint: null };
  }
  return null;
}

// ── Keys ───────────────────────────────────────────────────────────────────

/** Identifies one provider account. Contains neither the endpoint nor the credential. */
export function providerCircuitKey(provider: ProviderId, baseUrl: string, apiKey: string): string {
  const digest = createHash('sha256').update([provider, baseUrl, apiKey].join('\0')).digest('hex');
  return `${provider}:${digest.slice(0, 32)}`;
}

export interface CircuitContext {
  key: string;
  provider: ProviderId;
  /** Provider slot name including the model, e.g. `z.ai (glm-5.1)`. */
  label: string;
  /** Chain that observed the failure; only used to route the admin notice. */
  chain: ProviderChainKind;
}

// ── Store ──────────────────────────────────────────────────────────────────

type NoticeState = 'none' | 'pending' | 'claimed';

interface CircuitRow {
  key: string;
  provider: string;
  label: string;
  chain: string;
  state: 'closed' | 'open';
  failure_class: CircuitFailureClass;
  status: number | null;
  consecutive_failures: number;
  backoff_step: number;
  opened_at: number;
  ready_at: number;
  lease_owner: string | null;
  lease_until: number;
  notice_state: NoticeState;
  notice_owner: string | null;
  notice_until: number;
  reset_hint: string | null;
}

export type Admission =
  | { kind: 'allow' }
  | { kind: 'probe'; owner: string }
  | { kind: 'skip'; status: number | null; failureClass: CircuitFailureClass; noticePending: boolean };

const SCHEMA = `CREATE TABLE IF NOT EXISTS provider_circuit (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  chain TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('closed', 'open')),
  failure_class TEXT NOT NULL,
  status INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  backoff_step INTEGER NOT NULL DEFAULT 0,
  opened_at INTEGER NOT NULL DEFAULT 0,
  ready_at INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  notice_state TEXT NOT NULL DEFAULT 'none' CHECK (notice_state IN ('none', 'pending', 'claimed')),
  reset_hint TEXT,
  notice_owner TEXT,
  notice_until INTEGER NOT NULL DEFAULT 0
)`;

const INSERT_ROW = `INSERT OR REPLACE INTO provider_circuit
  (key, provider, label, chain, state, failure_class, status, consecutive_failures, backoff_step,
   opened_at, ready_at, lease_owner, lease_until, notice_state, reset_hint)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 0, ?, ?)`;

export class ProviderCircuitStore {
  constructor(private readonly db: Database) {}

  read(key: string): CircuitRow | null {
    return this.db.query<CircuitRow, [string]>('SELECT * FROM provider_circuit WHERE key = ?').get(key);
  }

  /** Decides whether a request may use the provider. Writes only to hand out a probe. */
  admit(key: string, now: number): Admission {
    const row = this.read(key);
    if (!row || row.state !== 'open') return { kind: 'allow' };
    const skip: Admission = {
      kind: 'skip',
      status: row.status,
      failureClass: row.failure_class,
      noticePending:
        (row.notice_state === 'pending' && row.notice_until <= now) ||
        (row.notice_state === 'claimed' && row.notice_until > 0 && row.notice_until <= now),
    };
    if (now < row.ready_at || now < row.lease_until) return skip;
    const owner = randomUUID();
    const claimed = this.db.run(
      `UPDATE provider_circuit SET lease_owner = ?, lease_until = ?
       WHERE key = ? AND state = 'open' AND ready_at <= ? AND lease_until <= ?`,
      [owner, now + CIRCUIT_LEASE_MS, key, now, now],
    );
    return claimed.changes === 1 ? { kind: 'probe', owner } : skip;
  }

  /** Records a failure. Returns true when this call opened a new incident. */
  recordFailure(ctx: CircuitContext, verdict: CircuitVerdict, leaseOwner: string | null, now: number): boolean {
    return this.db
      .transaction(() => {
        const row = this.read(ctx.key);
        if (row?.state === 'open') {
          // A failure that was already in flight when the circuit opened is the same
          // incident; only the probe holder's failure moves the backoff along.
          if (leaseOwner !== null && row.lease_owner === leaseOwner) this.reopen(row, verdict, now);
          return false;
        }
        if (verdict.failureClass === 'unavailable') {
          const streak = (row?.consecutive_failures ?? 0) + 1;
          if (streak < TRANSIENT_OPEN_THRESHOLD) {
            this.insert(ctx, verdict, 'closed', streak, now, 'none');
            return false;
          }
        }
        const notice: NoticeState = 'pending';
        this.insert(ctx, verdict, 'open', 0, now, notice);
        return true;
      })
      .immediate();
  }

  private insert(
    ctx: CircuitContext,
    verdict: CircuitVerdict,
    state: 'closed' | 'open',
    streak: number,
    now: number,
    notice: NoticeState,
  ): void {
    const readyAt = verdict.retryAtMs ?? now + circuitBackoffMs(verdict.failureClass, 0);
    this.db.run(INSERT_ROW, [
      ctx.key,
      ctx.provider,
      ctx.label,
      ctx.chain,
      state,
      verdict.failureClass,
      verdict.status,
      streak,
      now,
      state === 'open' ? readyAt : 0,
      notice,
      verdict.resetHint,
    ]);
  }

  private reopen(row: CircuitRow, verdict: CircuitVerdict, now: number): void {
    const step = row.backoff_step + 1;
    const readyAt = verdict.retryAtMs ?? now + circuitBackoffMs(verdict.failureClass, step);
    this.db.run(
      `UPDATE provider_circuit
       SET backoff_step = ?, ready_at = ?, lease_owner = NULL, lease_until = 0,
           failure_class = ?, status = ?, reset_hint = ?
       WHERE key = ?`,
      [step, readyAt, verdict.failureClass, verdict.status, verdict.resetHint, row.key],
    );
  }

  /** An answer closes the incident. Writes only when there is something to close. */
  recordSuccess(key: string): boolean {
    const row = this.read(key);
    if (!row) return false;
    this.db.run('DELETE FROM provider_circuit WHERE key = ?', [key]);
    return row.state === 'open';
  }

  /** Gives the probe back without a verdict; `retryAt` postpones the next one. */
  releaseLease(key: string, owner: string, retryAt: number | null): void {
    this.db.run(
      `UPDATE provider_circuit SET lease_owner = NULL, lease_until = 0, ready_at = COALESCE(?, ready_at)
       WHERE key = ? AND lease_owner = ?`,
      [retryAt, key, owner],
    );
  }

  /** Atomically takes the pending notice; null when there is none or another caller took it. */
  claimNotice(key: string, now = providerCircuitClock.now()): CircuitRow | null {
    const row = this.read(key);
    if (
      !row ||
      row.notice_state === 'none' ||
      row.notice_until > now ||
      (row.notice_state === 'claimed' && row.notice_until === 0)
    )
      return null;
    const owner = randomUUID();
    const taken = this.db.run(
      `UPDATE provider_circuit SET notice_state='claimed',notice_owner=?,notice_until=?
      WHERE key=? AND state='open' AND notice_until<=? AND
      (notice_state='pending' OR (notice_state='claimed' AND notice_until>0))`,
      [owner, now + CIRCUIT_LEASE_MS, key, now],
    );
    return taken.changes === 1 ? { ...row, notice_owner: owner, notice_until: now + CIRCUIT_LEASE_MS } : null;
  }
  finishNotice(key: string, owner: string, sent: boolean, now: number): void {
    this.db.run(
      `UPDATE provider_circuit SET notice_state=?,notice_owner=NULL,notice_until=?
      WHERE key=? AND state='open' AND notice_owner=?`,
      [sent ? 'claimed' : 'pending', sent ? 0 : now + MINUTE_MS, key, owner],
    );
  }

  close(): void {
    this.db.close();
  }
}

/** Opens (creating if needed) the sidecar file with owner-only permissions. */
export function openProviderCircuitStore(path: string): ProviderCircuitStore {
  const onDisk = path !== ':memory:';
  if (onDisk) {
    mkdirSync(dirname(path), { recursive: true });
    // Created 0600 before SQLite touches it: the -wal and -shm files copy the mode.
    closeSync(openSync(path, 'a', 0o600));
  }
  const db = new Database(path, { create: true });
  try {
    if (onDisk) chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 3000');
    if (onDisk) db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    return new ProviderCircuitStore(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

// ── Process-wide circuit ───────────────────────────────────────────────────

let activeStore: ProviderCircuitStore | null = null;

function store(): ProviderCircuitStore {
  activeStore ??= openProviderCircuitStore(':memory:');
  return activeStore;
}

/** Call once at startup with the sidecar path. An unusable path degrades to memory. */
export function configureProviderCircuit(databasePath: string): void {
  resetProviderCircuit();
  try {
    activeStore = openProviderCircuitStore(databasePath);
  } catch (err) {
    circuitLogger.error({ err }, 'Provider circuit file unusable — keeping the state in memory for this process');
  }
}

/** Closes the store and forgets every circuit held in memory. For tests and reconfiguration. */
export function resetProviderCircuit(): void {
  activeStore?.close();
  activeStore = null;
}

/** Runs one storage operation, failing open: a broken sidecar must not stop the chain. */
function guarded<T>(operation: string, fallback: T, run: () => T): T {
  try {
    return run();
  } catch (err) {
    circuitLogger.warn({ err, operation }, 'Provider circuit storage failed — treating the provider as available');
    return fallback;
  }
}

// ── Notice ─────────────────────────────────────────────────────────────────

const pendingNotices = new Set<Promise<void>>();
export async function flushProviderCircuitNotices(): Promise<void> {
  await Promise.all([...pendingNotices]);
}
/** Claim before sending; failed delivery retries later, not on every user request. */
function deliverPendingNotice(key: string): void {
  if (!canSendProviderIncident()) return;
  const s = store();
  const row = s.claimNotice(key, providerCircuitClock.now());
  if (!row?.notice_owner) return;
  const finish = (sent: boolean) =>
    guarded('notice-ack', undefined, () => {
      s.finishNotice(key, row.notice_owner!, sent, providerCircuitClock.now());
    });
  try {
    const result = sendProviderIncident({
      provider: row.label,
      failureClass: row.failure_class,
      status: row.status,
      resetHint: row.reset_hint,
    });
    if (typeof result === 'boolean') finish(result);
    else {
      const pending = result.then(finish, () => finish(false)).finally(() => pendingNotices.delete(pending));
      pendingNotices.add(pending);
    }
  } catch {
    finish(false);
  }
}

// ── Attempt lifecycle ──────────────────────────────────────────────────────

/** Whether a request may use the provider now: allow, probe (holds the lease) or skip. */
export function admitProvider(ctx: CircuitContext): Admission {
  return guarded<Admission>('admit', { kind: 'allow' }, () => {
    const admission = store().admit(ctx.key, providerCircuitClock.now());
    if (admission.kind === 'skip') {
      circuitLogger.debug(
        { provider: ctx.provider, chain: ctx.chain, failureClass: admission.failureClass },
        'Provider circuit open — skipping without a request',
      );
      if (admission.noticePending) deliverPendingNotice(ctx.key);
    }
    return admission;
  });
}

/** The provider answered: the incident, if any, is over. */
export function settleAnswered(ctx: CircuitContext): void {
  guarded('answered', undefined, () => {
    if (store().recordSuccess(ctx.key)) {
      circuitLogger.info({ provider: ctx.provider, chain: ctx.chain }, 'Provider circuit closed — provider answered');
    }
  });
}

/**
 * The attempt failed. Returns true when the failure is an account-level one the
 * circuit now owns — the caller must not report it to the alert layer again.
 */
export function settleFailure(ctx: CircuitContext, admission: Admission, input: CircuitFailureInput): boolean {
  return guarded('failure', false, () => {
    const now = providerCircuitClock.now();
    const verdict = classifyCircuitFailure(input, now);
    if (!verdict) {
      settleInconclusive(ctx, admission, { pushBack: true });
      return false;
    }
    const lease = admission.kind === 'probe' ? admission.owner : null;
    const opened = store().recordFailure(ctx, verdict, lease, now);
    if (opened) {
      circuitLogger.warn(
        { provider: ctx.provider, chain: ctx.chain, failureClass: verdict.failureClass, status: verdict.status },
        'Provider circuit opened',
      );
    }
    deliverPendingNotice(ctx.key);
    return true; // One notice path owns every account incident.
  });
}

/**
 * The attempt proved nothing about the account (caller abort, a per-request
 * rejection). A probe lease is handed back; `pushBack` delays the next probe by
 * the current backoff when the provider was actually contacted and misbehaved.
 */
export function settleInconclusive(ctx: CircuitContext, admission: Admission, options: { pushBack: boolean }): void {
  if (admission.kind !== 'probe') return;
  guarded('release', undefined, () => {
    const row = store().read(ctx.key);
    const retryAt =
      options.pushBack && row
        ? providerCircuitClock.now() + circuitBackoffMs(row.failure_class, row.backoff_step)
        : null;
    store().releaseLease(ctx.key, admission.owner, retryAt);
  });
}
