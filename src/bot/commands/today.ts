// src/bot/commands/today.ts

import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleToday(ctx: BotCommandContext, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const now = new Date();
  const occurrences = eventService.getEventsForDay(user.telegram_id, now, user.timezone);
  const text = formatDayAgenda(occurrences, now.toISOString(), user.timezone, user.language);
  await ctx.send(text, { parse_mode: 'HTML' });
}
