import type { Bot, InlineKeyboard, TelegramInlineKeyboardMarkup } from 'gramio';
import { createTelegramSender } from '../../src/services/ai/telegram-sender.ts';

/** Telegram refuses an inline button whose callback_data is over 64 BYTES (BUTTON_DATA_INVALID); Cyrillic is 2 bytes a character. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/** A Russian option of exactly `length` characters, with the colons and digits real answers carry. */
export function cyrillicOption(length: number): string {
  return 'Вариант: создать у меня на 19:00 и пригласить Ольгу, Сэма, Кима. '.repeat(5).slice(0, length);
}

/**
 * The real sender over a Telegram that refuses what Telegram refuses: a button over the callback_data
 * limit fails the whole message, as it did in production on 2026-10-31. `sent` holds each keyboard
 * the way the tapped message will later carry it back.
 */
export function fakeTelegram() {
  const sent: TelegramInlineKeyboardMarkup[] = [];
  const sendMessage = async (args: { reply_markup: InlineKeyboard }) => {
    const keyboard = args.reply_markup.toJSON();
    for (const button of keyboard.inline_keyboard.flat()) {
      const callbackData = 'callback_data' in button ? button.callback_data : undefined;
      if (Buffer.byteLength(callbackData ?? '', 'utf8') > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
        throw new Error('Bad Request: BUTTON_DATA_INVALID');
      }
    }
    sent.push(keyboard);
    return { message_id: sent.length };
  };
  const bot = { api: { sendMessage } } as unknown as Bot;
  return { sender: createTelegramSender(bot), sent };
}
