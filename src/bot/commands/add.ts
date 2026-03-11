// src/bot/commands/add.ts

import { addMinutes } from 'date-fns';
import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseDuration, parseSimpleDate } from '../../utils/date.ts';
import { eventActionsKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';
import { clearSession, getSession, setSession } from '../types.ts';

export async function handleAdd(ctx: BotCommandContext, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const args = ctx.args as string | undefined;

  if (args && args.trim().length > 0) {
    // Quick format: /add Title tomorrow at 15:00
    return handleQuickAdd(ctx, eventService, user, args.trim());
  }

  // Start wizard
  setSession(user.telegram_id, 'add:title');
  await ctx.send(t(lang).add_title_prompt);
}

async function handleQuickAdd(
  ctx: BotCommandContext,
  eventService: EventService,
  user: User,
  input: string,
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
    // Couldn't parse — fall back to wizard
    setSession(user.telegram_id, 'add:title');
    await ctx.send(t(lang).add_title_prompt);
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

/**
 * Handle wizard steps for /add (called from message handler)
 */
export async function handleAddWizardStep(
  ctx: BotCommandContext,
  eventService: EventService,
  user: User,
  text: string,
): Promise<boolean> {
  const session = getSession(user.telegram_id);
  if (!session || !session.step.startsWith('add:')) return false;
  const lang = user.language as 'en' | 'ru';

  if (session.step === 'add:title') {
    setSession(user.telegram_id, 'add:time', { ...session.data, title: text });
    await ctx.send(t(lang).add_time_prompt);
    return true;
  }

  if (session.step === 'add:time') {
    const parsed = parseSimpleDate(text, user.timezone);
    if (!parsed) {
      await ctx.send(
        lang === 'ru'
          ? 'Не могу разобрать дату. Попробуйте: "завтра 15:00"'
          : 'Can\'t parse that date. Try: "tomorrow 15:00"',
      );
      return true;
    }
    setSession(user.telegram_id, 'add:duration', { ...session.data, start_at: parsed.toISOString() });
    await ctx.send(t(lang).add_duration_prompt);
    return true;
  }

  if (session.step === 'add:duration') {
    const title = session.data.title as string;
    const startAt = session.data.start_at as string;
    let endAt: string | undefined;

    if (text.toLowerCase() !== 'skip' && text.toLowerCase() !== 'пропустить') {
      const mins = parseDuration(text);
      if (mins) {
        endAt = addMinutes(new Date(startAt), mins).toISOString();
      }
    }

    const event = eventService.createEvent({
      user_id: user.telegram_id,
      title,
      start_at: startAt,
      end_at: endAt,
      timezone: user.timezone,
    });

    clearSession(user.telegram_id);
    const detail = formatEventDetail(event, user.timezone, lang);
    await ctx.send(`${t(lang).event_created(title)}\n\n${detail}`, {
      parse_mode: 'HTML',
      reply_markup: eventActionsKeyboard(event.id, lang),
    });
    return true;
  }

  return false;
}
