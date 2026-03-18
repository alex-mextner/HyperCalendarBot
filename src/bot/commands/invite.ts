// src/bot/commands/invite.ts

import { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import type { BotCommandContext } from '../types.ts';

interface TelegramSendResult {
  message_id: number;
}

type SendMessageFn = (
  chatId: number,
  text: string,
  options: { parse_mode: string; reply_markup?: unknown },
) => Promise<TelegramSendResult>;

export async function handleInvite(
  ctx: BotCommandContext,
  invitationService: InvitationService,
  eventService: EventService,
  invRepo: InvitationRepository,
  deepLinkService: DeepLinkService,
  sendMessage: SendMessageFn,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const messages = t(lang);

  const parts = (ctx.args ?? '').trim().split(/\s+/);
  const inviteeId = Number.parseInt(parts[0] ?? '', 10);
  const eventId = Number.parseInt(parts[1] ?? '', 10);

  if (!inviteeId || !eventId || Number.isNaN(inviteeId) || Number.isNaN(eventId)) {
    await ctx.send(messages.invite_usage);
    return;
  }

  const result = invitationService.sendInvitation(eventId, user.telegram_id, inviteeId);

  if (!result.success || !result.invitation) {
    await ctx.send(result.error ?? messages.invite_usage);
    return;
  }

  const invitation = result.invitation;
  const event = eventService.getEvent(eventId, user.telegram_id);
  const eventTitle = event?.title ?? `Event #${eventId}`;
  const inviterName = user.first_name ?? user.username ?? `User ${user.telegram_id}`;
  const inviteeText = messages.invitation_received(eventTitle, inviterName);

  const keyboard = new InlineKeyboard()
    .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
    .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
    .row()
    .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`);

  try {
    const sent = await sendMessage(inviteeId, inviteeText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    invRepo.setMessageInfo(invitation.id, sent.message_id, inviteeId);
    await ctx.send(messages.invite_delivered(eventTitle), { parse_mode: 'HTML' });
  } catch (err) {
    const statusCode = (err as Record<string, unknown>).statusCode;
    if (statusCode === 403) {
      const deepLink = deepLinkService.createInvitationLink(invitation.id, eventId, user.telegram_id);
      const url = deepLinkService.generateUrl(deepLink.code, process.env.BOT_USERNAME ?? 'bot');
      await ctx.send(messages.invite_deep_link(eventTitle, url), { parse_mode: 'HTML' });
    } else {
      throw err;
    }
  }
}
