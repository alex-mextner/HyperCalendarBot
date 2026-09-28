// Drafts and exact administrator approval of revisions of the managed intent catalogue. The only
// writer of a managed registry besides the operator seed replacement: every approval re-checks the
// registry integrity, the exact draft id, body hash and base revision, revalidates the body and
// refuses while a live suspended workflow refers to an affected rule, then swaps rows, manifest and
// ledger in one IMMEDIATE transaction. Authority comes only from a principal minted here.
import type { Database } from 'bun:sqlite';
import {
  IntentRevisionRepository,
  type IntentRevisionRow,
  type NewRevision,
  type RevisionKind,
  type RevisionStatus,
} from '../../database/repositories/intent-revision.repository.ts';
import type { LiveSessionIntents } from '../../database/repositories/workflow-session.repository.ts';
import { dbLogger } from '../../utils/logger.ts';
import {
  type RevisionBody,
  RevisionBodyCodec,
  type RevisionBodyInput,
  RevisionBodySchema,
  type RevisionValidation,
  RevisionValidationCodec,
  revisionBodyHash,
} from './revision-body.ts';
import { type RegistryIntegrity, readApprovedRules, registryIntegrity, type StoredRule } from './revision-ledger.ts';
import { type RegistryView, type RevisionOutcome, validateRevision } from './revision-validator.ts';
import { digestsByName, RuleListCodec, seedFingerprint } from './rule-fingerprint.ts';
import type { CanonicalSeed } from './seed-replacement.ts';

export interface AdminPrincipal {
  readonly via: 'telegram' | 'operator_cli';
}
/** Principals minted by this module; a structurally identical object from anywhere else is refused. */
const minted = new WeakSet<AdminPrincipal>();
function mint(via: AdminPrincipal['via']): AdminPrincipal {
  const principal = Object.freeze({ via });
  minted.add(principal);
  return principal;
}
/** The configured bot administrator only; no configured administrator means nobody. */
export function adminFromTelegram(fromId: number, configuredAdminId: number | undefined): AdminPrincipal | null {
  if (configuredAdminId === undefined || !Number.isSafeInteger(configuredAdminId) || configuredAdminId <= 0)
    return null;
  return fromId === configuredAdminId ? mint('telegram') : null;
}
/** For operator scripts run on the server with direct database access. */
export function adminFromOperatorCli(): AdminPrincipal {
  return mint('operator_cli');
}
const decidedByOf = (principal: AdminPrincipal) => (principal.via === 'telegram' ? 'telegram:admin' : 'operator_cli');

export interface IntentRevision {
  id: number;
  kind: RevisionKind;
  status: RevisionStatus;
  parentId: number | null;
  baseRevisionId: number | null;
  targetFingerprint: string | null;
  bodyHash: string;
  body: RevisionBody | null;
  validation: RevisionValidation | null;
  author: string;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionReason: string | null;
}

type RefusalCode =
  | 'unauthorized'
  | 'unmanaged'
  | 'registry_tampered'
  | 'registry_unledgered'
  | 'not_found'
  | 'not_validated'
  | 'hash_mismatch'
  | 'conflict'
  | 'invalid'
  | 'session_active'
  | 'session_unreadable';
interface Refusal {
  status: 'refused';
  code: RefusalCode;
}
export type RevisionResult = { status: 'created'; revision: IntentRevision } | Refusal;
export type RejectResult = { status: 'rejected'; revision: IntentRevision } | Refusal;
export type ApproveResult =
  | { status: 'active'; revisionId: number; targetFingerprint: string; removed: string[]; inserted: string[] }
  | Refusal;
export type ProposalSource = { kind: 'manual'; principal: AdminPrincipal } | { kind: 'learned'; jobId: string };
export interface ApprovalRequest {
  id: number;
  bodyHash: string;
  baseRevisionId: number;
}
interface SessionSource {
  liveIntentIds(now: number): LiveSessionIntents;
}
interface DraftInput {
  body: RevisionBody;
  kind: RevisionKind;
  author: string;
  parentId: number | null;
}

const refused = (code: RefusalCode): Refusal => ({ status: 'refused', code });
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

