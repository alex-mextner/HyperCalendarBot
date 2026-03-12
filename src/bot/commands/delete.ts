// src/bot/commands/delete.ts

import { CB, t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { deleteConfirmKeyboard, eventPickerKeyboard } from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export async function handleDelete(ctx: BotCommandContext, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const upcoming = eventService.getUpcoming(user.telegram_id, 10);

  if (upcoming.length === 0) {
    await ctx.send(t(lang).no_events);
    return;
  }

  await ctx.send(t(lang).delete_pick, {
    reply_markup: eventPickerKeyboard(upcoming, user.timezone, CB.EVENT_DELETE),
  });
}

export async function handleDeleteCallback(
  ctx: BotCallbackContext,
  eventService: EventService,
  user: User,
  eventId: number,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';

  if (eventId === 0) {
    await ctx.answer();
    await ctx.editText(lang === 'ru' ? 'Отменено.' : 'Cancelled.');
    return;
  }

  const event = eventService.getEvent(eventId, user.telegram_id);
  if (!event) {
    await ctx.answer({ text: 'Event not found' });
    return;
  }

  await ctx.answer();
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
