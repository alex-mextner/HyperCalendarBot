import type { Bot } from 'gramio';
import type { TelegramSender } from './types.ts';

export function createTelegramSender(bot: Bot): TelegramSender {
  return {
    async sendMessage(chatId: number, text: string, parseMode?: string) {
      const result = await bot.api.sendMessage({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      return { message_id: result.message_id };
    },
    async editMessageText(chatId: number, messageId: number, text: string, parseMode?: string) {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
    },
  };
}
