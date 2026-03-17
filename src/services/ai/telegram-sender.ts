import type { Bot } from 'gramio';
import { InlineKeyboard, Keyboard } from 'gramio';
import { CB } from '../../config/constants.ts';
import type { TelegramSender } from './types.ts';

interface TelegramSenderOptions {
  sendAsUser?: (userId: number, text: string, username?: string) => Promise<boolean>;
}

export function createTelegramSender(bot: Bot, options?: TelegramSenderOptions): TelegramSender {
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
    async sendButtons(chatId: number, text: string, buttons: string[], parseMode?: string, userId?: number) {
      const kb = new InlineKeyboard();
      for (const btn of buttons) {
        const cbData = userId ? `ai_btn:${userId}:${btn}` : `ai_btn:${btn}`;
        kb.text(btn, cbData).row();
      }
      const result = await bot.api.sendMessage({
        chat_id: chatId,
        text,
        reply_markup: kb,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      return { message_id: result.message_id };
    },
    async sendPhoto(chatId: number, photo: File) {
      await bot.api.sendPhoto({ chat_id: chatId, photo });
    },
    async sendInvitation(inviteeId: number, text: string, invitationId: number) {
      const kb = new InlineKeyboard()
        .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitationId}`)
        .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitationId}`)
        .row()
        .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitationId}`);
      try {
        const result = await bot.api.sendMessage({
          chat_id: inviteeId,
          text,
          parse_mode: 'HTML',
          reply_markup: kb,
        });
        return { message_id: result.message_id };
      } catch {
        return null;
      }
    },
    async sendEditProposal(creatorId: number, text: string, proposalId: number) {
      const kb = new InlineKeyboard()
        .text('Accept ✅', `${CB.EDIT_PROPOSAL}:accept:${proposalId}`)
        .text('Reject ❌', `${CB.EDIT_PROPOSAL}:reject:${proposalId}`);
      try {
        const result = await bot.api.sendMessage({
          chat_id: creatorId,
          text,
          parse_mode: 'HTML',
          reply_markup: kb,
        });
        return { message_id: result.message_id };
      } catch {
        return null;
      }
    },
    async sendUserPicker(chatId: number, text: string, requestId: number) {
      const kb = new Keyboard()
        .requestUsers('👤 Выбрать участников', requestId, {
          user_is_bot: false,
          max_quantity: 10,
          request_name: true,
          request_username: true,
        })
        .resized()
        .oneTime();
      const result = await bot.api.sendMessage({
        chat_id: chatId,
        text,
        reply_markup: kb,
      });
      return { message_id: result.message_id };
    },
    sendAsUser: options?.sendAsUser
      ? async (userId: number, text: string, username?: string) => options.sendAsUser!(userId, text, username)
      : undefined,
  };
}
