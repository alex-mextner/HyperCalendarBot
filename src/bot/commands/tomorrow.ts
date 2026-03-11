// src/bot/commands/tomorrow.ts

import { addDays } from 'date-fns';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleTomorrow(ctx: BotCommandContext, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const tomorrow = addDays(new Date(), 1);
  const occurrences = eventService.getEventsForDay(user.telegram_id, tomorrow, user.timezone);
  const text = formatDayAgenda(occurrences, tomorrow.toISOString(), user.timezone, user.language);
  await ctx.send(text, { parse_mode: 'HTML' });
}
