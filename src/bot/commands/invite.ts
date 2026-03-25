// src/bot/commands/invite.ts

import { CB } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import { getGroupId, isGroup } from '../group-context.ts';
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
  groupRepo?: GroupChatRepository;
}

export async function handleInvite(ctx: BotCommandContext, deps: InviteDeps): Promise<void> {
  const { eventService, groupRepo } = deps;
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx);
    if (groupId === null) return;
    const timezone = groupRepo?.getTimezone(groupId) ?? 'UTC';
    const occurrences = eventService.getUpcomingForGroup(groupId, 10);
    if (occurrences.length === 0) {
      await ctx.send(lang === 'ru' ? '📭 Нет событий в группе' : '📭 No group events');
      return;
    }
    const events = occurrences.map((o) => ({ ...o.event, start_at: o.occurrence_start }));
    await ctx.send(
      lang === 'ru' ? '📨 Выберите событие для приглашения:' : '📨 Select an event to invite someone to:',
      {
        reply_markup: eventPickerKeyboard(events, timezone, CB.INVITE_PICK, lang),
      },
    );
    return;
  }

  const events = eventService.getUpcoming(user.telegram_id, 10);
  if (events.length === 0) {
    await ctx.send(lang === 'ru' ? '📅 У вас нет предстоящих событий.' : '📅 You have no upcoming events.');
    return;
  }

  await ctx.send(lang === 'ru' ? '📨 Выберите событие для приглашения:' : '📨 Select an event to invite someone to:', {
    reply_markup: eventPickerKeyboard(events, user.timezone, CB.INVITE_PICK, lang),
  });
}
