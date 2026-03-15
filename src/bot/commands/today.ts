// src/bot/commands/today.ts

import { TZDate } from '@date-fns/tz';
import { InlineKeyboard } from 'gramio';
import { CB } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleToday(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  renderService?: RenderService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const now = new Date();
  const occurrences = eventService.getEventsForDay(user.telegram_id, now, user.timezone);
  const dateIso = new TZDate(now, user.timezone).toISOString().slice(0, 10);
  const holidays = holidayService?.getHolidaysForDate(user.telegram_id, dateIso) ?? [];
  const text = formatDayAgenda(occurrences, now.toISOString(), user.timezone, user.language, holidays);

  const params: { parse_mode: 'HTML'; reply_markup?: InlineKeyboard } = { parse_mode: 'HTML' };
  if (renderService) {
    params.reply_markup = new InlineKeyboard().text('📷', `${CB.IMG_DAILY}:${dateIso}`);
  }
  await ctx.send(text, params);
}
