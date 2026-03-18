// src/bot/commands/invite.ts

import { CB } from '../../config/constants.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import { eventPickerKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';

type SendMessageFn = (
  chatId: number,
  text: string,
  options: { parse_mode: string; reply_markup?: unknown },
) => Promise<{ message_id: number }>;

export interface InviteDeps {
  invitationService: InvitationService;
  eventService: EventService;
  invRepo: InvitationRepository;
  deepLinkService: DeepLinkService;
  sendMessage: SendMessageFn;
}

export async function handleInvite(ctx: BotCommandContext, deps: InviteDeps): Promise<void> {
  const { eventService } = deps;
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  const events = eventService.getUpcoming(user.telegram_id, 10);
  if (events.length === 0) {
    await ctx.send(lang === 'ru' ? '📅 У вас нет предстоящих событий.' : '📅 You have no upcoming events.');
    return;
  }

  await ctx.send(lang === 'ru' ? '📨 Выберите событие для приглашения:' : '📨 Select an event to invite someone to:', {
    reply_markup: eventPickerKeyboard(events, user.timezone, CB.INVITE_PICK),
  });
}
