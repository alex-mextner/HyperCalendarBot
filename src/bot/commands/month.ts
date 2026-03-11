// src/bot/commands/month.ts

import { TZDate } from '@date-fns/tz';
import { endOfMonth, format, getDay, getDaysInMonth, startOfMonth } from 'date-fns';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { monthNavKeyboard } from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export async function handleMonth(
  ctx: BotCommandContext | BotCallbackContext,
  eventService: EventService,
  yearMonth?: string,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  let refDate: Date;
  if (yearMonth) {
    const [y, m] = yearMonth.split('-').map(Number) as [number, number];
    refDate = new TZDate(y, m - 1, 1, 0, 0, 0, 0, user.timezone);
  } else {
    refDate = TZDate.tz(user.timezone);
  }

  const monthStart = startOfMonth(refDate);
  const monthEnd = endOfMonth(refDate);
  const monthLabel = format(monthStart, lang === 'ru' ? 'LLLL yyyy' : 'MMMM yyyy');
  const daysInMonth = getDaysInMonth(monthStart);

  // Count events per day — single range query for the whole month, then bucket
  const monthStartUtc = new TZDate(
    monthStart.getFullYear(),
    monthStart.getMonth(),
    1,
    0,
    0,
    0,
    0,
    user.timezone,
  ).toISOString();
  const monthEndUtc = new TZDate(
    monthEnd.getFullYear(),
    monthEnd.getMonth(),
    daysInMonth,
    23,
    59,
    59,
    999,
    user.timezone,
  ).toISOString();
  const allOccurrences = eventService.getEventsInRange(user.telegram_id, monthStartUtc, monthEndUtc);

  const eventCounts: Record<number, number> = {};
  for (const occ of allOccurrences) {
    const localDate = new TZDate(occ.occurrence_start, user.timezone);
    const day = localDate.getDate();
    eventCounts[day] = (eventCounts[day] ?? 0) + 1;
  }

  // Build calendar grid
  const header = 'Mo Tu We Th Fr Sa Su';
  const firstDayOfWeek = (getDay(monthStart) + 6) % 7; // 0=Mon
  let grid = '';

  // Pad first week
  for (let i = 0; i < firstDayOfWeek; i++) grid += '   ';

  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = String(d).padStart(2, ' ');
    grid += `${dayStr} `;
    if ((firstDayOfWeek + d) % 7 === 0) grid += '\n';
  }

  // Event counts summary
  const countLines = Object.entries(eventCounts)
    .map(([d, c]) => `${d}·${c}`)
    .join('  ');

  const ym = format(monthStart, 'yyyy-MM');
  const text = `📅 ${monthLabel}\n\n<code>${header}\n${grid.trimEnd()}</code>\n\n${countLines ? `Events: ${countLines}` : 'No events this month.'}`;

  if (yearMonth) {
    await (ctx as BotCallbackContext).editText(text, {
      parse_mode: 'HTML',
      reply_markup: monthNavKeyboard(ym),
    });
  } else {
    await ctx.send(text, {
      parse_mode: 'HTML',
      reply_markup: monthNavKeyboard(ym),
    });
  }
}
