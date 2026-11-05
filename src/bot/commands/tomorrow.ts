// src/bot/commands/tomorrow.ts

import { TZDate } from '@date-fns/tz';
import { addDays } from 'date-fns';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { EventOccurrence, User } from '../../database/types.ts';
import { enrichAgenda } from '../../services/event/agenda-enrichment.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import { googleCalendarColorEmoji } from '../../services/google/calendar-colors.ts';
import type { HolidayEntry, HolidayService } from '../../services/holiday/holiday-service.ts';
import type { ImageDelivery } from '../../services/image/image-delivery.ts';
import { queuePicture } from '../../services/image/queue-picture.ts';
import { dayImageJob } from '../../services/image/render-day.ts';
import type { DayWeather } from '../../services/weather/types.ts';
import type { WeatherService } from '../../services/weather/weather-service.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';
import { sendAgendaText } from './agenda-text.ts';
import { commandPictureTransport } from './picture-transport.ts';

async function handleGroupTomorrow(
  ctx: BotCommandContext,
  user: User,
  lang: 'en' | 'ru',
  eventService: EventService,
  holidayService?: HolidayService,
  groupRepo?: GroupChatRepository,
  weatherService?: WeatherService,
): Promise<void> {
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
}

interface TomorrowImageInput {
  imageDelivery: ImageDelivery;
  /** The agenda as it is now; called when the picture is queued and again if the calendar changes while it renders. */
  load(): { occurrences: EventOccurrence[]; holidays: HolidayEntry[] };
  dateIso: string;
  user: User;
  lang: 'en' | 'ru';
}

/** Queue tomorrow's agenda picture (it is sent when ready); the text answer is already out. */
async function queueTomorrowImage(ctx: BotCommandContext, input: TomorrowImageInput): Promise<void> {
  const { imageDelivery, load, dateIso, user, lang } = input;
  const chatId = user.telegram_id;
  await queuePicture(imageDelivery, {
    ...commandPictureTransport(ctx, chatId),
    language: lang,
    kind: 'day',
    label: dateIso,
    slot: `day:user:${chatId}:${dateIso}`,
    dataOwner: chatId,
    filename: 'tomorrow.png',
    buildJob: () => {
      const { occurrences, holidays } = load();
      return dayImageJob(occurrences, dateIso, user.timezone, lang, chatId, holidays);
    },
  });
}

export async function handleTomorrow(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  imageDelivery?: ImageDelivery,
  groupRepo?: GroupChatRepository,
  googleCalendarRepo?: GoogleCalendarRepository,
  weatherService?: WeatherService,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';

  if (isGroup(ctx)) {
    await handleGroupTomorrow(ctx, user, lang, eventService, holidayService, groupRepo, weatherService);
    return;
  }

  const tomorrow = addDays(new Date(), 1);
  const dateIso = new TZDate(tomorrow, user.timezone).toISOString().slice(0, 10);
  const load = () => ({
    occurrences: enrichAgenda(
      eventService.getEventsForDay(user.telegram_id, tomorrow, user.timezone),
      { userId: user.telegram_id, language: lang },
      eventService.agendaRepository,
    ),
    holidays: holidayService?.getHolidaysForDate(user.telegram_id, dateIso) ?? [],
  });
  const { occurrences, holidays } = load();
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

  if (imageDelivery) {
    await queueTomorrowImage(ctx, { imageDelivery, load, dateIso, user, lang });
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
