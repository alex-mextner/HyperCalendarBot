// What the bot tells a user after a failed AI run, and how it remembers having said it.
import OpenAI from 'openai';
import { type Lang, t } from '../../../config/constants.ts';
import { isBalanceExhausted } from '../../../utils/ai-provider-alert.ts';
import { AllProvidersFailedError } from '../streaming.ts';

/**
 * One apology covers a user for this long. A user who keeps writing during an
 * outage gets at most one playful "one sec", then one honest "the AI is down,
 * here is what still works", then a one-line "still down" per new request —
 * not five apologies and command lists in a row.
 */
const NOTICE_COOLDOWN_MS = 5 * 60_000;

/** Records older than this are dropped so the map cannot grow without bound. */
const NOTICE_RETENTION_MS = 60 * 60_000;

/**
 * Hard cap on tracked users. The age-based prune alone is not enough: a burst of
 * failures across many distinct users inside one retention window would grow the
 * map unchecked. Past the cap the least recently notified users are evicted —
 * they simply lose the "don't repeat the same apology" memory.
 */
const MAX_TRACKED_USERS = 10_000;

/**
 * What the bot says to the user when a run fails.
 *  - `stall`      — a playful "one sec, be right back". Only legitimate when a
 *                   retry is actually scheduled, because it promises a comeback.
 *  - `honest`     — the AI is unavailable, here are the commands that still work.
 *                   No promise, so nothing to break.
 *  - `still_down` — a new request failed right after `honest`: one line saying it
 *                   is not done, without repeating the joke or the command list.
 *                   When a retry is stored and can succeed (not a hard outage)
 *                   it says the bot will retry by itself, since a resend would
 *                   cancel that retry; when the store did not answer in time it
 *                   asks for a resend only if no answer comes; otherwise it asks
 *                   for a resend later.
 *  - `silent`     — a scheduled retry or an unprompted scheduled/trigger run
 *                   failed after the user was already told.
 */
export type FailureNoticeKind = 'stall' | 'honest' | 'still_down' | 'silent';

export interface FailureNotice {
  kind: FailureNoticeKind;
  /** Empty for `silent`. */
  text: string;
}

interface NoticeRecord {
  kind: 'stall' | 'honest';
  text: string;
  sentAt: number;
  /** A later `still_down` promised a retry, so the give-up must close that loop. */
  owesComeback: boolean;
}

export interface FailureNoticeOptions {
  /** The provider chain is down for a known, non-transient reason. */
  hardOutage: boolean;
  /** A backoff retry will actually be scheduled — without it a promise is a lie. */
  willRetry: boolean;
  /** This run is a scheduled retry, not a message the user just sent. */
  isRetryAttempt: boolean;
  /** A scheduled/trigger run: the user sent no request, so there is none to report on or resend. */
  unprompted?: boolean;
  /** The retry store did not answer in time: a job may exist, so neither promise nor demand a resend. */
  retryUnconfirmed?: boolean;
  now?: number;
}

/** What a `still_down` line tells the user to expect: our retry, an answer to wait for, or a resend. */
function stillDownNext(canPromiseComeback: boolean, opts: FailureNoticeOptions): 'retry' | 'unsure' | 'resend' {
  if (canPromiseComeback) return 'retry';
  return opts.retryUnconfirmed && !opts.hardOutage ? 'unsure' : 'resend';
}

/**
 * Per-user memory of what the bot last said about an AI failure.
 *
 * Lives at module scope (rather than on the agent instance) because the pieces
 * that need it run in different places: the agent produces the notice, and the
 * retry layers — bot pipeline and BullMQ worker — need to know afterwards
 * whether a comeback was promised, so the give-up message can close that loop
 * instead of arriving out of nowhere. State is in-memory only; after a restart
 * the give-up simply does not reference a promise it can no longer verify.
 */
class AiFailureNoticeTracker {
  private byUser = new Map<number, NoticeRecord>();

