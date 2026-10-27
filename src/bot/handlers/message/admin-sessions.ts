// src/bot/handlers/message/admin-sessions.ts
// Bot-admin interception: a feedback reply forwarded to the user, or an intent edit instruction.

import { t } from '../../../config/constants.ts';
import type { User } from '../../../database/types.ts';
import { formatAdminReply, sendAdminReplyToUser } from '../../../services/feedback/admin-messenger.ts';
import { isSessionExpired } from '../../../services/intent/admin-edit-session.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import type { BotCommandContext } from '../../types.ts';
import { handleIntentEditInstruction } from './intent-edit.ts';
import type { MessageHandlerDeps } from './types.ts';

interface AdminReplyTarget {
  threadId: number;
  userId: number;
  chatId?: number;
  topicThreadId?: number;
}

type AdminReplyDeps = MessageHandlerDeps & {
  adminReplySession: NonNullable<MessageHandlerDeps['adminReplySession']>;
  feedbackRepo: NonNullable<MessageHandlerDeps['feedbackRepo']>;
  sendMessageToUser: NonNullable<MessageHandlerDeps['sendMessageToUser']>;
};

interface AdminReplyLabels {
  adminReplyFailed: string;
  adminReplyDeliveredToGroup: string;
}

/** Delivery fell back from the user's DM: try the group chat the feedback came from. */
async function deliverReplyToOriginGroup(
  ctx: BotCommandContext,
  session: AdminReplyTarget,
  buildReplyText: () => string,
  msgs: AdminReplyLabels,
  deps: MessageHandlerDeps,
): Promise<void> {
  const { chatId } = session;
  const sendToChat = deps.sendMessageToChat;
  if (!chatId || chatId === session.userId || !sendToChat) {
    await ctx.send(msgs.adminReplyFailed);
    return;
  }
  try {
    await sendToChat(chatId, buildReplyText(), { message_thread_id: session.topicThreadId });
    await ctx.send(msgs.adminReplyDeliveredToGroup);
  } catch (groupErr) {
    cmdLogger.error({ err: groupErr, chatId }, 'Group fallback delivery also failed');
    await ctx.send(msgs.adminReplyFailed);
  }
}

async function forwardAdminReply(
  ctx: BotCommandContext,
  user: User,
  session: AdminReplyTarget,
  messageText: string,
  deps: AdminReplyDeps,
): Promise<void> {
  const thread = deps.feedbackRepo.getThread(session.threadId);
  if (!thread) return;
  deps.feedbackRepo.addMessage({ thread_id: session.threadId, sender: 'admin', text: messageText });
  const msgs = t(user.language).callbackErrors;
  const recipientLang = deps.userRepo.findByTelegramId(session.userId)?.language ?? 'ru';
  try {
    await sendAdminReplyToUser(deps.sendMessageToUser, session.userId, messageText, thread.subject, recipientLang);
    await ctx.send(msgs.adminReplySent);
  } catch (directErr) {
    cmdLogger.warn(
      { err: directErr, userId: session.userId, threadId: session.threadId },
      'Direct delivery to user failed, trying group fallback',
    );
    // Fall back to the group chat where the feedback originated
    await deliverReplyToOriginGroup(
      ctx,
      session,
      () => formatAdminReply(messageText, thread.subject, recipientLang),
      msgs,
      deps,
    );
  }
}

function hasAdminReplyDeps(deps: MessageHandlerDeps): deps is AdminReplyDeps {
  return !!(deps.adminReplySession && deps.feedbackRepo && deps.sendMessageToUser);
}

/** Admin reply session: if the admin has an active reply session, forward the message to the user. */
async function tryHandleAdminReply(
  ctx: BotCommandContext,
  user: User,
  messageText: string,
  deps: MessageHandlerDeps,
): Promise<boolean> {
  if (!deps.botAdminId || user.telegram_id !== deps.botAdminId || !hasAdminReplyDeps(deps)) return false;
  const session = deps.adminReplySession.get(user.telegram_id);
  if (!session) return false;
  deps.adminReplySession.delete(user.telegram_id);
  await forwardAdminReply(ctx, user, session, messageText, deps);
  return true;
}

/** Admin intent edit session: if admin has an active edit session, process as edit instruction. */
async function tryHandleAdminEditSession(
  ctx: BotCommandContext,
  user: User,
  messageText: string,
  deps: MessageHandlerDeps,
): Promise<boolean> {
  if (!deps.botAdminId || user.telegram_id !== deps.botAdminId || !deps.adminEditSessions) return false;
  const editSession = deps.adminEditSessions.get(user.telegram_id);
  if (!editSession) return false;
  deps.adminEditSessions.delete(user.telegram_id);
  if (isSessionExpired(editSession)) {
    await ctx.send('Edit session expired. Please click Edit again.');
    return true;
  }
  await handleIntentEditInstruction(ctx, messageText, editSession, deps);
  return true;
}

/** Admin-only interceptions, in priority order. True when the message was consumed. */
export async function tryHandleAdminSessions(
  ctx: BotCommandContext,
  user: User,
  messageText: string,
  deps: MessageHandlerDeps,
): Promise<boolean> {
  return (
    (await tryHandleAdminReply(ctx, user, messageText, deps)) ||
    (await tryHandleAdminEditSession(ctx, user, messageText, deps))
  );
}
