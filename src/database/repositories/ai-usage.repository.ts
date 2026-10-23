import type { Database } from 'bun:sqlite';

export type AiUsageOutcome = 'ok' | 'error' | 'skipped';

/** What went wrong with an attempt, derived from the SDK error; never the provider's error body. */
export type AiErrorClass =
  | 'timeout'
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'server'
  | 'empty'
  | 'aborted'
  | 'bad_request'
  | 'other';

/**
 * Why a provider was passed over without a request being sent. `local_budget` (Gemini's local quota
 * admission, removed in #806) and `preflight_size` (the Groq token-fit preflight, removed with Groq as
 * a chat provider) are retired and never written any more; they stay so that historical rows keep
 * their type.
 */
export type AiSkipReason = 'preflight_size' | 'circuit_open' | 'eligibility_bench' | 'local_budget' | 'round_deadline';

/**
 * One provider attempt of an AI round. Token fields are null when the provider reported no
 * usage; null is unknown, never zero. Nothing here identifies a user, a chat or a conversation.
 */
export interface AiUsageEvent {
  /** Epoch milliseconds (UTC) at which the attempt started. */
  at: number;
  provider: string;
  model: string;
  chain: string;
  purpose: string;
  outcome: AiUsageOutcome;
  errorClass: AiErrorClass | null;
  httpStatus: number | null;
  skipReason: AiSkipReason | null;
  /** Wall time the round spent on this provider; null when no request was sent. */
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  /** Opaque per-agent-run correlation id. */
  requestId: string | null;
  /** Routing role (`planner`, `executor`, `repair`) of a role-routed attempt; null on a legacy chain. */
  role: string | null;
  /** Model preset id the slot ran; null when none. */
  preset: string | null;
  /**
   * Cost of the attempt in micro-USD (1e-6 USD): the cost the provider reported, else the dated list
   * price of the route. null is unknown, never zero.
   */
  costMicroUsd: number | null;
}

export interface AiUsageRow extends AiUsageEvent {
  id: number;
}

interface AiUsageRecord {
  id: number;
  at: number;
  provider: string;
  model: string;
  chain: string;
  purpose: string;
  outcome: AiUsageOutcome;
  error_class: AiErrorClass | null;
  http_status: number | null;
  skip_reason: AiSkipReason | null;
  duration_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  request_id: string | null;
  role: string | null;
  preset: string | null;
  cost_micro_usd: number | null;
}

const READ_BATCH_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows older than this are pruned; it is also the longest window a report can cover. */
export const AI_USAGE_RETENTION_DAYS = 180;

export class AiUsageRepository {
  constructor(private db: Database) {}

  /** Appends the whole batch in one transaction: either every row lands or none does. */
  insertMany(events: readonly AiUsageEvent[]): void {
    if (events.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO ai_usage_events
         (at, provider, model, chain, purpose, outcome, error_class, http_status, skip_reason, duration_ms,
          prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, request_id,
          role, preset, cost_micro_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const e of events) {
        insert.run(
          e.at,
          e.provider,
          e.model,
          e.chain,
          e.purpose,
          e.outcome,
          e.errorClass,
          e.httpStatus,
          e.skipReason,
          e.durationMs,
          e.promptTokens,
          e.completionTokens,
          e.reasoningTokens,
          e.cachedTokens,
          e.requestId,
          e.role,
          e.preset,
          e.costMicroUsd,
        );
      }
    })();
  }

  /** Rows with `at >= sinceMs`, oldest id first, read in bounded batches. */
  *iterateSince(sinceMs: number, batchSize = READ_BATCH_SIZE): Generator<AiUsageRow> {
    const page = this.db.prepare<AiUsageRecord, [number, number, number]>(
      `SELECT id, at, provider, model, chain, purpose, outcome, error_class, http_status, skip_reason, duration_ms,
              prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, request_id,
              role, preset, cost_micro_usd
       FROM ai_usage_events WHERE at >= ? AND id > ? ORDER BY id LIMIT ?`,
    );
    let afterId = 0;
    for (;;) {
      const rows = page.all(sinceMs, afterId, batchSize);
      for (const row of rows) {
        yield {
          id: row.id,
          at: row.at,
          provider: row.provider,
          model: row.model,
          chain: row.chain,
          purpose: row.purpose,
          outcome: row.outcome,
          errorClass: row.error_class,
          httpStatus: row.http_status,
          skipReason: row.skip_reason,
          durationMs: row.duration_ms,
          promptTokens: row.prompt_tokens,
          completionTokens: row.completion_tokens,
          reasoningTokens: row.reasoning_tokens,
          cachedTokens: row.cached_tokens,
          requestId: row.request_id,
          role: row.role,
          preset: row.preset,
          costMicroUsd: row.cost_micro_usd,
        };
        afterId = row.id;
      }
      if (rows.length < batchSize) return;
    }
  }

  /** Removes rows older than the retention horizon as of `nowMs`; returns how many. */
  pruneExpired(nowMs: number): number {
    const cutoffMs = nowMs - AI_USAGE_RETENTION_DAYS * DAY_MS;
    return Number(this.db.prepare('DELETE FROM ai_usage_events WHERE at < ?').run(cutoffMs).changes);
  }
}
