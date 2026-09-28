// src/bot/middleware/chat-logging.ts
// Saves every conversation turn to chat_history — user text, commands, edits, button presses and the
// bot's own send/editText replies — and records commands and button presses in the action log.
// Text or edits the connect-wizard guard recognised as Telegram-connect wizard input (phone, login
// code, 2FA password) are not stored here: the guard already stored their redaction marker.

import type { Next, TelegramUpdate } from 'gramio';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { User } from '../../database/types.ts';
import type { ConversationLogger } from '../../services/conversation-logger.ts';
import { resolveCallbackButtonLabel } from '../callback-label.ts';
import { parseAiBtnPayload } from '../handlers/callback.handler.ts';
import type { ConnectWizardGuard } from './connect-wizard-guard.ts';

type ReplyFn = (text: string, opts?: { [key: string]: unknown }) => Promise<unknown>;

/**
 * The part of a GramIO context this middleware reads. `send`/`editText` exist only on
 * specific update contexts at runtime, so they are optional here and wrapped when present.
 */
interface ChatLoggingContext {
  dbUser?: User;
  update?: TelegramUpdate;
  send?: ReplyFn;
  editText?: ReplyFn;
}

export interface ChatLoggingDeps {
  conversationLogger: ConversationLogger;
  actionLog: Pick<ActionLogRepository, 'insert'>;
  /** Latest user chat_history row per user, read by the AI pipeline for the current turn. */
  chatHistoryIds: Map<number, number>;
  /** Whether the connect-wizard guard, reached before this middleware, already stored this update's text or edit. */
  isConnectWizardInput: ConnectWizardGuard['isConnectWizardInput'];
}

export function createChatLogging(deps: ChatLoggingDeps) {
  const { conversationLogger, actionLog, chatHistoryIds, isConnectWizardInput } = deps;
  return async (context: ChatLoggingContext, next: Next) => {
    const user = context.dbUser;
    if (!user) return next();

    const chatId = context.update?.message?.chat?.id ?? context.update?.callback_query?.message?.chat?.id;
    const isPrivate = !chatId || chatId === user.telegram_id;
    const logChatId = isPrivate ? undefined : chatId;

    // Incoming text message (regular or command)
    const incomingText = context.update?.message?.text;
    const incomingMsgId = context.update?.message?.message_id;
    const editedMessage = context.update?.edited_message;
    // A phone number, login code or 2FA password — the guard stored its marker. Slash text is not
    // logged as a command either: a password may start with '/'.
    const recordedByGuard = isConnectWizardInput(context);
    if (incomingText && !recordedByGuard) {
      if (incomingText.match(/^\/cal(\s|$)/)) {
        // /cal is an AI command — save args as plain user message, not a command event.
        // In groups, bare /cal means "look at the recent context above"; save the literal
        // "/cal" so the agent has a new user turn to respond to. In DMs, bare /cal just
        // prints usage help, so there's nothing to save.
        const calArgs = incomingText.replace(/^\/cal\s*/, '').trim();
        const savedText = calArgs || (logChatId ? '/cal' : '');
        if (savedText) {
          chatHistoryIds.set(
            user.telegram_id,
            conversationLogger.logUserMessage(user.telegram_id, savedText, logChatId),
          );
        }
      } else if (incomingText.startsWith('/')) {
        const spaceIdx = incomingText.indexOf(' ');
        const cmdName = spaceIdx >= 0 ? incomingText.slice(0, spaceIdx) : incomingText;
        const cmdArgs = spaceIdx >= 0 ? incomingText.slice(spaceIdx + 1).trim() : undefined;
        conversationLogger.logCommand(user.telegram_id, cmdName, cmdArgs || undefined, logChatId);
        // Log command to action log
        actionLog.insert({
          user_id: user.telegram_id,
          chat_id: chatId ?? user.telegram_id,
          action_type: 'command',
          action_name: cmdName,
          message_id: incomingMsgId,
          input_summary: cmdArgs,
        });
      } else {
        chatHistoryIds.set(
          user.telegram_id,
          conversationLogger.logUserMessage(user.telegram_id, incomingText, logChatId),
        );
      }
    }

    // Edited message
    const editedText = editedMessage?.text;
    if (editedText && !recordedByGuard) {
      conversationLogger.logEditedMessage(user.telegram_id, editedText, logChatId);
    }

    // Callback query (button press or ai_btn answer) — universal, no per-handler logging needed
    const callbackData = context.update?.callback_query?.data;
    if (callbackData) {
      const firstColon = callbackData.indexOf(':');
      const action = firstColon >= 0 ? callbackData.slice(0, firstColon) : callbackData;
      const payload = firstColon >= 0 ? callbackData.slice(firstColon + 1) : '';

      if (action === 'ai_btn') {
        const callbackChatType = context.update?.callback_query?.message?.chat?.type;
        const isGroupCallback = callbackChatType === 'group' || callbackChatType === 'supergroup';
        const { answerText } = parseAiBtnPayload(payload, isGroupCallback);
        chatHistoryIds.set(
          user.telegram_id,
          conversationLogger.logUserMessage(user.telegram_id, answerText, logChatId),
        );
      } else {
        const callbackMessage = context.update?.callback_query?.message;
        const replyMarkup =
          callbackMessage && 'reply_markup' in callbackMessage ? callbackMessage.reply_markup : undefined;
        const buttonLabel = resolveCallbackButtonLabel(replyMarkup, callbackData, action);
        conversationLogger.logButtonPress(user.telegram_id, buttonLabel, payload || undefined, logChatId);
        // Log callback to action log
        const cbMsgId = context.update?.callback_query?.message?.message_id;
        actionLog.insert({
          user_id: user.telegram_id,
          chat_id: chatId ?? user.telegram_id,
          action_type: 'callback',
          action_name: action,
          message_id: cbMsgId,
          input_summary: payload || undefined,
        });
      }
    }

    // Wrap send and editText — logs every bot response (intent matcher, scenes, commands, callbacks)
    // Note: AI agent uses TelegramSender.sendMessage() directly; those are logged via logAiTurn
    const originalSend = context.send?.bind(context);
    if (originalSend) {
      context.send = async (text, opts) => {
        const result = await originalSend(text, opts);
        conversationLogger.logBotResponse(user.telegram_id, text, logChatId);
        return result;
      };
    }

    const originalEditText = context.editText?.bind(context);
    if (originalEditText) {
      context.editText = async (text, opts) => {
        const result = await originalEditText(text, opts);
        conversationLogger.logBotEdit(user.telegram_id, text, logChatId);
        return result;
      };
    }

    return next();
  };
}
