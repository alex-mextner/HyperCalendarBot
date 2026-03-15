// src/bot/commands/share.ts

import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { PrivacyService } from '../../services/sharing/privacy-service.ts';
import { formatTimeRange } from '../../utils/date.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import type { BotCommandContext } from '../types.ts';

type Period = 'today' | 'tomorrow' | 'week';
const VALID_PERIODS = new Set<Period>(['today', 'tomorrow', 'week']);

function isPeriod(value: string): value is Period {
  return VALID_PERIODS.has(value as Period);
}

export async function handleShare(
  ctx: BotCommandContext,
  eventService: EventService,
  privacyService: PrivacyService,
  deepLinkService: DeepLinkService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const messages = t(lang);
  const userId = user.telegram_id;

  if (!ctx.args || ctx.args.trim() === '') {
    await ctx.send(
      lang === 'ru'
        ? '📤 Использование:\n<code>/share today</code> — поделиться повесткой на сегодня\n<code>/share tomorrow</code> — на завтра\n<code>/share week</code> — на неделю\n<code>/share event &lt;id&gt;</code> — поделиться событием'
        : "📤 Usage:\n<code>/share today</code> — share today's agenda\n<code>/share tomorrow</code> — tomorrow\n<code>/share week</code> — this week\n<code>/share event &lt;id&gt;</code> — share a single event",
      { parse_mode: 'HTML' },
    );
    return;
  }

  const parts = ctx.args.trim().toLowerCase().split(/\s+/);
  const command = parts[0];

  // Handle "event <id>" subcommand
  if (command === 'event') {
    const eventId = Number.parseInt(parts[1], 10);
    if (Number.isNaN(eventId)) {
      await showUsageHint(ctx, lang);
      return;
    }
    await shareEvent(ctx, eventService, privacyService, deepLinkService, userId, eventId, lang);
    return;
  }

  // Handle period-based agenda sharing
  if (isPeriod(command)) {
    await shareAgenda(ctx, eventService, privacyService, userId, command, user.timezone, messages);
    return;
  }

  // Unknown subcommand
  await showUsageHint(ctx, lang);
}

async function shareAgenda(
  ctx: BotCommandContext,
  eventService: EventService,
  privacyService: PrivacyService,
  userId: number,
  period: Period,
  timezone: string,
  messages: ReturnType<typeof t>,
): Promise<void> {
  const date = new Date();
  if (period === 'tomorrow') date.setDate(date.getDate() + 1);

  const occurrences =
    period === 'week'
      ? eventService.getEventsForWeek(userId, date, timezone)
      : eventService.getEventsForDay(userId, date, timezone);

  // Filter by visibility — exclude private events
  const shareable = occurrences.filter((occ) => {
    const visibility = privacyService.resolveVisibility(userId, occ.event.id);
    return visibility !== 'private';
  });

  if (shareable.length === 0) {
    await ctx.send(messages.no_events_to_share);
    return;
  }

  const lines = shareable.map((occ) => {
    const visibility = privacyService.resolveVisibility(userId, occ.event.id);
    const time = formatTimeRange(occ.occurrence_start, occ.occurrence_end, timezone);
    if (visibility === 'free_busy') {
      return `  ${time}  ⬛ Busy`;
    }
    return `  ${time}  ${escapeHtml(occ.event.title)}`;
  });

  const text = `${messages.share_preview}\n\n${lines.join('\n')}`;
  await ctx.send(text, { parse_mode: 'HTML' });
}

async function shareEvent(
  ctx: BotCommandContext,
  eventService: EventService,
  privacyService: PrivacyService,
  deepLinkService: DeepLinkService,
  userId: number,
  eventId: number,
  lang: 'en' | 'ru',
): Promise<void> {
  const event = eventService.getEvent(eventId, userId);
  if (!event) {
    const msg = lang === 'ru' ? '❌ Событие не найдено (not found)' : '❌ Event not found';
    await ctx.send(msg);
    return;
  }

  const visibility = privacyService.resolveVisibility(userId, eventId);
  if (visibility === 'private') {
    const msg =
      lang === 'ru'
        ? '🔒 Это событие помечено как private. Измените видимость через /privacy перед тем, как делиться.'
        : '🔒 This event is marked as private. Change visibility via /privacy before sharing.';
    await ctx.send(msg);
    return;
  }

  const link = deepLinkService.createShareLink(eventId, userId);
  const url = deepLinkService.generateUrl(link.code, 'bot');

  const title = visibility === 'free_busy' ? 'Busy' : escapeHtml(event.title);
  const time = formatTimeRange(event.start_at, event.end_at, 'UTC');

  const text = [t(lang).share_preview, '', `  ${time}  ${title}`, '', `🔗 ${url}`].join('\n');

  await ctx.send(text, { parse_mode: 'HTML' });
}

async function showUsageHint(ctx: BotCommandContext, lang: 'en' | 'ru'): Promise<void> {
  await ctx.send(
    lang === 'ru'
      ? '❓ Укажите период: today, tomorrow, week или event <id>'
      : '❓ Specify period: today, tomorrow, week or event <id>',
  );
}
