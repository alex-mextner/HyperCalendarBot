// Tells the user what happened when an agent run failed, and keeps that line in chat history.
import { t, toLang } from '../../../config/constants.ts';
import { logger } from '../../../utils/logger.ts';
import { ProviderSafetyStopError } from '../streaming.ts';
import type { TelegramStreamWriter } from '../telegram-stream.ts';
import type { AgentContext } from '../types.ts';
import { aiFailureNotices, isHardOutage } from './failure-notices.ts';
import type { RetryOutcome } from './retry-store.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

export interface FailureAnnouncement {
  ctx: AgentContext;
  error: unknown;
  writer: Pick<TelegramStreamWriter, 'appendText'>;
  /** What became of the failed turn's backoff retry. */
  retry: RetryOutcome;
  /** The process is shutting down: the run was cut short by that, not by the AI. */
  shuttingDown: boolean;
  /** Saves a plain assistant line to chat history so the model can see it and play along. */
  saveTurn: (text: string) => void;
}

function tell(announcement: FailureAnnouncement, text: string, separator: string): void {
  announcement.writer.appendText(`${separator}${text}`);
  announcement.saveTurn(text);
}

function announceShutdown(announcement: FailureAnnouncement): void {
  const { ctx, retry } = announcement;
  // The pipeline's give-up line already closed this retry chain; a restart notice would contradict it.
  if (retry === 'gave_up') return;
  // Promise a comeback only when a retry job was actually stored; when that is unknown, neither
  // promise one nor ask for a resend that could run the request twice.
  const text =
    retry === 'unknown'
      ? t(ctx.user.language).agent_restarting_unconfirmed
      : t(ctx.user.language).agent_restarting(retry === 'stored');
  tell(announcement, text, '\n\n');
}

function announceOutage(announcement: FailureAnnouncement): void {
  const { ctx, error, retry } = announcement;
  const hardOutage = isHardOutage(error);
  const isRetryAttempt = (ctx.retryAttempt ?? 0) > 0;
  if (isRetryAttempt && !hardOutage) return;
  // The give-up line was delivered and closed the chain; another notice would repeat it.
  // A give-up that failed to send rejects instead, so the notice below still goes out.
  if (retry === 'gave_up') return;

  const notice = aiFailureNotices.decide(ctx.user.telegram_id, toLang(ctx.user.language), {
    hardOutage,
    // A stall phrase promises a comeback: only a stored retry can keep it.
    willRetry: retry === 'stored',
    isRetryAttempt,
    unprompted: ctx.unprompted,
    retryUnconfirmed: retry === 'unknown',
  });
  aiLogger.info({ userId: ctx.user.telegram_id, notice: notice.kind, hardOutage }, 'AI failure notice');
  if (notice.kind === 'silent') return;
  tell(announcement, notice.text, '\n\n');
}

/**
 * Tell the user what happened when a run failed.
 *
 * Mid-chain retries stay quiet: the comeback was already promised on the first
 * failure and repeating it every 30 seconds only adds noise. A run cut short by
 * a shutdown says exactly that. Everything else goes through the notice
 * tracker, which decides between a playful stall, an honest "the AI is down,
 * here is what still works", and a one-line "still down, not done" for a new
 * request right after the honest notice.
 */
export function announceFailure(announcement: FailureAnnouncement): void {
  const { ctx, error } = announcement;
  if (ctx.supplementMode || ctx.wasExplicitInvocation === false) return;

  if (error instanceof ProviderSafetyStopError) {
    tell(announcement, t(ctx.user.language).ai_response_blocked, '');
    return;
  }
  // Before the quiet-retry rule: a retry cut short by a restart is also told so.
  if (announcement.shuttingDown) {
    announceShutdown(announcement);
    return;
  }
  announceOutage(announcement);
}
