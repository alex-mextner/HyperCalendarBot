// How a command (or a button that behaves like one) sends and pins its picture. The sends go through
// the context so a reply lands where the command was typed; the pin is the best-effort autoPin that
// /today and /month have always done.
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { PictureRequest } from '../../services/image/queue-picture.ts';
import { autoPin } from '../../utils/auto-pin.ts';
import { imageLogger } from '../../utils/logger.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

type PictureContext = BotCommandContext | BotCallbackContext;

/** The transport half of a PictureRequest for a private-chat command. */
export function commandPictureTransport(
  ctx: PictureContext,
  chatId: number,
): Pick<PictureRequest, 'chatId' | 'requestId' | 'sendPhoto' | 'sendDocument' | 'notify'> {
  return {
    chatId,
    requestId: ctx.id,
    sendPhoto: async (file) => (await ctx.sendPhoto(file)).id,
    sendDocument: async (file, options) => (await ctx.sendDocument(file, options)).id,
    notify: (text) => ctx.send(text),
  };
}

/** Pins the delivered picture when the user's pin preference says so; never throws. */
export function pinPicture(
  ctx: PictureContext,
  chatId: number,
  messageId: number,
  groupRepo: GroupChatRepository | undefined,
  isGroupChat: boolean,
): void {
  autoPin(chatId, messageId, {
    pinChatMessage: (cid, pinnedId, options) =>
      ctx.bot.api.pinChatMessage({
        chat_id: cid,
        message_id: pinnedId,
        disable_notification: options.disable_notification,
      }),
    sendMessage: async (cid, text) => {
      await ctx.bot.api.sendMessage({ chat_id: cid, text });
    },
    isGroupChat,
    groupChatRepo: groupRepo,
  }).catch((err) => {
    imageLogger.error({ err }, 'autoPin failed');
  });
}
