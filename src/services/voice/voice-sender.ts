/**
 * The live-call agent's Telegram sender. A call speaks its answers, but some replies still go
 * to the caller's private chat: protocol messages, and the delete list the caller taps.
 */
import type { TelegramInlineKeyboardMarkup } from 'gramio';
import type { ParseMode } from '../../utils/telegram.ts';
import type { TelegramSender } from '../ai/types.ts';

/** The slice of the bot API the call sender forwards to (index.ts patches it once the bot exists). */
export interface VoiceBotApi {
  sendMessage(
    telegramId: number,
    text: string,
    parseMode?: ParseMode,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<{ message_id: number }>;
  editMessage(chatId: number, messageId: number, text: string, parseMode?: ParseMode): Promise<void>;
}

export function createVoiceSender(bot: VoiceBotApi): TelegramSender {
  return {
    sendMessage: (chatId, text, parseMode) => bot.sendMessage(chatId, text, parseMode),
    editMessageText: (chatId, messageId, text, parseMode) => bot.editMessage(chatId, messageId, text, parseMode),
    // The delete list a call sends to the chat: only a tap on it deletes (#608).
    sendMessageWithKeyboard: (chatId, text, keyboard) => bot.sendMessage(chatId, text, undefined, keyboard.toJSON()),
  };
}
