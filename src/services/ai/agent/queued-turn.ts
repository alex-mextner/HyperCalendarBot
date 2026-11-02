// What a run does when its turn in the chat comes after another run's: it was built when its message
// arrived, so the snapshot it carries is older than the run it waited for, and its user row sits
// before everything that run wrote. This brings the snapshot up to date and reads the message after
// that output (same row, same id), before the model reads anything.
import { t, toLang } from '../../../config/constants.ts';
import type { EventOccurrence } from '../../../database/types.ts';
import { logger } from '../../../utils/logger.ts';
import type { ChatRunSlot } from '../chat-run-gate.ts';
import type { AgentContext, TelegramSender } from '../types.ts';

const queuedTurnLogger = logger.child({ module: 'ai-agent' });

const SCHEDULE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The Telegram ids that tell a redelivered update (same ids) from a second message (new ids), for log lines. */
export function turnIds(ctx: Pick<AgentContext, 'updateId' | 'incomingMessageId'>): {
  updateId?: number;
  messageId?: number;
} {
  return {
    ...(ctx.updateId !== undefined && { updateId: ctx.updateId }),
    ...(ctx.incomingMessageId !== undefined && { messageId: ctx.incomingMessageId }),
  };
}

const QUEUE_TYPING_INTERVAL_MS = 4_000;

/**
 * Keeps the chat's typing indicator alive while a message waits behind an earlier run, so the user sees
 * that it was received. Returns what stops it. A supplement is optional text and shows nothing.
 */
export function showTypingWhileQueued(ctx: AgentContext, sender: TelegramSender): () => void {
  if (ctx.supplementMode || !sender.sendChatAction) return () => {};
  const send = () => void sender.sendChatAction?.(ctx.chatId, 'typing').catch(() => {});
  send();
  const timer = setInterval(send, QUEUE_TYPING_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * The wait for the earlier run ended because it held the chat past its lease, not because it finished:
 * this run goes on beside it, and the user is told so instead of being left to guess (best effort).
 */
export async function announceExpiredQueueLease(
  ctx: AgentContext,
  slot: ChatRunSlot,
  sender: TelegramSender,
): Promise<void> {
  // The notice says the user's message is being handled: a run without a message of theirs (scheduled) has none.
  if (!slot.leaseExpired || ctx.supplementMode || slot.ownRowId === undefined) return;
  try {
    await sender.sendMessage(ctx.chatId, t(toLang(ctx.user.language)).agent_queue_lease_expired);
  } catch (err) {
    queuedTurnLogger.warn(
      { err, userId: ctx.user.telegram_id },
      'Could not tell the user their message left the queue',
    );
  }
}

/** Events two weeks either side of now: the nearby schedule the system prompt shows the model. */
export function scheduleWindowAround(
  eventService: AgentContext['eventService'],
  userId: number,
  now = new Date(),
): EventOccurrence[] {
  const start = new Date(now.getTime() - SCHEDULE_WINDOW_MS).toISOString();
  const end = new Date(now.getTime() + SCHEDULE_WINDOW_MS).toISOString();
  return eventService.getEventsInRange(userId, start, end);
}

/**
 * Sets up a run that has just been given its turn. Always: the turns queued behind it (reserved at the moment
 * they were saved, so a message whose handler is still busy elsewhere counts too) are kept out of its history,
 * and the message it answers is read after what earlier runs wrote (same row, same id). After a wait, or when
 * that placement found rows saved after the message (an earlier run finished just before this one reached the
 * gate, so it never waited): the user and the schedule window are read again (the earlier run may have changed
 * either). A step that fails leaves the run on what it had; this is a refinement, never a reason to fail the run.
 */
export function prepareQueuedTurn(ctx: AgentContext, slot: ChatRunSlot): void {
  ctx.deferredTurnRowIds = () => slot.queuedTurnRowIds();
  const userId = ctx.user.telegram_id;
  let placed = false;
  // Only a run's own message is placed: a scheduled or synthetic run borrows the user's latest row for the
  // action log, and a supplement answers a message the main run already placed.
  if (slot.ownRowId !== undefined && !ctx.supplementMode) {
    try {
      placed = ctx.chatHistory.placeUserTurnAfterLatest(slot.ownRowId, userId);
    } catch (err) {
      queuedTurnLogger.warn({ err, userId }, 'Could not place the message of a run behind the earlier turn');
    }
  }
  if (!slot.waited && !placed) return;
  try {
    ctx.user = ctx.userRepo.findByTelegramId(userId) ?? ctx.user;
    if (ctx.recentEventsWindow) ctx.recentEventsWindow = scheduleWindowAround(ctx.eventService, userId);
  } catch (err) {
    queuedTurnLogger.warn({ err, userId }, 'Could not refresh the context of a run that waited for its turn');
  }
}
