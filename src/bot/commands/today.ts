import { enrichAgenda } from '../../services/event/agenda-enrichment.ts';
import { agendaImageErrorMessage, sendAgendaImage } from '../../utils/agenda-image.ts';
// src/bot/commands/today.ts

import { TZDate } from '@date-fns/tz';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import { googleCalendarColorEmoji } from '../../services/google/calendar-colors.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { renderDayImage } from '../../services/image/render-day.ts';
import type { ImageRenderer } from '../../services/image/render-service.ts';
import type { WeatherService } from '../../services/weather/weather-service.ts';
import { autoPin } from '../../utils/auto-pin.ts';
import { imageLogger } from '../../utils/logger.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';
import { sendAgendaText } from './agenda-text.ts';

export async function handleToday(
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
    const dayWeather = weatherService
      ? await weatherService.getDayWeather(timezone, lang === 'ru' ? 'ru' : 'en')
      : null;
    const text = formatDayAgenda(occurrences, now.toISOString(), timezone, lang, holidays, undefined, dayWeather);
    await sendAgendaText(ctx, text);
    return;
  }

  const now = new Date();
  const occurrences = enrichAgenda(
    eventService.getEventsForDay(user.telegram_id, now, user.timezone),
    { userId: user.telegram_id, language: lang },
    eventService.agendaRepository,
  );
  const dateIso = new TZDate(now, user.timezone).toISOString().slice(0, 10);
  const holidays = holidayService?.getHolidaysForDate(user.telegram_id, dateIso) ?? [];
  const calendarColors = buildCalendarColorMap(googleCalendarRepo, user.telegram_id);
  const dayWeather = weatherService
    ? await weatherService.getDayWeather(user.timezone, lang === 'ru' ? 'ru' : 'en')
    : null;
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
      const file = new File([buffer], 'today.png', { type: 'image/png' });
      const sent = await sendAgendaImage(file, {
        language: user.language,
        sendPhoto: (photo) => ctx.sendPhoto(photo),
        sendDocument: (document, options) => ctx.sendDocument(document, options),
      });
      autoPin(user.telegram_id, sent.id, {
        pinChatMessage: (chatId, messageId, options) =>
          ctx.bot.api.pinChatMessage({
            chat_id: chatId,
            message_id: messageId,
            disable_notification: options.disable_notification,
          }),
        sendMessage: async (chatId, text) => {
          await ctx.bot.api.sendMessage({ chat_id: chatId, text });
        },
        isGroupChat: false,
        groupChatRepo: groupRepo,
      }).catch((err) => {
        imageLogger.error({ err }, 'autoPin failed');
      });
    } catch (err) {
      imageLogger.error({ err }, 'Render failed');
      await ctx.send(
        agendaImageErrorMessage(err) ?? 'Agenda image could not be generated. Choose a shorter date range.',
      );
    }
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
