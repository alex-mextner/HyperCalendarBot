// src/bot/commands/today.ts

import { TZDate } from '@date-fns/tz';
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
import { commandPictureTransport, pinPicture } from './picture-transport.ts';

async function fetchTodayWeather(
  weatherService: WeatherService | undefined,
  timezone: string,
  lang: 'en' | 'ru',
): Promise<DayWeather | null> {
  if (!weatherService) return null;
  return weatherService.getDayWeather(timezone, lang === 'ru' ? 'ru' : 'en');
}

async function handleGroupToday(
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
  const now = new Date();
  const tzNow = new TZDate(now, timezone);
  const dayStart = new TZDate(new Date(tzNow.getFullYear(), tzNow.getMonth(), tzNow.getDate(), 0, 0, 0), timezone);
  const dayEnd = new TZDate(
    new Date(tzNow.getFullYear(), tzNow.getMonth(), tzNow.getDate(), 23, 59, 59, 999),
    timezone,
  );
  const occurrences = enrichAgenda(
    eventService.getEventsInRangeForGroup(groupId, dayStart.toISOString(), dayEnd.toISOString()),
    { userId: user.telegram_id, language: lang, groupId },
    eventService.agendaRepository,
  );
  const holidays = holidayService?.getHolidaysForDate(user.telegram_id, tzNow.toISOString().slice(0, 10)) ?? [];
  const dayWeather = await fetchTodayWeather(weatherService, timezone, lang);
  const text = formatDayAgenda(occurrences, now.toISOString(), timezone, lang, holidays, undefined, dayWeather);
  await sendAgendaText(ctx, text);
}

interface TodayImageInput {
  imageDelivery: ImageDelivery;
  /** The agenda as it is now; called when the picture is queued and again if the calendar changes while it renders. */
  load(): { occurrences: EventOccurrence[]; holidays: HolidayEntry[] };
  dateIso: string;
  user: User;
  groupRepo: GroupChatRepository | undefined;
  lang: 'en' | 'ru';
}

/** Queue today's agenda picture (it is sent and pinned when ready); the text answer is already out. */
async function queueTodayImage(ctx: BotCommandContext, input: TodayImageInput): Promise<void> {
  const { imageDelivery, load, dateIso, user, groupRepo, lang } = input;
  const chatId = user.telegram_id;
  await queuePicture(imageDelivery, {
    ...commandPictureTransport(ctx, chatId),
    language: lang,
    kind: 'day',
    label: dateIso,
    slot: `day:user:${chatId}:${dateIso}`,
    dataOwner: chatId,
    filename: 'today.png',
    buildJob: () => {
      const { occurrences, holidays } = load();
      return dayImageJob(occurrences, dateIso, user.timezone, lang, chatId, holidays);
    },
    onSent: (messageId) => pinPicture(ctx, chatId, messageId, groupRepo, false),
  });
}

export async function handleToday(
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
    await handleGroupToday(ctx, user, lang, eventService, holidayService, groupRepo, weatherService);
    return;
  }

  const now = new Date();
  const dateIso = new TZDate(now, user.timezone).toISOString().slice(0, 10);
  const load = () => ({
    occurrences: enrichAgenda(
      eventService.getEventsForDay(user.telegram_id, now, user.timezone),
      { userId: user.telegram_id, language: lang },
      eventService.agendaRepository,
    ),
    holidays: holidayService?.getHolidaysForDate(user.telegram_id, dateIso) ?? [],
  });
  const { occurrences, holidays } = load();
  const calendarColors = buildCalendarColorMap(googleCalendarRepo, user.telegram_id);
  const dayWeather = await fetchTodayWeather(weatherService, user.timezone, lang);
  const text = formatDayAgenda(
    occurrences,
    now.toISOString(),
    user.timezone,
    user.language,
    holidays,
    calendarColors,
    dayWeather,
  );

  await sendAgendaText(ctx, text);

  if (imageDelivery) {
    await queueTodayImage(ctx, { imageDelivery, load, dateIso, user, groupRepo, lang });
  }
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
