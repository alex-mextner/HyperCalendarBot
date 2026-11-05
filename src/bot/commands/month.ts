// src/bot/commands/month.ts

import { TZDate } from '@date-fns/tz';
import { endOfMonth, format, getDay, getDaysInMonth, startOfMonth } from 'date-fns';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { EventOccurrence, User } from '../../database/types.ts';
import { enrichAgenda } from '../../services/event/agenda-enrichment.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { ImageDelivery } from '../../services/image/image-delivery.ts';
import { queuePicture } from '../../services/image/queue-picture.ts';
import { monthImageJob } from '../../services/image/render-month.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import { monthNavKeyboard } from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';
import { isCallbackContext } from '../types.ts';
import { commandPictureTransport, pinPicture } from './picture-transport.ts';

/** Calendar month being shown, with the UTC bounds used for the single range query over it. */
interface MonthWindow {
  monthStart: Date;
  daysInMonth: number;
  monthLabel: string;
  monthStartUtc: string;
  monthEndUtc: string;
}

function resolveMonthWindow(yearMonth: string | undefined, timezone: string, lang: 'en' | 'ru'): MonthWindow {
  let refDate: Date;
  if (yearMonth) {
    const [y, m] = yearMonth.split('-').map(Number) as [number, number];
    refDate = new TZDate(y, m - 1, 1, 0, 0, 0, 0, timezone);
  } else {
    refDate = TZDate.tz(timezone);
  }

  const monthStart = startOfMonth(refDate);
  const monthEnd = endOfMonth(refDate);
  const monthLabel = format(monthStart, lang === 'ru' ? 'LLLL yyyy' : 'MMMM yyyy');
  const daysInMonth = getDaysInMonth(monthStart);

  const monthStartUtc = new TZDate(
    monthStart.getFullYear(),
    monthStart.getMonth(),
    1,
    0,
    0,
    0,
    0,
    timezone,
  ).toISOString();
  const monthEndUtc = new TZDate(
    monthEnd.getFullYear(),
    monthEnd.getMonth(),
    daysInMonth,
    23,
    59,
    59,
    999,
    timezone,
  ).toISOString();
  return { monthStart, daysInMonth, monthLabel, monthStartUtc, monthEndUtc };
}

/** Occurrences per local day-of-month. */
function countEventsPerDay(occurrences: EventOccurrence[], timezone: string): Record<number, number> {
  const eventCounts: Record<number, number> = {};
  for (const occ of occurrences) {
    const localDate = new TZDate(occ.occurrence_start, timezone);
    const day = localDate.getDate();
    eventCounts[day] = (eventCounts[day] ?? 0) + 1;
  }
  return eventCounts;
}

/** Monday-first text grid of the month's day numbers. */
function buildMonthGrid(monthStart: Date, daysInMonth: number): string {
  const firstDayOfWeek = (getDay(monthStart) + 6) % 7; // 0=Mon
  let grid = '';

  // Pad first week
  for (let i = 0; i < firstDayOfWeek; i++) grid += '   ';

  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = String(d).padStart(2, ' ');
    grid += `${dayStr} `;
    if ((firstDayOfWeek + d) % 7 === 0) grid += '\n';
  }
  return grid;
}

function buildMonthText(window: MonthWindow, eventCounts: Record<number, number>): string {
  const header = 'Mo Tu We Th Fr Sa Su';
  const grid = buildMonthGrid(window.monthStart, window.daysInMonth);

  // Event counts summary
  const countLines = Object.entries(eventCounts)
    .map(([d, c]) => `${d}·${c}`)
    .join('  ');

  return `📅 ${window.monthLabel}\n\n<code>${header}\n${grid.trimEnd()}</code>\n\n${countLines ? `Events: ${countLines}` : 'No events this month.'}`;
}

