// src/bot/commands/week.ts

import { TZDate } from '@date-fns/tz';
import { startOfWeek } from 'date-fns';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { EventOccurrence, User } from '../../database/types.ts';
import { enrichAgenda } from '../../services/event/agenda-enrichment.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatWeekAgenda } from '../../services/event/formatters.ts';
import type { HolidayEntry, HolidayService } from '../../services/holiday/holiday-service.ts';
import { formatWeekLabel } from '../../services/image/data-mapper.ts';
import type { ImageDelivery } from '../../services/image/image-delivery.ts';
import { queuePicture } from '../../services/image/queue-picture.ts';
import { weekImageJob } from '../../services/image/render-week.ts';
import type { DayWeather } from '../../services/weather/types.ts';
import type { WeatherService } from '../../services/weather/weather-service.ts';
import { getWeekRangeUtc, localCalendarWeekDays } from '../../utils/date.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';
import { sendAgendaText } from './agenda-text.ts';
import { commandPictureTransport } from './picture-transport.ts';

/** Holidays per local calendar day of the week starting at `start`; undefined when holidays are not configured. */
function collectWeekHolidays(
  holidayService: HolidayService | undefined,
  userId: number,
  start: string,
  timezone: string,
): Map<string, HolidayEntry[]> | undefined {
  if (!holidayService) return undefined;
  const holidaysByDate = new Map<string, HolidayEntry[]>();
  for (const dayKey of localCalendarWeekDays(start, timezone)) {
    const holidays = holidayService.getHolidaysForDate(userId, dayKey);
    if (holidays.length > 0) {
      holidaysByDate.set(dayKey, holidays);
    }
  }
  return holidaysByDate;
}

async function handleGroupWeek(
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
  const { start, end } = getWeekRangeUtc(now, timezone);
  const occurrences = enrichAgenda(
    eventService.getEventsInRangeForGroup(groupId, start, end),
    { userId: user.telegram_id, language: lang, groupId },
    eventService.agendaRepository,
  );

  const groupHolidaysByDate = collectWeekHolidays(holidayService, user.telegram_id, start, timezone);
  const weatherByDate = await fetchWeekWeatherByDate(weatherService, timezone, lang);
  const text = formatWeekAgenda(occurrences, start, end, timezone, lang, groupHolidaysByDate, weatherByDate);
  await sendAgendaText(ctx, text);
}

interface WeekImageInput {
  imageDelivery: ImageDelivery;
  /** The week's agenda as it is now; called when the picture is queued and again if the calendar changes while it renders. */
  load(): EventOccurrence[];
  weekStartIso: string;
  weatherByDate: { [date: string]: DayWeather } | undefined;
  user: User;
  lang: 'en' | 'ru';
}

/** Queue the week agenda picture (it is sent when ready); the text answer is already out. */
async function queueWeekImage(ctx: BotCommandContext, input: WeekImageInput): Promise<void> {
  const { imageDelivery, load, weekStartIso, weatherByDate, user, lang } = input;
  const chatId = user.telegram_id;
  await queuePicture(imageDelivery, {
    ...commandPictureTransport(ctx, chatId),
    language: lang,
    kind: 'week',
    label: formatWeekLabel(weekStartIso, lang),
    slot: `week:user:${chatId}:${weekStartIso}`,
    dataOwner: chatId,
    filename: 'week.png',
    buildJob: () => weekImageJob(load(), weekStartIso, user.timezone, lang, chatId, weatherByDate),
  });
}

export async function handleWeek(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  imageDelivery?: ImageDelivery,
  groupRepo?: GroupChatRepository,
  weatherService?: WeatherService,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';

  if (isGroup(ctx)) {
    await handleGroupWeek(ctx, user, lang, eventService, holidayService, groupRepo, weatherService);
    return;
  }

  const now = new Date();
  const { start, end } = getWeekRangeUtc(now, user.timezone);
  const load = () =>
    enrichAgenda(
      eventService.getEventsInRange(user.telegram_id, start, end),
      { userId: user.telegram_id, language: lang },
      eventService.agendaRepository,
    );
  const occurrences = load();

  const holidaysByDate = collectWeekHolidays(holidayService, user.telegram_id, start, user.timezone);
  const weatherByDate = await fetchWeekWeatherByDate(weatherService, user.timezone, lang);
  const text = formatWeekAgenda(occurrences, start, end, user.timezone, user.language, holidaysByDate, weatherByDate);
  await sendAgendaText(ctx, text);

  if (imageDelivery) {
    const weekStartIso = startOfWeek(new TZDate(now, user.timezone), { weekStartsOn: 1 }).toISOString().slice(0, 10);
    await queueWeekImage(ctx, { imageDelivery, load, weekStartIso, weatherByDate, user, lang });
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
