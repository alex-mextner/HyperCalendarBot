// src/bot/commands/add.ts

import type { AnyScene } from '@gramio/scenes';
import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseSimpleDate } from '../../utils/date.ts';
import { eventActionsKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleAdd(
  ctx: BotCommandContext,
  eventService: EventService,
  addEventScene: AnyScene,
): Promise<void> {
  const user = ctx.dbUser as User;
  const args = ctx.args as string | undefined;

  if (args && args.trim().length > 0) {
    return handleQuickAdd(ctx, eventService, user, args.trim(), addEventScene);
  }

  await ctx.scene.enter(addEventScene);
}

async function handleQuickAdd(
  ctx: BotCommandContext,
  eventService: EventService,
  user: User,
  input: string,
  addEventScene: AnyScene,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';

  // Try to parse "Title <date expression>"
  // Strategy: last part matching a date pattern is the date, rest is title
  const words = input.split(' ');
  let title = '';
  let dateStr = '';

  // Try progressively: last 3 words as date, then last 2, then last 1
  for (let dateWords = 3; dateWords >= 1; dateWords--) {
    if (words.length <= dateWords) continue;
    const candidate = words.slice(-dateWords).join(' ');
    const parsed = parseSimpleDate(candidate, user.timezone);
    if (parsed) {
      title = words.slice(0, -dateWords).join(' ');
      dateStr = candidate;
      break;
    }
  }

  if (!title || !dateStr) {
    await ctx.scene.enter(addEventScene);
    return;
  }

  const startDate = parseSimpleDate(dateStr, user.timezone)!;
  const event = eventService.createEvent({
    user_id: user.telegram_id,
    title,
    start_at: startDate.toISOString(),
    timezone: user.timezone,
  });

  const detail = formatEventDetail(event, user.timezone, lang);
  await ctx.send(`${t(lang).event_created(title)}\n\n${detail}`, {
    parse_mode: 'HTML',
    reply_markup: eventActionsKeyboard(event.id, lang),
  });
}