/** Navigation callbacks edit the existing message; the /month command sends a new one. */
async function deliverMonthText(
  ctx: BotCommandContext | BotCallbackContext,
  text: string,
  monthStart: Date,
  yearMonth: string | undefined,
): Promise<void> {
  const options = { parse_mode: 'HTML' as const, reply_markup: monthNavKeyboard(format(monthStart, 'yyyy-MM')) };
  if (yearMonth && isCallbackContext(ctx)) {
    await ctx.editText(text, options);
  } else {
    await ctx.send(text, options);
  }
}

async function handleGroupMonth(
  ctx: BotCommandContext | BotCallbackContext,
  user: User,
  lang: 'en' | 'ru',
  eventService: EventService,
  yearMonth: string | undefined,
  groupRepo: GroupChatRepository | undefined,
): Promise<void> {
  const groupId = getGroupId(ctx);
  if (groupId === null) return;
  const timezone = groupRepo?.getTimezone(groupId) ?? null;
  if (!timezone) {
    await ctx.send(
      lang === 'ru'
        ? '⚙️ Сначала задайте таймзону группы через /settings'
        : '⚙️ Set the group timezone first via /settings',
    );
    return;
  }

  const window = resolveMonthWindow(yearMonth, timezone, lang);
  const allOccurrences = enrichAgenda(
    eventService.getEventsInRangeForGroup(groupId, window.monthStartUtc, window.monthEndUtc),
    { userId: user.telegram_id, language: lang, groupId },
    eventService.agendaRepository,
  );
  const text = buildMonthText(window, countEventsPerDay(allOccurrences, timezone));
  await deliverMonthText(ctx, text, window.monthStart, yearMonth);
}

interface MonthImageInput {
  imageDelivery: ImageDelivery;
  /** The month's agenda as it is now; called when the picture is queued and again if the calendar changes while it renders. */
  load(): EventOccurrence[];
  window: MonthWindow;
  user: User;
  lang: 'en' | 'ru';
  groupRepo: GroupChatRepository | undefined;
}

/** Queue the month picture (it is sent and pinned when ready); the text answer is already out. */
async function queueMonthImage(ctx: BotCommandContext | BotCallbackContext, input: MonthImageInput): Promise<void> {
  const { imageDelivery, load, window, user, lang, groupRepo } = input;
  const chatId = user.telegram_id;
  await queuePicture(imageDelivery, {
    ...commandPictureTransport(ctx, chatId),
    language: lang,
    kind: 'month',
    label: window.monthLabel,
    slot: `month:user:${chatId}:${window.monthStart.getFullYear()}-${window.monthStart.getMonth()}`,
    dataOwner: chatId,
    filename: 'month.png',
    buildJob: () =>
      monthImageJob(load(), window.monthStart.getFullYear(), window.monthStart.getMonth(), user.timezone, lang, chatId),
    onSent: (messageId) => pinPicture(ctx, chatId, messageId, groupRepo, false),
  });
}

export async function handleMonth(
  ctx: BotCommandContext | BotCallbackContext,
  eventService: EventService,
  yearMonth?: string,
  imageDelivery?: ImageDelivery,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';

  if (isGroup(ctx)) {
    await handleGroupMonth(ctx, user, lang, eventService, yearMonth, groupRepo);
    return;
  }

  const window = resolveMonthWindow(yearMonth, user.timezone, lang);

  // Count events per day — single range query for the whole month, then bucket
  const load = () =>
    enrichAgenda(
      eventService.getEventsInRange(user.telegram_id, window.monthStartUtc, window.monthEndUtc),
      { userId: user.telegram_id, language: lang },
      eventService.agendaRepository,
    );
  const allOccurrences = load();

  const text = buildMonthText(window, countEventsPerDay(allOccurrences, user.timezone));
  await deliverMonthText(ctx, text, window.monthStart, yearMonth);

  // Month picture (only on the initial /month command, not nav callbacks)
  if (!yearMonth && imageDelivery) {
    await queueMonthImage(ctx, { imageDelivery, load, window, user, lang, groupRepo });
  }
}
