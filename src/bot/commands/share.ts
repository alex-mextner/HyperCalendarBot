// src/bot/commands/share.ts

import { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { PrivacyService } from '../../services/sharing/privacy-service.ts';
import { formatTime, formatTimeRange } from '../../utils/date.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { getGroupId, isGroup } from '../group-context.ts';
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
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const messages = t(lang);
  const userId = user.telegram_id;

  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx);
    if (groupId === null) return;
    const timezone = groupRepo?.getTimezone(groupId) ?? 'UTC';
    const occurrences = eventService.getUpcomingForGroup(groupId, 10);
    if (occurrences.length === 0) {
      await ctx.send(lang === 'ru' ? '📭 Нет событий в группе' : '📭 No group events');
      return;
    }
    const kb = new InlineKeyboard();
    for (const occ of occurrences) {
      const time = formatTime(occ.occurrence_start, timezone);
      kb.text(`${time} ${occ.event.title.slice(0, 20)}`, `${CB.SHARE_EVENT}:evt:${occ.event.id}`).row();
    }
    const header = lang === 'ru' ? '📤 <b>Поделиться</b>\n\nВыберите событие:' : '📤 <b>Share</b>\n\nSelect an event:';
    await ctx.send(header, { parse_mode: 'HTML', reply_markup: kb });
    return;
  }

  if (!ctx.args || ctx.args.trim() === '') {
    await showShareNavigator(ctx, eventService, user);
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

async function showShareNavigator(ctx: BotCommandContext, eventService: EventService, user: User): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const upcoming = eventService.getUpcoming(user.telegram_id, 5);

  const kb = new InlineKeyboard();

  // Period buttons row
  kb.text(lang === 'ru' ? '📅 Сегодня' : '📅 Today', `${CB.SHARE_EVENT}:today`);
  kb.text(lang === 'ru' ? '📅 Завтра' : '📅 Tomorrow', `${CB.SHARE_EVENT}:tomorrow`);
  kb.text(lang === 'ru' ? '📅 Неделя' : '📅 Week', `${CB.SHARE_EVENT}:week`);
  kb.row();

  // Upcoming events
  for (const event of upcoming) {
    const time = formatTime(event.start_at, user.timezone);
    const label = `${time} ${event.title}`;
    kb.text(label, `${CB.SHARE_EVENT}:evt:${event.id}`).row();
  }

  const header =
    lang === 'ru'
      ? '📤 <b>Поделиться</b>\n\nВыберите период или событие:'
      : '📤 <b>Share</b>\n\nPick a period or event:';

  await ctx.send(header, { parse_mode: 'HTML', reply_markup: kb });
}

async function showUsageHint(ctx: BotCommandContext, lang: 'en' | 'ru'): Promise<void> {
  await ctx.send(
    lang === 'ru'
      ? '❓ Укажите период: today, tomorrow, week или event <id>'
      : '❓ Specify period: today, tomorrow, week or event <id>',
  );
}
