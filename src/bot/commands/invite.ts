// src/bot/commands/invite.ts

import { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { BotCommandContext } from '../types.ts';

interface TelegramSendResult {
  message_id: number;
}

type SendMessageFn = (
  chatId: number,
  text: string,
  options: { parse_mode: string; reply_markup?: unknown },
) => Promise<TelegramSendResult>;

export async function handleInvite(ctx: BotCommandContext, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  const occurrences = eventService.getUpcoming(user.telegram_id, 20, user.timezone);
  if (occurrences.length === 0) {
    await ctx.send(lang === 'ru' ? 'У вас нет предстоящих событий.' : 'You have no upcoming events.');
    return;
  }

  const kb = new InlineKeyboard();
  const seen = new Set<number>();
  for (const occ of occurrences) {
    if (seen.has(occ.event.id)) continue;
    seen.add(occ.event.id);
    kb.text(occ.event.title, `${CB.INVITE_PICK}:${occ.event.id}`).row();
    if (seen.size >= 10) break;
  }

  const prompt = lang === 'ru' ? '📨 Выберите событие для приглашения:' : '📨 Choose an event to invite to:';
  await ctx.send(prompt, { reply_markup: kb });
}

export async function deliverInvitation(
  inviteeId: number,
  invitationId: number,
  eventTitle: string,
  inviterName: string,
  lang: 'en' | 'ru',
  invRepo: InvitationRepository,
  sendMessage: SendMessageFn,
): Promise<boolean> {
  const messages = t(lang);
  const inviteeText = messages.invitation_received(eventTitle, inviterName);
  const keyboard = new InlineKeyboard()
    .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitationId}`)
    .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitationId}`)
    .row()
    .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitationId}`);

  try {
    const sent = await sendMessage(inviteeId, inviteeText, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    invRepo.setMessageInfo(invitationId, sent.message_id, inviteeId);
    return true;
  } catch {
    return false;
  }
}
