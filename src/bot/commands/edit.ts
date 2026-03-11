// src/bot/commands/edit.ts

import { CB, t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseSimpleDate } from '../../utils/date.ts';
import { editFieldKeyboard, eventPickerKeyboard, recurringEditKeyboard } from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';
import { clearSession, getSession, setSession } from '../types.ts';

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
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const event = eventService.getEvent(eventId, user.telegram_id);
  if (!event) {
    await ctx.answer({ text: 'Event not found' });
    return;
  }

  if (event.recurrence_rule) {
    await ctx.editText(formatEventDetail(event, user.timezone, lang), {
      parse_mode: 'HTML',
      reply_markup: recurringEditKeyboard(eventId, lang),
    });
    return;
  }

  await ctx.editText(formatEventDetail(event, user.timezone, lang), {
    parse_mode: 'HTML',
    reply_markup: editFieldKeyboard(eventId, lang),
  });
}

/**
 * Handle field edit callback
 */
export async function handleEditFieldCallback(
  ctx: BotCallbackContext,
  user: User,
  eventId: number,
  field: string,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';

  if (field === 'cancel') {
    await ctx.editText(lang === 'ru' ? 'Отменено.' : 'Cancelled.');
    return;
  }

  setSession(user.telegram_id, `edit:${field}`, { eventId });

  const prompts: Record<string, Record<string, string>> = {
    title: { en: 'Send new title:', ru: 'Отправьте новое название:' },
    time: { en: 'Send new date/time (e.g., "tomorrow 15:00"):', ru: 'Отправьте новую дату/время:' },
    description: {
      en: 'Send new description (or "clear" to remove):',
      ru: 'Отправьте описание (или "clear" для удаления):',
    },
    location: { en: 'Send new location (or "clear" to remove):', ru: 'Отправьте место (или "clear" для удаления):' },
  };

  const prompt = prompts[field]?.[lang] ?? 'Send new value:';
  await ctx.answer();
  await ctx.send(prompt);
}

/**
 * Handle edit wizard step (called from message handler)
 */
export async function handleEditWizardStep(
  ctx: BotCommandContext,
  eventService: EventService,
  user: User,
  text: string,
): Promise<boolean> {
  const session = getSession(user.telegram_id);
  if (!session || !session.step.startsWith('edit:')) return false;
  const lang = user.language as 'en' | 'ru';
  const eventId = session.data.eventId as number;
  const field = session.step.replace('edit:', '');

  const updateData: Record<string, unknown> = {};

  if (field === 'title') {
    updateData.title = text;
  } else if (field === 'time') {
    const parsed = parseSimpleDate(text, user.timezone);
    if (!parsed) {
      await ctx.send(lang === 'ru' ? 'Не могу разобрать дату.' : "Can't parse that date.");
      return true;
    }
    updateData.start_at = parsed.toISOString();
  } else if (field === 'description') {
    updateData.description = text.toLowerCase() === 'clear' ? null : text;
  } else if (field === 'location') {
    updateData.location = text.toLowerCase() === 'clear' ? null : text;
  }

  const updated = eventService.updateEvent(eventId, user.telegram_id, updateData);
  clearSession(user.telegram_id);

  if (updated) {
    const detail = formatEventDetail(updated, user.timezone, lang);
    await ctx.send(`${t(lang).event_updated(updated.title)}\n\n${detail}`, { parse_mode: 'HTML' });
  } else {
    await ctx.send(t(lang).something_wrong);
  }

  return true;
}
