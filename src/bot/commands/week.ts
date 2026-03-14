// src/bot/commands/week.ts

import { TZDate } from '@date-fns/tz';
import { startOfWeek } from 'date-fns';
import { InlineKeyboard } from 'gramio';
import { CB } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatWeekAgenda } from '../../services/event/formatters.ts';
import type { HolidayEntry, HolidayService } from '../../services/holiday/holiday-service.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import { getWeekRangeUtc } from '../../utils/date.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleWeek(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  renderService?: RenderService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const now = new Date();
  const { start, end } = getWeekRangeUtc(now, user.timezone);
  const occurrences = eventService.getEventsInRange(user.telegram_id, start, end);

  let holidaysByDate: Map<string, HolidayEntry[]> | undefined;
  if (holidayService) {
    holidaysByDate = new Map();
    const startD = new Date(start);
    for (let i = 0; i < 7; i++) {
      const d = new Date(startD.getTime() + i * 86400000);
      const dayKey = d.toISOString().slice(0, 10);
      const holidays = holidayService.getHolidaysForDate(user.telegram_id, dayKey);
      if (holidays.length > 0) {
        holidaysByDate.set(dayKey, holidays);
      }
    }
  }

  const text = formatWeekAgenda(occurrences, start, end, user.timezone, user.language, holidaysByDate);

  const params: { parse_mode: 'HTML'; reply_markup?: InlineKeyboard } = { parse_mode: 'HTML' };
  if (renderService) {
    const weekStartIso = startOfWeek(new TZDate(now, user.timezone), { weekStartsOn: 1 }).toISOString().slice(0, 10);
    params.reply_markup = new InlineKeyboard().text('📷', `${CB.IMG_WEEKLY}:${weekStartIso}`);
  }
  await ctx.send(text, params);
}
