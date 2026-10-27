// src/bootstrap/bot-ref.ts
//
// The late-bound Telegram transport. Queues, workers and services are wired BEFORE createBot() (they
// are inputs to it), yet they must send through the bot. They receive `botRef`, an object whose
// methods start as inert placeholders and are replaced in place by patchBotRef() once the bot exists.
//
// Ordering invariants:
//  - botRef keeps its identity for the whole process. Consumers (createNotificationSender,
//    createVoiceSender, closures in the Google/bot-tasks wiring) hold the object and read the method
//    on every call; none may capture the placeholder method.
//  - patchBotRef() runs immediately after createBot() and BEFORE any worker that sends (the broadcast
//    worker) is created.
//  - BotHandle.get() before BotHandle.set() throws, mirroring a read of a not-yet-initialised binding.

import type { InlineKeyboard, TelegramInlineKeyboardMarkup, TelegramReplyKeyboardMarkup } from 'gramio';
import type { BroadcastSender } from '../worker/broadcast-queue.ts';

export type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';
type ReplyMarkup = TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;

export interface BotRef {
  sendMessage: (
    telegramId: number,
    text: string,
    parseMode?: ParseMode,
    replyMarkup?: ReplyMarkup,
  ) => Promise<{ message_id: number }>;
  sendVoice: (telegramId: number, audio: Buffer) => Promise<void>;
  editMessage: (
    chatId: number,
    messageId: number,
    text: string,
    parseMode?: ParseMode,
    replyMarkup?: InlineKeyboard,
  ) => Promise<void>;
}

/** The slice of the GramIO bot API that botRef and the broadcast sender call. */
export interface TelegramSendApi {
  sendMessage(params: {
    chat_id: number;
    text: string;
    parse_mode?: ParseMode;
    reply_markup?: ReplyMarkup | InlineKeyboard;
    message_thread_id?: number;
  }): Promise<unknown>;
  editMessageText(params: {
    chat_id: number;
    message_id: number;
    text: string;
    parse_mode?: ParseMode;
    reply_markup?: InlineKeyboard;
  }): Promise<unknown>;
  sendVoice(params: { chat_id: number; voice: File }): Promise<unknown>;
}

export function createBotRef(): BotRef {
  return {
    sendMessage: async () => ({ message_id: 0 }),
    sendVoice: async () => {},
    editMessage: async () => {},
  };
}

function requireMessageId(sent: unknown, chatId: number): { message_id: number } {
  if (typeof sent !== 'object' || sent === null || !('message_id' in sent)) {
    throw new Error(`sendMessage returned no message_id for chat ${chatId}`);
  }
  return { message_id: sent.message_id as number };
}

/** Replaces the placeholders on `botRef` with calls through the real bot API. */
export function patchBotRef(botRef: BotRef, api: TelegramSendApi): void {
  botRef.sendMessage = async (telegramId, text, parseMode, replyMarkup) => {
    const msg = await api.sendMessage({
      chat_id: telegramId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return requireMessageId(msg, telegramId);
  };
  botRef.editMessage = async (chatId, messageId, text, parseMode, replyMarkup) => {
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  };
  botRef.sendVoice = async (telegramId, audio) => {
    const file = new File([audio], 'message.mp3', { type: 'audio/mpeg' });
    await api.sendVoice({ chat_id: telegramId, voice: file });
  };
}

/** Sender for the broadcast worker: supports forum-topic threads, which botRef.sendMessage does not. */
export function createBroadcastSender(api: TelegramSendApi): BroadcastSender {
  return {
    sendMessage: async (chatId, text, parseMode, threadId) => {
      const msg = await api.sendMessage({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
      return requireMessageId(msg, chatId);
    },
  };
}

/** Holds the bot for closures created before it exists. */
export interface BotHandle<TBot> {
  get(): TBot;
  set(bot: TBot): void;
}

export function createBotHandle<TBot>(): BotHandle<TBot> {
  let current: { bot: TBot } | undefined;
  return {
    get() {
      if (!current) throw new Error('Bot accessed before createBot() returned');
      return current.bot;
    },
    set(bot) {
      current = { bot };
    },
  };
}
