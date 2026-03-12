// src/bot/commands/free.ts

import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { formatDateHeader, formatTime, parseSimpleDate } from '../../utils/date.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleFree(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const args = (ctx.args as string)?.trim();

  let date = new Date();
  if (args) {
    const parsed = parseSimpleDate(`${args} 00:00`, user.timezone);
    if (parsed) date = parsed;
  }

  if (holidayService?.isDayOff(user.telegram_id, date.toISOString().slice(0, 10))) {
    const dateLabel = formatDateHeader(date.toISOString(), user.timezone, lang);
    await ctx.send(`${dateLabel}\n\n${t(lang).holidays_day_off}`);
    return;
  }

  const slots = eventService.getFreeSlots(user.telegram_id, date, user.timezone);

  if (slots.length === 0) {
    await ctx.send(lang === 'ru' ? 'Весь день занят!' : 'Full day busy!');
    return;
  }

  const dateLabel = formatDateHeader(date.toISOString(), user.timezone, lang);
  const lines = slots.map((s) => {
    const start = formatTime(s.start, user.timezone);
    const end = formatTime(s.end, user.timezone);
    const hours = Math.floor(s.durationMinutes / 60);
    const mins = s.durationMinutes % 60;
    const duration = hours > 0 ? (mins > 0 ? `${hours}h${mins}m` : `${hours}h`) : `${mins}m`;
    return `  ${start}–${end}  (${duration})`;
  });

  await ctx.send(`${t(lang).free_header(dateLabel)}\n\n${lines.join('\n')}`);
}
