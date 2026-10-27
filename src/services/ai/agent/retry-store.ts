// Stores a failed turn's backoff retry without letting a hung store hold back the user's notice.
import { logger } from '../../../utils/logger.ts';
import { ProviderSafetyStopError } from '../streaming.ts';
import type { AgentContext } from '../types.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

/**
 * What became of a failed turn's retry: stored, declined with the pipeline's give-up line,
 * not stored, or unknown because the store did not answer in time (the job may still land).
 */
export type RetryOutcome = 'stored' | 'gave_up' | 'not_stored' | 'unknown';

/**
 * Asks the retry store to schedule the original message and reports what became of it.
 * Awaited so a shutdown drain does not close the queue under the write, but bounded:
 * a hung retry store must never hold back the user's failure notice. A timeout is `unknown`,
 * not `not_stored`, because the job may still land.
 */
export async function storeRetryWithin(
  enqueue: (messageText: string) => Promise<boolean>,
  messageText: string,
  userId: number,
  timeoutMs: number,
): Promise<RetryOutcome> {
  const stored = enqueue(messageText).then(
    (scheduled): RetryOutcome => (scheduled ? 'stored' : 'gave_up'),
    (err: unknown): RetryOutcome => {
      aiLogger.warn({ err, userId }, 'Failed to handle retry enqueue');
      return 'not_stored';
    },
  );
  const storeDeadline = Promise.withResolvers<'timeout'>();
  const storeTimer = setTimeout(() => storeDeadline.resolve('timeout'), timeoutMs);
  const outcome = await Promise.race([stored, storeDeadline.promise]);
  clearTimeout(storeTimer);
  if (outcome === 'timeout') {
    aiLogger.warn({ userId }, 'Retry store did not answer in time — not promising a comeback, not asking for a resend');
    return 'unknown';
  }
  return outcome;
}

/** What decides whether a failed turn may be replayed from its original message. */
export interface RetryEligibility {
  /** A validation retry already ran: explanation repair must not replay the original request. */
  responseUnverified: boolean;
  /** A write may already have landed, or its outcome is unknown: it must never be replayed. */
  mayHaveMutated: boolean;
}

/**
 * Whether a failed turn may be handed to the backoff retry. Explanation repair must not replay
 * the original request, even if the repair provider fails before a mutation. Ordinary
 * execution retries stay unchanged.
 */
export function mayStoreRetry(ctx: AgentContext, error: unknown, state: RetryEligibility): boolean {
  return (
    !state.responseUnverified &&
    !(error instanceof ProviderSafetyStopError) &&
    !state.mayHaveMutated &&
    ctx.retryEnqueue !== undefined &&
    !ctx.supplementMode &&
    ctx.wasExplicitInvocation !== false
  );
}

/** Stores the retry of a failed turn when it is allowed to have one; `not_stored` otherwise. */
export async function storeRetryAfterFailure(
  ctx: AgentContext,
  error: unknown,
  state: RetryEligibility,
  timeoutMs: number,
): Promise<RetryOutcome> {
  if (!ctx.retryEnqueue || !mayStoreRetry(ctx, error, state)) return 'not_stored';
  return storeRetryWithin(ctx.retryEnqueue, ctx.messageText, ctx.user.telegram_id, timeoutMs);
}
