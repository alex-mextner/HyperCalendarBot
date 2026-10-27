// Deterministic backstop (#498): a trusted final answer must not show an event's UTC clock time
// as local. Corrects both what the user receives and what history keeps, so the next turn does
// not copy the wrong times back.
import { logger } from '../../../utils/logger.ts';
import { correctUtcClockTimes, eventClocksForRun } from '../reply-time-guard.ts';
import type { TelegramStreamWriter } from '../telegram-stream.ts';
import type { AgentContext } from '../types.ts';
import type { MessageParam } from './message-sanitizer.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

/** Assistant prose held back for history gets the same correction as the reply; fixed in place. */
function correctPendingHistory(pendingHistory: MessageParam[], fix: (text: string) => string): void {
  pendingHistory.forEach((message, index) => {
    if (message.role !== 'assistant' || typeof message.content !== 'string') return;
    const fixed = fix(message.content);
    if (fixed !== message.content) pendingHistory[index] = { ...message, content: fixed };
  });
}

export function correctUtcClockTimesInReply(
  ctx: AgentContext,
  writer: TelegramStreamWriter,
  pendingHistory: MessageParam[],
): void {
  const events = eventClocksForRun(ctx);
  if (events.length === 0) return;
  const fix = (text: string) => correctUtcClockTimes(text, events, ctx.user.timezone);
  const draft = writer.getText();
  const corrected = fix(draft);
  if (corrected !== draft) {
    aiLogger.warn({ userId: ctx.user.telegram_id }, 'Reply showed UTC event times as local — corrected');
    writer.resetDraft();
    writer.appendText(corrected);
  }
  // Prose narrated in tool rounds is shown in the execution log; it gets the same correction.
  writer.rewriteReasoning(fix);
  correctPendingHistory(pendingHistory, fix);
}
