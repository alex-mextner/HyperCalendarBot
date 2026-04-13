// src/bot/commands/week.ts

import { TZDate } from '@date-fns/tz';
import { startOfWeek } from 'date-fns';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatWeekAgenda } from '../../services/event/formatters.ts';
import type { HolidayEntry, HolidayService } from '../../services/holiday/holiday-service.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import { renderWeekImage } from '../../services/image/render-week.ts';
import type { DayWeather } from '../../services/weather/types.ts';
import type { WeatherService } from '../../services/weather/weather-service.ts';
import { getWeekRangeUtc, localCalendarWeekDays } from '../../utils/date.ts';
import { imageLogger } from '../../utils/logger.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleWeek(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  renderService?: RenderService,
  groupRepo?: GroupChatRepository,
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
    const now = new Date();
    const { start, end } = getWeekRangeUtc(now, timezone);
    const occurrences = eventService.getEventsInRangeForGroup(groupId, start, end);

    let groupHolidaysByDate: Map<string, HolidayEntry[]> | undefined;
    if (holidayService) {
      groupHolidaysByDate = new Map();
      for (const dayKey of localCalendarWeekDays(start, timezone)) {
        const holidays = holidayService.getHolidaysForDate(user.telegram_id, dayKey);
        if (holidays.length > 0) {
          groupHolidaysByDate.set(dayKey, holidays);
        }
      }
    }

    const weatherByDate = await fetchWeekWeatherByDate(weatherService, timezone, lang);
    const text = formatWeekAgenda(occurrences, start, end, timezone, lang, groupHolidaysByDate, weatherByDate);
    await ctx.send(text, { parse_mode: 'HTML' });
    return;
  }

  const now = new Date();
  const { start, end } = getWeekRangeUtc(now, user.timezone);
  const occurrences = eventService.getEventsInRange(user.telegram_id, start, end);

  let holidaysByDate: Map<string, HolidayEntry[]> | undefined;
  if (holidayService) {
    holidaysByDate = new Map();
    for (const dayKey of localCalendarWeekDays(start, user.timezone)) {
      const holidays = holidayService.getHolidaysForDate(user.telegram_id, dayKey);
      if (holidays.length > 0) {
        holidaysByDate.set(dayKey, holidays);
      }
    }
  }

  const weatherByDate = await fetchWeekWeatherByDate(weatherService, user.timezone, lang);
  const text = formatWeekAgenda(occurrences, start, end, user.timezone, user.language, holidaysByDate, weatherByDate);
  await ctx.send(text, { parse_mode: 'HTML' });

  if (renderService) {
    try {
      const weekStartIso = startOfWeek(new TZDate(now, user.timezone), { weekStartsOn: 1 }).toISOString().slice(0, 10);
      const buffer = await renderWeekImage(
        renderService,
        occurrences,
        weekStartIso,
        user.timezone,
        user.language as 'ru' | 'en',
        user.telegram_id,
        weatherByDate,
      );
      const file = new File([buffer], 'week.png', { type: 'image/png' });
      await ctx.sendPhoto(file);
    } catch (err) {
      imageLogger.error({ error: (err as Error).message }, 'Render failed');
    }
  }
}

async function fetchWeekWeatherByDate(
  weatherService: WeatherService | undefined,
  timezone: string,
  lang: string,
): Promise<{ [date: string]: DayWeather } | undefined> {
  if (!weatherService) return undefined;
  const week = await weatherService.getWeekWeather(timezone, lang === 'ru' ? 'ru' : 'en');
  if (!week) return undefined;
  const map: { [date: string]: DayWeather } = {};
  for (const day of week.days) {
    map[day.date] = day;
  }
  return map;
}
