// src/bot/commands/edit.ts

import type { AnyScene } from '@gramio/scenes';
import { CB, t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import { EVENT_PICKER_PAGE_SIZE, editFieldKeyboard, eventPickerKeyboard, recurringEditKeyboard } from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export async function handleEdit(
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
    await ctx.send(t(lang).edit_pick, {
      reply_markup: eventPickerKeyboard(pageItems, timezone, CB.EVENT_EDIT, lang, {
        page: 0,
        hasMore,
        onPage: (p) => `${CB.EVENT_EDIT}:page:${p}`,
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
  await ctx.send(t(lang).edit_pick, {
    reply_markup: eventPickerKeyboard(pageItems, user.timezone, CB.EVENT_EDIT, lang, {
      page: 0,
      hasMore,
      onPage: (p) => `${CB.EVENT_EDIT}:page:${p}`,
    }),
  });
}

/**
 * Handle edit callbacks (called from callback handler)
 */
export async function handleEditCallback(
  ctx: BotCallbackContext,
  eventService: EventService,
  user: User,
  eventId: number,
  occurrenceDate?: string,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const event = eventService.getEvent(eventId, user.telegram_id);
  if (!event) {
    await ctx.answer({ text: 'Event not found' });
    return;
  }

  await ctx.answer();

  if (event.recurrence_rule && occurrenceDate) {
    await ctx.editText(formatEventDetail(event, user.timezone, lang), {
      parse_mode: 'HTML',
      reply_markup: recurringEditKeyboard(eventId, occurrenceDate, lang),
    });
    return;
  }

  await ctx.editText(formatEventDetail(event, user.timezone, lang), {
    parse_mode: 'HTML',
    reply_markup: editFieldKeyboard(eventId, lang),
  });
}

/**
 * Handle field edit callback — enter edit_value scene
 */
export async function handleEditFieldCallback(
  ctx: BotCallbackContext,
  user: User,
  eventId: number,
  field: string,
  editValueScene: AnyScene,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';

  if (field === 'cancel') {
    await ctx.editText(t(lang).cancelled);
    return;
  }

  if (!ctx.message) {
    cmdLogger.warn({ chatId: ctx.chatId }, 'handleEditFieldCallback: callback has no message');
    return;
  }
  const chatId = ctx.chatId!;
  const messageId = ctx.message.id;
  await ctx.answer();
  await ctx.scene.enter(editValueScene, { eventId, field, chatId, messageId });
}