  /** Decide what to tell the user about this failure, and remember it. */
  decide(userId: number, lang: Lang, opts: FailureNoticeOptions): FailureNotice {
    const now = opts.now ?? Date.now();
    this.prune(now);
    const previous = this.byUser.get(userId);
    const withinCooldown = previous !== undefined && now - previous.sentAt < NOTICE_COOLDOWN_MS;

    // Same rule as for the stall: a comeback is promised only when a retry is
    // scheduled and can actually succeed. Retries of a hard outage are futile.
    const canPromiseComeback = opts.willRetry && !opts.hardOutage;

    if (withinCooldown && previous.kind === 'honest') {
      return this.stillDown(userId, lang, previous, canPromiseComeback, opts);
    }
    // Tell the truth instead of promising a comeback when a retry cannot deliver
    // one, or when a comeback promised within the cooldown is still undelivered —
    // repeating that promise is what makes the bot look like a broken record.
    if (!canPromiseComeback || withinCooldown) {
      return this.record(userId, 'honest', t(lang).ai_degraded, now);
    }
    return this.record(userId, 'stall', t(lang).agent_error(previous?.text), now);
  }

  /**
   * A new failure inside the cooldown of an `honest` notice: silent for runs the user did not just
   * send, otherwise one short line. The honest notice stays the one on file, so the cooldown keeps
   * anchoring on it; only the owed comeback is noted.
   */
  private stillDown(
    userId: number,
    lang: Lang,
    previous: NoticeRecord,
    canPromiseComeback: boolean,
    opts: FailureNoticeOptions,
  ): FailureNotice {
    if (opts.isRetryAttempt || opts.unprompted) return { kind: 'silent', text: '' };
    // Every request the user sends deserves a visible outcome, but the full
    // notice went out moments ago.
    if (canPromiseComeback) previous.owesComeback = true;
    this.store(userId, previous);
    return { kind: 'still_down', text: t(lang).ai_still_down(stillDownNext(canPromiseComeback, opts)) };
  }

  private record(userId: number, kind: 'stall' | 'honest', text: string, now: number): FailureNotice {
    this.store(userId, { kind, text, sentAt: now, owesComeback: false });
    return { kind, text };
  }

  private store(userId: number, record: NoticeRecord): void {
    // Delete before set so Map iteration order tracks recency, not first sight:
    // an active user must not be the first evicted past the cap.
    this.byUser.delete(userId);
    this.byUser.set(userId, record);
    this.evictOverflow();
  }

  /**
   * Read and clear the outstanding notice for a user. Returns `stall` when the
   * bot promised a comeback it still owes (the "one sec" or a short "I'll retry
   * it myself"), `honest` when it only admitted the outage, `null` when it said
   * nothing (or the process restarted).
   */
  takeNotice(userId: number): 'stall' | 'honest' | null {
    const record = this.byUser.get(userId);
    if (!record) return null;
    this.byUser.delete(userId);
    return record.owesComeback ? 'stall' : record.kind;
  }

  /** The bot answered — any outstanding promise is settled. */
  clear(userId: number): void {
    this.byUser.delete(userId);
  }

  /** Test hook: drop all remembered notices. */
  reset(): void {
    this.byUser.clear();
  }

  private evictOverflow(): void {
    while (this.byUser.size > MAX_TRACKED_USERS) {
      const oldest = this.byUser.keys().next();
      if (oldest.done) return;
      this.byUser.delete(oldest.value);
    }
  }

  /** Test hook: how many users are currently remembered. */
  size(): number {
    return this.byUser.size;
  }

  private prune(now: number): void {
    for (const [userId, record] of this.byUser) {
      if (now - record.sentAt > NOTICE_RETENTION_MS) this.byUser.delete(userId);
    }
  }
}

export const aiFailureNotices = new AiFailureNoticeTracker();

/**
 * The closing message once the retry budget is spent. When a comeback was
 * promised — the "one sec" stall, or a short "I'll retry it myself" line — it
 * references that promise so the two messages read as one conversation.
 * Returns null when the user was only told the AI is down: a second notice
 * would be noise.
 */
export function agentGiveUpMessage(userId: number, lang: Lang): string | null {
  const notice = aiFailureNotices.takeNotice(userId);
  if (notice === 'honest') return null;
  return t(lang).agent_give_up(notice === 'stall');
}

/**
 * A failure the retry budget cannot fix: exhausted balance/quota, or dead
 * credentials. Promising a comeback for these is a lie — the retries will fail
 * exactly the same way three minutes later.
 */
export function isHardOutage(error: unknown): boolean {
  // The chain reports a total outage as one aggregate rather than rethrowing the
  // last provider's error, so inspect the per-provider verdicts. If not one slot
  // looked merely down, a retry three minutes later hits the same wall.
  if (error instanceof AllProvidersFailedError) {
    return error.failures.every((failure) => !failure.transient);
  }
  if (isBalanceExhausted(error)) return true;
  return error instanceof OpenAI.APIError && (error.status === 401 || error.status === 403);
}