function toRevision(row: IntentRevisionRow): IntentRevision {
  const body = RevisionBodyCodec.safeParse(row.body);
  const validation = RevisionValidationCodec.safeParse(row.validation);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    parentId: row.parent_id,
    baseRevisionId: row.base_revision_id,
    targetFingerprint: row.target_fingerprint,
    bodyHash: row.body_hash,
    body: body.success ? body.data : null,
    validation: validation.success ? validation.data : null,
    author: row.author,
    createdAt: row.created_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
  };
}

function integrityRefusal(state: Exclude<RegistryIntegrity['state'], 'intact'>): Refusal {
  if (state === 'unmanaged') return refused('unmanaged');
  dbLogger.error({ state }, `intent_registry_${state}: revision refused`);
  return refused(state === 'tampered' ? 'registry_tampered' : 'registry_unledgered');
}

function authorOf(source: ProposalSource): string | Refusal {
  if (source.kind === 'learned') return JOB_ID.test(source.jobId) ? `learner:${source.jobId}` : refused('invalid');
  return minted.has(source.principal) ? 'admin' : refused('unauthorized');
}

/** Manual and learned revisions are operation batches; a whole-catalogue body is source-only. */
function parseOperations(input: RevisionBodyInput): RevisionBody | null {
  const parsed = RevisionBodySchema.safeParse(input);
  return parsed.success && parsed.data.type === 'operations' ? parsed.data : null;
}

const isOpen = (row: IntentRevisionRow) => row.status === 'draft' || row.status === 'validated';

function approvalPrecondition(
  row: IntentRevisionRow | null,
  request: ApprovalRequest,
  active: IntentRevisionRow,
): RefusalCode | null {
  if (!row) return 'not_found';
  if (row.status !== 'validated') return 'not_validated';
  if (row.body_hash !== request.bodyHash) return 'hash_mismatch';
  const baseMatches = row.base_revision_id === active.id && row.base_fingerprint === active.target_fingerprint;
  return baseMatches && request.baseRevisionId === active.id ? null : 'conflict';
}

function storedOutcome(outcome: RevisionOutcome): RevisionValidation {
  if (!outcome.ok) return outcome;
  const { removed, inserted, dropped } = outcome;
  return dropped ? { ok: true, removed, inserted, dropped } : { ok: true, removed, inserted };
}

