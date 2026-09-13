// src/bot/commands/invite.ts

import type { InlineKeyboard } from 'gramio';
import { CB } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import { EVENT_PICKER_PAGE_SIZE, eventPickerKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';

type SendMessageFn = (
  chatId: number,
  text: string,
  options: { parse_mode: string; reply_markup?: InlineKeyboard },
) => Promise<{ message_id: number }>;

export interface InviteDeps {
  invitationService: InvitationService;
  eventService: EventService;
  invRepo: InvitationRepository;
  deepLinkService: DeepLinkService;
  sendMessage: SendMessageFn;
  groupRepo?: GroupChatRepository;
}

export function invitePickPrompt(lang: 'en' | 'ru'): string {
  return lang === 'ru' ? '📨 Выберите событие для приглашения:' : '📨 Select an event to invite someone to:';
}

export async function handleInvite(ctx: BotCommandContext, deps: InviteDeps): Promise<void> {
  const { eventService, groupRepo } = deps;
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';

  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx);
    if (groupId === null) return;
    const timezone = groupRepo?.getTimezone(groupId) ?? 'UTC';
    const occurrences = eventService.getUpcomingForGroup(groupId, EVENT_PICKER_PAGE_SIZE + 1);
    if (occurrences.length === 0) {
      await ctx.send(lang === 'ru' ? '📭 Нет событий в группе' : '📭 No group events');
      return;
    }
    const events = occurrences.map((o) => ({ ...o.event, start_at: o.occurrence_start }));
    const hasMore = events.length > EVENT_PICKER_PAGE_SIZE;
    const pageItems = events.slice(0, EVENT_PICKER_PAGE_SIZE);
    await ctx.send(invitePickPrompt(lang), {
      reply_markup: eventPickerKeyboard(pageItems, timezone, CB.INVITE_PICK, lang, {
        page: 0,
        hasMore,
        onPage: (p) => `${CB.INVITE_PICK}:page:${p}`,
      }),
    });
    return;
  }

  const events = eventService.getUpcoming(user.telegram_id, EVENT_PICKER_PAGE_SIZE + 1);
  if (events.length === 0) {
    await ctx.send(lang === 'ru' ? '📅 У вас нет предстоящих событий.' : '📅 You have no upcoming events.');
    return;
  }

  const hasMore = events.length > EVENT_PICKER_PAGE_SIZE;
  const pageItems = events.slice(0, EVENT_PICKER_PAGE_SIZE);
  await ctx.send(invitePickPrompt(lang), {
    reply_markup: eventPickerKeyboard(pageItems, user.timezone, CB.INVITE_PICK, lang, {
      page: 0,
      hasMore,
      onPage: (p) => `${CB.INVITE_PICK}:page:${p}`,
    }),
  });
}
