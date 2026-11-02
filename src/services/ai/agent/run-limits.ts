// Round and time budgets of one agent turn.

export const MAX_ROUNDS = 15;
export const TIMEOUT_MS = 90_000;
/**
 * How long past its request budget a run may still hold its chat (its failure notice, retry store and
 * history write come after the budget) before the run queued behind it stops waiting for it.
 */
export const CHAT_RUN_GRACE_MS = 30_000;
/**
 * How long a failed turn waits to learn whether its retry was stored before it answers anyway.
 * Kept inside the first shutdown drain below, so a hung store never makes that drain abandon the
 * turn. The late drain in index.ts is shorter: turns that start then meet queues already closed.
 */
export const RETRY_STORE_TIMEOUT_MS = 1_500;
/**
 * How long the shutdown drain gives in-flight turns to take their failure path: the
 * retry-store bound plus a second for the notice and the history write.
 */
export const AGENT_DRAIN_SETTLE_MS = RETRY_STORE_TIMEOUT_MS + 1_000;

/**
 * How long the response validator may take once it starts. The fast chain asks one provider for at
 * most 8 s (see round-budget.ts), so 16 s covers a failed first provider and a full second attempt.
 * The validator runs on its own clock, not on what is left of the request budget: on 2026-11-01 a
 * validator that started with 2.7 s of the request budget left was cut off by that budget and the
 * run's good answer was thrown away. The request deadline still decides whether it may start.
 */
export const VALIDATION_TIMEOUT_MS = 16_000;

/** True once the overall request budget is spent: no further provider round may start. */
export function requestBudgetSpent(startedAt: number, timeoutMs: number, now: number = Date.now()): boolean {
  return now - startedAt >= timeoutMs;
}

/**
 * What is left of the overall request budget. Never below 1 ms, so it can always seed an
 * `AbortSignal.timeout` that aborts promptly instead of receiving a zero or negative delay.
 */
export function remainingRequestMs(startedAt: number, timeoutMs: number, now: number = Date.now()): number {
  return Math.max(1, timeoutMs - (now - startedAt));
}
