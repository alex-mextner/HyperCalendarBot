// src/bot/commands/delete.ts

import { CB, t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import {
  deleteConfirmKeyboard,
  EVENT_PICKER_PAGE_SIZE,
  eventPickerKeyboard,
  recurrenceScopeKeyboard,
} from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export async function handleDelete(
  ctx: BotCommandContext,
  eventService: EventService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';

  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx);
    if (groupId === null) return;
    const timezone = groupRepo?.getTimezone(groupId) ?? null;
    if (!timezone) {
      await ctx.send(
        lang === 'ru' ? '⚙️ Сначала задайте таймзону через /settings' : '⚙️ Set group timezone via /settings',
      );
      return;
    }
    const occurrences = eventService.getUpcomingForGroup(groupId, EVENT_PICKER_PAGE_SIZE + 1);
    if (occurrences.length === 0) {
      await ctx.send(t(lang).no_events);
      return;
    }
    const events = occurrences.map((o) => ({ ...o.event, start_at: o.occurrence_start }));
    const hasMore = events.length > EVENT_PICKER_PAGE_SIZE;
    const pageItems = events.slice(0, EVENT_PICKER_PAGE_SIZE);
    await ctx.send(t(lang).delete_pick, {
      reply_markup: eventPickerKeyboard(pageItems, timezone, CB.EVENT_DELETE, lang, {
        page: 0,
        hasMore,
        onPage: (p) => `${CB.EVENT_DELETE}:page:${p}`,
      }),
    });
    return;
  }

  const upcoming = eventService.getUpcoming(user.telegram_id, EVENT_PICKER_PAGE_SIZE + 1);

  if (upcoming.length === 0) {
    await ctx.send(t(lang).no_events);
    return;
  }

  const hasMore = upcoming.length > EVENT_PICKER_PAGE_SIZE;
  const pageItems = upcoming.slice(0, EVENT_PICKER_PAGE_SIZE);
  await ctx.send(t(lang).delete_pick, {
    reply_markup: eventPickerKeyboard(pageItems, user.timezone, CB.EVENT_DELETE, lang, {
      page: 0,
      hasMore,
      onPage: (p) => `${CB.EVENT_DELETE}:page:${p}`,
    }),
  });
}

export async function handleDeleteCallback(
  ctx: BotCallbackContext,
  eventService: EventService,
  user: User,
  eventId: number,
  occurrenceDate?: string,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';

  if (eventId === 0) {
    await ctx.answer();
    await ctx.editText(t(lang).cancelled);
    return;
  }

  const groupId = getGroupId(ctx);

  if (groupId !== null) {
    const event = eventService.getEventForGroup(eventId, groupId);
    if (!event) {
      await ctx.answer({ text: 'Event not found' });
      return;
    }
    await ctx.answer();
    if (event.recurrence_rule && occurrenceDate) {
      await ctx.editText(t(lang).confirm_delete(event.title), {
        reply_markup: recurrenceScopeKeyboard(CB.RECURRENCE_DELETE, eventId, occurrenceDate, lang),
      });
      return;
    }
    await ctx.editText(t(lang).confirm_delete(event.title), {
      reply_markup: deleteConfirmKeyboard(eventId, lang),
    });
    return;
  }

  const event = eventService.getEvent(eventId, user.telegram_id);
  if (!event) {
    await ctx.answer({ text: 'Event not found' });
    return;
  }

  await ctx.answer();

  if (event.recurrence_rule && occurrenceDate) {
    await ctx.editText(t(lang).confirm_delete(event.title), {
      reply_markup: recurrenceScopeKeyboard(CB.RECURRENCE_DELETE, eventId, occurrenceDate, lang),
    });
    return;
  }

  await ctx.editText(t(lang).confirm_delete(event.title), {
    reply_markup: deleteConfirmKeyboard(eventId, lang),
  });
}

export async function handleDeleteConfirmCallback(
  ctx: BotCallbackContext,
  eventService: EventService,
  user: User,
  eventId: number,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const groupId = getGroupId(ctx);

  if (groupId !== null) {
    const event = eventService.getEventForGroup(eventId, groupId);
    const title = event?.title ?? '?';
    const deleted = eventService.deleteEventForGroup(eventId, groupId);
    await ctx.answer();
    if (deleted) {
      await ctx.editText(t(lang).event_deleted(title));
    } else {
      await ctx.editText(t(lang).something_wrong);
    }
    return;
  }

  const event = eventService.getEvent(eventId, user.telegram_id);
  const title = event?.title ?? '?';
  const deleted = eventService.deleteEvent(eventId, user.telegram_id);

  await ctx.answer();
  if (deleted) {
    await ctx.editText(t(lang).event_deleted(title));
  } else {
    await ctx.editText(t(lang).something_wrong);
  }
}
