// src/bot/commands/calendars.ts
import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../config/constants.ts';
import { CB, t } from '../../config/constants.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleCalendar } from '../../database/types.ts';
import { googleCalendarColorEmoji } from '../../services/google/calendar-colors.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export function buildCalendarPickerKeyboard(calendars: GoogleCalendar[], lang: Lang): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const cal of calendars) {
    const check = cal.sync_enabled ? '✅' : '⬜';
    const readonly =
      cal.access_role === 'reader' || cal.access_role === 'freeBusyReader' ? ` ${t(lang).gcal_calendar_readonly}` : '';
    const primary = cal.is_primary ? ' ★' : '';
    const dot = googleCalendarColorEmoji(cal.color) || '📅';
    kb.text(`${check} ${dot} ${cal.calendar_name}${primary}${readonly}`, `${CB.GCAL}:cal:${cal.id}`).row();
  }
  kb.text(t(lang).gcal_calendar_done, `${CB.GCAL}:cal:done`);
  return kb;
}

export async function showCalendarPicker(
  ctx: BotCommandContext,
  calendarRepo: GoogleCalendarRepository,
  userId: number,
  lang: Lang,
): Promise<void> {
  const calendars = calendarRepo.getCalendars(userId);
  const keyboard = buildCalendarPickerKeyboard(calendars, lang);
  await ctx.send(t(lang).gcal_calendar_picker, { reply_markup: keyboard });
}

export async function handleCalendarPickerCallback(
  ctx: BotCallbackContext,
  calendarRepo: GoogleCalendarRepository,
  userId: number,
  payload: string,
  lang: Lang,
  onDone?: (userId: number) => Promise<void>,
): Promise<void> {
  if (payload === 'done') {
    await ctx.answer();
    await ctx.editText(t(lang).gcal_calendars_saved);
    if (onDone) {
      await onDone(userId);
    }
    return;
  }

  const calendarRowId = Number(payload);
  calendarRepo.toggleSync(calendarRowId);

  const calendars = calendarRepo.getCalendars(userId);
  const keyboard = buildCalendarPickerKeyboard(calendars, lang);
  await ctx.answer();
  await ctx.editText(t(lang).gcal_calendar_picker, { reply_markup: keyboard });
}
