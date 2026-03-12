// src/bot/commands/tomorrow.ts

import { addDays } from 'date-fns';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleTomorrow(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const tomorrow = addDays(new Date(), 1);
  const occurrences = eventService.getEventsForDay(user.telegram_id, tomorrow, user.timezone);
  const holidays = holidayService?.getHolidaysForDate(user.telegram_id, tomorrow.toISOString().slice(0, 10)) ?? [];
  const text = formatDayAgenda(occurrences, tomorrow.toISOString(), user.timezone, user.language, holidays);
  await ctx.send(text, { parse_mode: 'HTML' });
}
