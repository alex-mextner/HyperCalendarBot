// Round and time budgets of one agent turn.

export const MAX_ROUNDS = 15;
export const TIMEOUT_MS = 90_000;
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
