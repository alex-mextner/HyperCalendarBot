// src/bot/middleware/chat-logging.ts
// Saves every conversation turn to chat_history — user text, commands, edits, button presses and the
// bot's own send/editText replies — and records commands and button presses in the action log.
// Text the connect-wizard guard took for Telegram-connect wizard input (phone, login code, 2FA
// password) is stored only as a redaction marker.

import type { Next, TelegramUpdate } from 'gramio';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { User } from '../../database/types.ts';
import type { ConversationLogger } from '../../services/conversation-logger.ts';
import { resolveCallbackButtonLabel } from '../callback-label.ts';
import { parseAiBtnPayload } from '../handlers/callback.handler.ts';
import { CONNECT_WIZARD_REDACTION } from '../scenes/connect-telegram.scene.ts';
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
  /** The connect-wizard guard's verdict on this update's text or edit, reached before this middleware. */
  isConnectWizardInput: ConnectWizardGuard['isConnectWizardInput'];
}

interface LoggingTurn {
  userId: number;
  /** Telegram chat id for group chats; undefined in private chats. */
  logChatId: number | undefined;
  /** Chat id for the action log, falling back to the user's private chat. */
  actionChatId: number;
}

export function createChatLogging(deps: ChatLoggingDeps) {
  const { conversationLogger, actionLog, chatHistoryIds, isConnectWizardInput } = deps;

  function saveUserTurn(turn: LoggingTurn, text: string): void {
    chatHistoryIds.set(turn.userId, conversationLogger.logUserMessage(turn.userId, text, turn.logChatId));
  }

  function logIncomingText(turn: LoggingTurn, text: string, messageId: number | undefined, inConnectWizard: boolean) {
    if (inConnectWizard) {
      // A phone number, login code or 2FA password: keep the turn, never its text. Slash text is
      // not logged as a command either — a password may start with '/'.
      saveUserTurn(turn, CONNECT_WIZARD_REDACTION);
    } else if (text.match(/^\/cal(\s|$)/)) {
      // /cal is an AI command — save args as plain user message, not a command event.
      // In groups, bare /cal means "look at the recent context above"; save the literal
      // "/cal" so the agent has a new user turn to respond to. In DMs, bare /cal just
      // prints usage help, so there's nothing to save.
      const calArgs = text.replace(/^\/cal\s*/, '').trim();
      const savedText = calArgs || (turn.logChatId ? '/cal' : '');
      if (savedText) saveUserTurn(turn, savedText);
    } else if (text.startsWith('/')) {
      logCommand(turn, text, messageId);
    } else {
      saveUserTurn(turn, text);
    }
  }

  function logCommand(turn: LoggingTurn, text: string, messageId: number | undefined) {
    const spaceIdx = text.indexOf(' ');
    const cmdName = spaceIdx >= 0 ? text.slice(0, spaceIdx) : text;
    const cmdArgs = spaceIdx >= 0 ? text.slice(spaceIdx + 1).trim() : undefined;
    conversationLogger.logCommand(turn.userId, cmdName, cmdArgs || undefined, turn.logChatId);
    actionLog.insert({
      user_id: turn.userId,
      chat_id: turn.actionChatId,
      action_type: 'command',
      action_name: cmdName,
      message_id: messageId,
      input_summary: cmdArgs,
    });
  }

  function logCallback(turn: LoggingTurn, callbackQuery: NonNullable<TelegramUpdate['callback_query']>, data: string) {
    const firstColon = data.indexOf(':');
    const action = firstColon >= 0 ? data.slice(0, firstColon) : data;
    const payload = firstColon >= 0 ? data.slice(firstColon + 1) : '';
    const callbackMessage = callbackQuery.message;

    if (action === 'ai_btn') {
      const chatType = callbackMessage?.chat?.type;
      const isGroupCallback = chatType === 'group' || chatType === 'supergroup';
      saveUserTurn(turn, parseAiBtnPayload(payload, isGroupCallback).answerText);
      return;
    }
    const replyMarkup = callbackMessage && 'reply_markup' in callbackMessage ? callbackMessage.reply_markup : undefined;
    const buttonLabel = resolveCallbackButtonLabel(replyMarkup, data, action);
    conversationLogger.logButtonPress(turn.userId, buttonLabel, payload || undefined, turn.logChatId);
    actionLog.insert({
      user_id: turn.userId,
      chat_id: turn.actionChatId,
      action_type: 'callback',
      action_name: action,
      message_id: callbackMessage?.message_id,
      input_summary: payload || undefined,
    });
  }

  /** Wrap send and editText — logs every bot response (intent matcher, scenes, commands, callbacks). */
  function wrapBotReplies(context: ChatLoggingContext, turn: LoggingTurn) {
    // Note: AI agent uses TelegramSender.sendMessage() directly; those are logged via logAiTurn
    const originalSend = context.send?.bind(context);
    if (originalSend) {
      context.send = async (text, opts) => {
        const result = await originalSend(text, opts);
        conversationLogger.logBotResponse(turn.userId, text, turn.logChatId);
        return result;
      };
    }

    const originalEditText = context.editText?.bind(context);
    if (originalEditText) {
      context.editText = async (text, opts) => {
        const result = await originalEditText(text, opts);
        conversationLogger.logBotEdit(turn.userId, text, turn.logChatId);
        return result;
      };
    }
  }

  /** Saves what the user sent in this update: text or command, an edit, or a button press. */
  function logIncomingUpdate(update: TelegramUpdate | undefined, turn: LoggingTurn, inConnectWizard: boolean) {
    const incomingText = update?.message?.text;
    if (incomingText) logIncomingText(turn, incomingText, update?.message?.message_id, inConnectWizard);

    const editedText = update?.edited_message?.text;
    if (editedText) {
      conversationLogger.logEditedMessage(
        turn.userId,
        inConnectWizard ? CONNECT_WIZARD_REDACTION : editedText,
        turn.logChatId,
      );
    }

    // Callback query (button press or ai_btn answer) — universal, no per-handler logging needed
    const callbackQuery = update?.callback_query;
    if (callbackQuery?.data) logCallback(turn, callbackQuery, callbackQuery.data);
  }

  return async (context: ChatLoggingContext, next: Next) => {
    const user = context.dbUser;
    if (!user) return next();

    const update = context.update;
    const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
    const isPrivate = !chatId || chatId === user.telegram_id;
    const turn: LoggingTurn = {
      userId: user.telegram_id,
      logChatId: isPrivate ? undefined : chatId,
      actionChatId: chatId ?? user.telegram_id,
    };

    logIncomingUpdate(update, turn, isConnectWizardInput(context));
    wrapBotReplies(context, turn);
    return next();
  };
}
