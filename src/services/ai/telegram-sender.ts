import type { Bot, TelegramReactionTypeEmojiEmoji } from 'gramio';
import { InlineKeyboard, Keyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { ParseMode } from '../../utils/telegram.ts';
import type { TelegramSender } from './types.ts';

interface TelegramSenderOptions {
  sendAsUser?: (userId: number, text: string, username?: string) => Promise<boolean>;
  sendAsConnectedUser?: (
    inviterId: number,
    targetId: number,
    text: string,
    username?: string,
    meta?: { invitationId?: number },
  ) => Promise<boolean>;
}

export function createTelegramSender(bot: Bot, options?: TelegramSenderOptions): TelegramSender {
  return {
    async sendMessage(chatId: number, text: string, parseMode?: ParseMode) {
      const result = await bot.api.sendMessage({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      return { message_id: result.message_id };
    },
    async sendMessageWithKeyboard(chatId: number, text: string, keyboard: InlineKeyboard) {
      const result = await bot.api.sendMessage({
        chat_id: chatId,
        text,
        reply_markup: keyboard,
      });
      return { message_id: result.message_id };
    },
    async editMessageText(chatId: number, messageId: number, text: string, parseMode?: ParseMode) {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
    },
    async sendButtons(chatId: number, text: string, buttons: string[], parseMode?: ParseMode, userId?: number) {
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
      const result = await bot.api.sendPhoto({ chat_id: chatId, photo });
      return { message_id: result.message_id };
    },
    async pinChatMessage(chatId: number, messageId: number, options: { disable_notification: boolean }) {
      return bot.api.pinChatMessage({
        chat_id: chatId,
        message_id: messageId,
        disable_notification: options.disable_notification,
      });
    },
    async sendInvitation(inviteeId: number, text: string, invitationId: number, lang?: string) {
      const msgs = t((lang ?? 'en') as 'en' | 'ru');
      const kb = new InlineKeyboard()
        .text('✅ Accept', `${CB.INVITATION_ACTION}:accept:${invitationId}`)
        .text('❌ Decline', `${CB.INVITATION_ACTION}:decline:${invitationId}`)
        .row()
        .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitationId}`)
        .text(msgs.invite_propose_btn, `${CB.INVITATION_ACTION}:propose:${invitationId}`);
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
        .text('✅ Accept', `${CB.EDIT_PROPOSAL}:accept:${proposalId}`)
        .text('❌ Reject', `${CB.EDIT_PROPOSAL}:reject:${proposalId}`);
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
    sendAsConnectedUser: options?.sendAsConnectedUser,
    async deleteMessage(chatId: number, messageId: number) {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
    },
    async setReaction(chatId: number, messageId: number, emoji: string) {
      await bot.api.setMessageReaction({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: emoji as TelegramReactionTypeEmojiEmoji }],
      });
    },
    async sendChatAction(chatId: number, action: 'typing') {
      await bot.api.sendChatAction({ chat_id: chatId, action });
    },
  };
}
