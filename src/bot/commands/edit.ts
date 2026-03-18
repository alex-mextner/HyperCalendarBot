// src/bot/commands/edit.ts

import type { AnyScene } from '@gramio/scenes';
import { CB, t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { editFieldKeyboard, eventPickerKeyboard, recurringEditKeyboard } from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export async function handleEdit(ctx: BotCommandContext, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const upcoming = eventService.getUpcoming(user.telegram_id, 10);

  if (upcoming.length === 0) {
    await ctx.send(t(lang).no_events);
    return;
  }

  await ctx.send(t(lang).edit_pick, {
    reply_markup: eventPickerKeyboard(upcoming, user.timezone, CB.EVENT_EDIT),
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

  const chatId = ctx.chatId!;
  const messageId = (ctx.message as unknown as { id: number } | undefined)?.id ?? 0;
  await ctx.answer();
  await ctx.scene.enter(editValueScene, { eventId, field, chatId, messageId });
}
