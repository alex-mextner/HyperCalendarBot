// src/bot/commands/week.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { formatWeekAgenda } from '../../services/event/formatters.ts';
import { getWeekRangeUtc } from '../../utils/date.ts';

export async function handleWeek(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const now = new Date();
  const { start, end } = getWeekRangeUtc(now, user.timezone);
  const occurrences = eventService.getEventsInRange(user.telegram_id, start, end);
  const text = formatWeekAgenda(occurrences, start, end, user.timezone, user.language);
  await ctx.send(text, { parse_mode: 'HTML' });
}
