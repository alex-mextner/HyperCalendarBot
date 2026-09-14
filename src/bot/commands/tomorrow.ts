import { enrichAgenda } from '../../services/event/agenda-enrichment.ts';
import { agendaImageErrorMessage, sendAgendaImage } from '../../utils/agenda-image.ts';
// src/bot/commands/tomorrow.ts

import { TZDate } from '@date-fns/tz';
import { addDays } from 'date-fns';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import { googleCalendarColorEmoji } from '../../services/google/calendar-colors.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { renderDayImage } from '../../services/image/render-day.ts';
import type { ImageRenderer } from '../../services/image/render-service.ts';
import type { DayWeather } from '../../services/weather/types.ts';
import type { WeatherService } from '../../services/weather/weather-service.ts';
import { imageLogger } from '../../utils/logger.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';
import { sendAgendaText } from './agenda-text.ts';

export async function handleTomorrow(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  renderService?: ImageRenderer,
  groupRepo?: GroupChatRepository,
  googleCalendarRepo?: GoogleCalendarRepository,
  weatherService?: WeatherService,
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
        lang === 'ru'
          ? '⚙️ Сначала задайте таймзону группы через /settings'
          : '⚙️ Set the group timezone first via /settings',
      );
      return;
    }
    const tzNow = new TZDate(new Date(), timezone);
    const tzTomorrow = addDays(tzNow, 1);
    const dayStart = new TZDate(
      new Date(tzTomorrow.getFullYear(), tzTomorrow.getMonth(), tzTomorrow.getDate(), 0, 0, 0),
      timezone,
    );
    const dayEnd = new TZDate(
      new Date(tzTomorrow.getFullYear(), tzTomorrow.getMonth(), tzTomorrow.getDate(), 23, 59, 59, 999),
      timezone,
    );
    const occurrences = enrichAgenda(
      eventService.getEventsInRangeForGroup(groupId, dayStart.toISOString(), dayEnd.toISOString()),
      { userId: user.telegram_id, language: lang, groupId },
      eventService.agendaRepository,
    );
    const holidays = holidayService?.getHolidaysForDate(user.telegram_id, dayStart.toISOString().slice(0, 10)) ?? [];
    const dayWeather = await fetchDayForecast(weatherService, timezone, dayStart.toISOString().slice(0, 10), lang);
    const text = formatDayAgenda(occurrences, dayStart.toISOString(), timezone, lang, holidays, undefined, dayWeather);
    await sendAgendaText(ctx, text);
    return;
  }

  const tomorrow = addDays(new Date(), 1);
  const occurrences = enrichAgenda(
    eventService.getEventsForDay(user.telegram_id, tomorrow, user.timezone),
    { userId: user.telegram_id, language: lang },
    eventService.agendaRepository,
  );
  const dateIso = new TZDate(tomorrow, user.timezone).toISOString().slice(0, 10);
  const holidays = holidayService?.getHolidaysForDate(user.telegram_id, dateIso) ?? [];
  const calendarColors = buildCalendarColorMap(googleCalendarRepo, user.telegram_id);
  const dayWeather = await fetchDayForecast(weatherService, user.timezone, dateIso, lang);
  const text = formatDayAgenda(
    occurrences,
    tomorrow.toISOString(),
    user.timezone,
    user.language,
    holidays,
    calendarColors,
    dayWeather,
  );

  await sendAgendaText(ctx, text);

  if (renderService) {
    try {
      const buffer = await renderDayImage(
        renderService,
        occurrences,
        dateIso,
        user.timezone,
        user.language as 'ru' | 'en',
        user.telegram_id,
        holidays,
      );
      const file = new File([buffer], 'tomorrow.png', { type: 'image/png' });
      await sendAgendaImage(file, {
        language: user.language,
        sendPhoto: (photo) => ctx.sendPhoto(photo),
        sendDocument: (document, options) => ctx.sendDocument(document, options),
      });
    } catch (err) {
      imageLogger.error({ err }, 'Render failed');
      await ctx.send(
        agendaImageErrorMessage(err) ?? 'Agenda image could not be generated. Choose a shorter date range.',
      );
    }
  }
}

async function fetchDayForecast(
  weatherService: WeatherService | undefined,
  timezone: string,
  dateIso: string,
  lang: string,
): Promise<DayWeather | null> {
  if (!weatherService) return null;
  const week = await weatherService.getWeekWeather(timezone, lang === 'ru' ? 'ru' : 'en');
  if (!week) return null;
  return week.days.find((d) => d.date === dateIso) ?? null;
}

function buildCalendarColorMap(
  repo: GoogleCalendarRepository | undefined,
  userId: number,
): Map<string, string> | undefined {
  if (!repo) return undefined;
  const calendars = repo.getCalendars(userId);
  if (calendars.length === 0) return undefined;
  const map = new Map<string, string>();
  for (const cal of calendars) {
    const emoji = googleCalendarColorEmoji(cal.color);
    if (emoji) map.set(cal.google_calendar_id, emoji);
  }
  return map.size > 0 ? map : undefined;
}