export class IntentRevisionService {
  private readonly revisions: IntentRevisionRepository;
  private readonly sessions: SessionSource;
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    deps: { sessions: SessionSource; now?: () => number },
  ) {
    this.revisions = new IntentRevisionRepository(db);
    this.sessions = deps.sessions;
    this.now = deps.now ?? Date.now;
  }

  activeRevisionId(): number | null {
    return this.revisions.active()?.id ?? null;
  }

  get(id: number): IntentRevision | null {
    const row = this.revisions.get(id);
    return row ? toRevision(row) : null;
  }

  list(status?: RevisionStatus): IntentRevision[] {
    return this.revisions.list(status).map(toRevision);
  }

  propose(input: RevisionBodyInput, source: ProposalSource): RevisionResult {
    const author = authorOf(source);
    if (typeof author !== 'string') return author;
    const body = parseOperations(input);
    if (!body) return refused('invalid');
    return this.db.transaction(() => this.insertDraft({ body, kind: source.kind, author, parentId: null })).immediate();
  }

  /** A new immutable draft replaces an open one; the predecessor becomes superseded. */
  revise(principal: AdminPrincipal, id: number, input: RevisionBodyInput): RevisionResult {
    if (!minted.has(principal)) return refused('unauthorized');
    const body = parseOperations(input);
    if (!body) return refused('invalid');
    return this.db
      .transaction((): RevisionResult => {
        const previous = this.revisions.get(id);
        if (!previous) return refused('not_found');
        if (!isOpen(previous) || previous.kind === 'source_baseline') return refused('not_validated');
        const created = this.insertDraft({ body, kind: previous.kind, author: 'admin', parentId: id });
        if (created.status === 'created') this.revisions.setStatus(id, 'superseded');
        return created;
      })
      .immediate();
  }

  reject(principal: AdminPrincipal, id: number, reason: string): RejectResult {
    if (!minted.has(principal)) return refused('unauthorized');
    if (!reason.trim() || reason.length > 2000) return refused('invalid');
    return this.db
      .transaction((): RejectResult => {
        const row = this.revisions.get(id);
        if (!row) return refused('not_found');
        if (!isOpen(row)) return refused('not_validated');
        this.revisions.setStatus(id, 'rejected', { by: decidedByOf(principal), at: this.now(), reason });
        return { status: 'rejected', revision: toRevision(this.requireRow(id)) };
      })
      .immediate();
  }

  /**
   * Records the build's source catalogue as a reviewable draft when it differs from the active
   * revision. Idempotent per body and base: a rejected source catalogue stays rejected until the
   * active revision moves. Only a draft that failed validation is retried, and it is superseded by
   * a new draft once the same body validates. It never approves or activates.
   */
  ensureSourceBaselineDraft(seed: readonly CanonicalSeed[]): IntentRevision | null {
    const fingerprint = seedFingerprint(seed);
    const parsed = RevisionBodySchema.safeParse({
      type: 'replace_all',
      summary: `Source catalogue ${fingerprint.slice(0, 16)}`,
      rules: seed,
    });
    if (!parsed.success) {
      dbLogger.error({ err: parsed.error }, 'source intent catalogue does not form a revision body');
      return null;
    }
    const body = parsed.data;
    return this.db
      .transaction((): IntentRevision | null => {
        const integrity = this.integrity();
        if (integrity.state !== 'intact') {
          if (integrity.state !== 'unmanaged') integrityRefusal(integrity.state);
          return null;
        }
        if (integrity.fingerprint === fingerprint) return null;
        const existing = this.revisions.findSourceBaseline(revisionBodyHash(body), integrity.active.id);
        // A draft that failed validation is retried: it may have failed on a history since repaired.
        if (existing && (existing.status !== 'draft' || !validateRevision(body, this.view(integrity.rules)).ok))
          return toRevision(existing);
        const author = `source:${fingerprint.slice(0, 16)}`;
        const created = this.insertValidated({ body, kind: 'source_baseline', author, parentId: null }, integrity);
        if (existing) this.revisions.setStatus(existing.id, 'superseded');
        return toRevision(created);
      })
      .immediate();
  }

  approve(principal: AdminPrincipal, request: ApprovalRequest): ApproveResult {
    if (!minted.has(principal)) return refused('unauthorized');
    return this.db.transaction(() => this.approveLocked(principal, request)).immediate();
  }

  private approveLocked(principal: AdminPrincipal, request: ApprovalRequest): ApproveResult {
    const integrity = this.integrity();
    if (integrity.state !== 'intact') return integrityRefusal(integrity.state);
    const row = this.revisions.get(request.id);
    const code = approvalPrecondition(row, request, integrity.active);
    if (code || !row) return refused(code ?? 'not_found');
    const outcome = this.revalidate(row, integrity.rules);
    if (!outcome.ok) return refused('invalid');
    const guard = this.sessionGuard(integrity.rules, outcome.removed);
    if (guard) return refused(guard);
    this.activate(row, outcome, integrity.active, integrity.rules, principal);
    const { targetFingerprint, removed, inserted } = outcome;
    return { status: 'active', revisionId: row.id, targetFingerprint, removed, inserted };
  }

  private integrity(): RegistryIntegrity {
    return registryIntegrity(this.revisions);
  }

  private requireRow(id: number): IntentRevisionRow {
    const row = this.revisions.get(id);
    if (!row) throw new Error(`Intent revision ${id} vanished inside its own transaction`);
    return row;
  }

  private insertDraft(draft: DraftInput): RevisionResult {
    const integrity = this.integrity();
    if (integrity.state !== 'intact') return integrityRefusal(integrity.state);
    return { status: 'created', revision: toRevision(this.insertValidated(draft, integrity)) };
  }

  private insertValidated(
    draft: DraftInput,
    integrity: Extract<RegistryIntegrity, { state: 'intact' }>,
  ): IntentRevisionRow {
    const outcome = validateRevision(draft.body, this.view(integrity.rules));
    const row: NewRevision = {
      kind: draft.kind,
      status: outcome.ok ? 'validated' : 'draft',
      parent_id: draft.parentId,
      base_revision_id: integrity.active.id,
      base_fingerprint: integrity.fingerprint,
      target_fingerprint: outcome.ok ? outcome.targetFingerprint : null,
      target_rules: outcome.ok ? JSON.stringify(outcome.targetRules) : null,
      body_hash: revisionBodyHash(draft.body),
      body: JSON.stringify(draft.body),
      validation: JSON.stringify(storedOutcome(outcome)),
      author: draft.author,
      created_at: this.now(),
    };
    return this.requireRow(this.revisions.insert(row));
  }

  private view(rules: StoredRule[]): RegistryView {
    return { rules, reservedNames: this.revisions.reservedNames(), provenance: this.provenance() };
  }

  /**
   * The kind of the activated revision that last changed each rule's definition. Each activation
   * is compared with the one before it, so a whole-catalogue revision claims only the rules it
   * added or changed, never the ones it carried over unchanged. Null (origins unknown) when any
   * activation's stored rules do not decode or match its target fingerprint, or when its base is
   * not the target of the activation before it (including a based activation with none before it).
   * Only a source baseline with no base at all (the first one, or an operator replacement recorded
   * after the active revision was lost) starts the history over. The history is checked for
   * consistency, not authenticated: a coherent rewrite of several rows is not detected.
   */
  private provenance(): Map<string, RevisionKind> | null {
    const kinds = new Map<string, RevisionKind>();
    let previous: { id: number; fingerprint: string | null; digests: Map<string, string> } | null = null;
    for (const row of this.revisions.decidedActivations()) {
      const target = RuleListCodec.safeParse(row.target_rules ?? '');
      const restarts = row.kind === 'source_baseline' && row.base_revision_id === null && row.base_fingerprint === null;
      const linked =
        restarts || (row.base_revision_id === previous?.id && row.base_fingerprint === previous.fingerprint);
      if (!target.success || seedFingerprint(target.data) !== row.target_fingerprint || !linked) {
        dbLogger.error({ revisionId: row.id }, 'intent revision history does not verify; rule origins unknown');
        return null;
      }
      const before = restarts || !previous ? new Map<string, string>() : previous.digests;
      const current = digestsByName(target.data);
      for (const [name, hash] of current) if (before.get(name) !== hash) kinds.set(name, row.kind);
      previous = { id: row.id, fingerprint: row.target_fingerprint, digests: current };
    }
    return kinds;
  }

  /** The stored body and target must still reproduce exactly what was validated and hashed. */
  private revalidate(row: IntentRevisionRow, rules: StoredRule[]): RevisionOutcome {
    const body = RevisionBodyCodec.safeParse(row.body);
    const stored = RuleListCodec.safeParse(row.target_rules ?? '');
    if (!body.success || !stored.success || revisionBodyHash(body.data) !== row.body_hash)
      return { ok: false, errors: ['Stored revision does not decode to its hash'] };
    const outcome = validateRevision(body.data, this.view(rules));
    if (!outcome.ok) return outcome;
    const matches =
      outcome.targetFingerprint === row.target_fingerprint && seedFingerprint(stored.data) === row.target_fingerprint;
    return matches ? outcome : { ok: false, errors: ['Revalidated target differs from the reviewed target'] };
  }

  /** A suspended workflow keeps its snapshot; its rule is not replaced underneath it while it is live. */
  private sessionGuard(rules: StoredRule[], removed: string[]): RefusalCode | null {
    const affected = new Set(rules.filter((rule) => removed.includes(rule.canonical_name)).map((rule) => rule.id));
    if (affected.size === 0) return null;
    const live = this.sessions.liveIntentIds(this.now());
    if (live.unreadable > 0) return 'session_unreadable';
    return [...live.intentIds].some((id) => affected.has(id)) ? 'session_active' : null;
  }

  private activate(
    row: IntentRevisionRow,
    outcome: Extract<RevisionOutcome, { ok: true }>,
    active: IntentRevisionRow,
    rules: StoredRule[],
    principal: AdminPrincipal,
  ): void {
    const removed = new Set(outcome.removed);
    const inserted = new Set(outcome.inserted);
    this.revisions.deleteIntents(rules.filter((rule) => removed.has(rule.canonical_name)).map((rule) => rule.id));
    for (const rule of outcome.targetRules)
      if (inserted.has(rule.canonical_name)) this.revisions.insertApprovedIntent(rule);
    const after = readApprovedRules(this.revisions);
    if (!after || seedFingerprint(after) !== outcome.targetFingerprint)
      throw new Error('Activated intent catalogue does not match the approved target');
    this.revisions.writeManifest(outcome.targetFingerprint, after.length);
    this.revisions.setStatus(active.id, 'superseded');
    this.revisions.setStatus(row.id, 'active', { by: decidedByOf(principal), at: this.now() });
  }
}
