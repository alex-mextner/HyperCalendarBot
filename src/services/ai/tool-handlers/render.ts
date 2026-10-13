import { TZDate } from '@date-fns/tz';
import { format, startOfWeek } from 'date-fns';
import { t } from '../../../config/constants.ts';
import type { EventOccurrence } from '../../../database/types.ts';
import { agendaImageErrorMessage, sendAgendaImage } from '../../../utils/agenda-image.ts';
import { autoPin } from '../../../utils/auto-pin.ts';
import { getDayRangeUtc, getWeekRangeUtc, localCalendarDate } from '../../../utils/date.ts';
import { logger } from '../../../utils/logger.ts';
import { getTheme } from '../../../worker/templates/themes.ts';
import { enrichAgenda } from '../../event/agenda-enrichment.ts';
import { formatWeekLabel } from '../../image/data-mapper.ts';
import { renderDayImage } from '../../image/render-day.ts';
import { renderMonthImage } from '../../image/render-month.ts';
import { renderWeekImage } from '../../image/render-week.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';
import { checkSecretaryAccess } from './secretary-access.ts';
import { resolveScope } from './shared.ts';

type Scope = 'personal' | 'group';

const renderLogger = logger.child({ module: 'ai-tools' });

/**
 * Agenda rows for a calendar image. A personal calendar rendered into a group chat
 * is seen by every member: it gets neither private rosters nor description previews
 * (descriptions often carry call links, passcodes or someone else's notes).
 */
function imageAgenda(
  ctx: AgentContext,
  scope: Scope,
  userId: number,
  language: 'ru' | 'en',
  occurrences: EventOccurrence[],
): EventOccurrence[] {
  const viewer = { userId, language, groupId: scope === 'group' ? ctx.groupChatId : undefined };
  if (!ctx.isGroup || scope === 'group') return enrichAgenda(occurrences, viewer, ctx.eventService.agendaRepository);
  return enrichAgenda(
    occurrences.map((occurrence) => ({ ...occurrence, event: { ...occurrence.event, description: null } })),
    viewer,
  );
}

/**
 * Pin the rendered image if chat policy demands it. Pin is a secondary
 * side-effect: the photo is already delivered before this runs, so the tool
 * result is returned with the pin still in flight. Any failure is logged and
 * swallowed — pinning is best-effort, not a delivery guarantee.
 */
function schedulePinFireAndForget(ctx: AgentContext, messageId: number): void {
  const sender = ctx.sender;
  if (!sender) return;
  autoPin(ctx.chatId, messageId, {
    pinChatMessage: (cId, mId, opts) => sender.pinChatMessage?.(cId, mId, opts) ?? Promise.resolve(true as true),
    sendMessage: (cId, text) => sender.sendMessage(cId, text).then(() => {}),
    isGroupChat: ctx.isGroup,
    groupChatRepo: ctx.group?.groupChatRepo,
  }).catch((err) => {
    renderLogger.error({ err }, 'autoPin failed');
  });
}

/**
 * The earliest upcoming day this run changed, when the requested day is already past. After a
 * change the model sometimes renders a past day it also touched, which hides the change that
 * matters (2026-09-27: deletes on 2026-09-01 and 2026-09-29, then a picture of 2026-09-01).
 * A past day among the turn's named days (ctx.dayReferences.allowedDates) is kept when the run
 * left it untouched: the user named it ("cancel English on Tuesday and show me September 1"),
 * though the set also holds the neighbours of a day given in another zone and the days of a
 * question a "Да" answers; a clock time alone names only today. A day the run changed yields like
 * any other, so "move English from September 1 to Tuesday" pictures Tuesday; the trade-off is
 * that asking to see a day the run also changed is redirected too.
 */
function upcomingChangedDayInstead(ctx: AgentContext, requested: string): string | undefined {
  const today = format(new TZDate(new Date(), ctx.user.timezone), 'yyyy-MM-dd');
  if (requested >= today || !ctx.changedDays) return undefined;
  if (ctx.dayReferences?.allowedDates.has(requested) && !ctx.changedDays.has(requested)) return undefined;
  let nearest: string | undefined;
  for (const day of ctx.changedDays) {
    if (day >= today && (nearest === undefined || day < nearest)) nearest = day;
  }
  return nearest;
}

export async function handleRenderDayImage(
  ctx: AgentContext,
  input: { date: string; scope?: Scope; owner_id?: number },
): Promise<ToolResult> {
  if (!ctx.renderService || !ctx.sender?.sendPhoto) {
    return { success: false, error: 'Image rendering not available.' };
  }
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  let dateObj: TZDate;
  try {
    dateObj = localCalendarDate(input.date, ctx.user.timezone);
  } catch {
    return { success: false, error: 'Invalid calendar date.' };
  }
  const instead = upcomingChangedDayInstead(ctx, input.date);
  if (instead) dateObj = localCalendarDate(instead, ctx.user.timezone);
  const date = instead ?? input.date;
  const occurrences =
    scope === 'group'
      ? (() => {
          const { start, end } = getDayRangeUtc(dateObj, ctx.user.timezone);
          return ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, start, end);
        })()
      : ctx.eventService.getEventsForDay(userId, dateObj, ctx.user.timezone);
  const holidays = ctx.holidayService?.getHolidaysForDate(userId, date) ?? [];
  const lang = (ctx.user.language ?? 'en') as 'ru' | 'en';
  const sender = ctx.sender;
  const tr = t(lang).aiTools.meta;

  try {
    const buffer = await renderDayImage(
      ctx.renderService,
      imageAgenda(ctx, scope, userId, lang, occurrences),
      date,
      ctx.user.timezone,
      lang,
      userId,
      holidays,
    );
    const file = new File([buffer], 'day.png', { type: 'image/png' });
    const sent = await sendAgendaImage(file, {
      language: ctx.user.language,
      sendPhoto: (photo) => sender.sendPhoto!(ctx.chatId, photo),
      sendDocument: sender.sendDocument
        ? (document, options) => sender.sendDocument!(ctx.chatId, document, options.caption)
        : undefined,
    });
    schedulePinFireAndForget(ctx, sent.message_id);
    return {
      success: true,
      output: instead ? tr.dayImageSentInstead(date, input.date) : tr.dayImageSent(date),
      agentHint:
        'The day image has already been delivered to the chat. Do NOT call render_day_image again for this date in this turn.',
    };
  } catch (err) {
    const imageError = agendaImageErrorMessage(err);
    if (imageError) return { success: false, error: imageError };
    renderLogger.error({ err, date, requested: input.date }, 'Day image render failed');
    return { success: false, error: tr.dayImageFailed(date) };
  }
}
handleRenderDayImage.meta = { skipActionLog: true, delivers: true } satisfies ToolHandlerMeta;

export async function handleRenderTable(
  ctx: AgentContext,
  input: { title: string; markdown: string; caption?: string },
): Promise<ToolResult> {
  if (!ctx.renderService || !ctx.sender?.sendPhoto) {
    return { success: false, error: 'Image rendering not available.' };
  }

  const lang = (ctx.user.language ?? 'en') as 'ru' | 'en';
  const tr = t(lang).aiTools.meta;
  const sender = ctx.sender;

  try {
    const buffer = await ctx.renderService.renderDirect({
      type: 'md-table',
      data: {
        title: input.title,
        markdown: input.markdown,
        caption: input.caption,
        theme: getTheme(),
      },
      userId: ctx.user.telegram_id,
    });
    const file = new File([buffer], 'table.png', { type: 'image/png' });
    const sent = await sendAgendaImage(file, {
      language: ctx.user.language,
      sendPhoto: (photo) => sender.sendPhoto!(ctx.chatId, photo),
      sendDocument: sender.sendDocument
        ? (document, options) => sender.sendDocument!(ctx.chatId, document, options.caption)
        : undefined,
    });
    schedulePinFireAndForget(ctx, sent.message_id);

    const voiceNote = ctx.inputMode === 'live_call' ? ` ${tr.tableRenderingVoice}` : '';
    return {
      success: true,
      output: `${tr.tableSent(input.title)}${voiceNote}`,
      agentHint:
        'The table has already been delivered to the chat. Do NOT call render_table again with identical arguments in this turn.',
    };
  } catch (err) {
    const imageError = agendaImageErrorMessage(err);
    if (imageError) return { success: false, error: imageError };
    renderLogger.error({ err, title: input.title }, 'Table image render failed');
    return { success: false, error: tr.tableFailed(input.title) };
  }
}
handleRenderTable.meta = { skipActionLog: true, delivers: true } satisfies ToolHandlerMeta;

export async function handleRenderWeekImage(
  ctx: AgentContext,
  input: { week_start: string; scope?: Scope; owner_id?: number },
): Promise<ToolResult> {
  if (!ctx.renderService || !ctx.sender?.sendPhoto) {
    return { success: false, error: 'Image rendering not available.' };
  }
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }

  const lang = (ctx.user.language ?? 'en') as 'ru' | 'en';
  const tr = t(lang).aiTools.meta;

  // Normalize to Monday of the week in the user's timezone — AI may send any weekday.
  // Parse week_start via the year/month/day component TZDate constructor, which builds the wall
  // clock time directly in the user's timezone. Anchoring the string at UTC (or host-local) noon
  // first and then converting would shift the local calendar day forward in UTC+12/+13/+14 zones,
  // turning a Sunday input into local Monday and resolving startOfWeek to next week's Monday.
  const weekStartMatch = input.week_start.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!weekStartMatch) {
    return { success: false, error: tr.weekImageFailed(input.week_start) };
  }
  const [, weekStartYearStr, weekStartMonthStr, weekStartDayStr] = weekStartMatch;
  const weekStartYear = Number(weekStartYearStr);
  const weekStartMonth = Number(weekStartMonthStr);
  const weekStartDay = Number(weekStartDayStr);
  const weekStartDate = new TZDate(weekStartYear, weekStartMonth - 1, weekStartDay, 12, ctx.user.timezone);
  // Reject overflow (e.g. month 13, Feb 30): the TZDate/native Date constructor rolls invalid
  // components into the next month/year instead of throwing, so verify the built date's
  // components still match what was supplied rather than trust the roll-over silently.
  if (
    weekStartDate.getFullYear() !== weekStartYear ||
    weekStartDate.getMonth() !== weekStartMonth - 1 ||
    weekStartDate.getDate() !== weekStartDay
  ) {
    return { success: false, error: tr.weekImageFailed(input.week_start) };
  }
  const weekStartIso = startOfWeek(weekStartDate, { weekStartsOn: 1 }).toISOString().slice(0, 10);

  const { start: startUtc, end: endUtc } = getWeekRangeUtc(
    localCalendarDate(weekStartIso, ctx.user.timezone),
    ctx.user.timezone,
  );

  const occurrences =
    scope === 'group'
      ? ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, startUtc, endUtc)
      : ctx.eventService.getEventsInRange(userId, startUtc, endUtc);

  const sender = ctx.sender;

  try {
    const buffer = await renderWeekImage(
      ctx.renderService,
      imageAgenda(ctx, scope, userId, lang, occurrences),
      weekStartIso,
      ctx.user.timezone,
      lang,
      userId,
    );
    const file = new File([buffer], 'week.png', { type: 'image/png' });
    const sent = await sendAgendaImage(file, {
      language: ctx.user.language,
      sendPhoto: (photo) => sender.sendPhoto!(ctx.chatId, photo),
      sendDocument: sender.sendDocument
        ? (document, options) => sender.sendDocument!(ctx.chatId, document, options.caption)
        : undefined,
    });
    schedulePinFireAndForget(ctx, sent.message_id);
    return {
      success: true,
      output: tr.weekImageSent(formatWeekLabel(weekStartIso, lang)),
      agentHint:
        'The weekly image has already been delivered to the chat. Do NOT call render_week_image again with identical arguments in this turn.',
    };
  } catch (err) {
    const imageError = agendaImageErrorMessage(err);
    if (imageError) return { success: false, error: imageError };
    renderLogger.error({ err, weekStart: input.week_start }, 'Week image render failed');
    return { success: false, error: tr.weekImageFailed(input.week_start) };
  }
}
handleRenderWeekImage.meta = { skipActionLog: true, delivers: true } satisfies ToolHandlerMeta;

export async function handleRenderMonthImage(
  ctx: AgentContext,
  input: { month: string; scope?: Scope; owner_id?: number },
): Promise<ToolResult> {
  if (!ctx.renderService || !ctx.sender?.sendPhoto) {
    return { success: false, error: 'Image rendering not available.' };
  }
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }

  // Parse "YYYY-MM" or "YYYY-MM-DD"
  const parts = input.month.split('-');
  const year = Number.parseInt(parts[0]!, 10);
  const month = Number.parseInt(parts[1]!, 10) - 1; // 0-based

  const startUtc = new Date(Date.UTC(year, month, 1)).toISOString();
  const endUtc = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)).toISOString();

  const occurrences =
    scope === 'group'
      ? ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, startUtc, endUtc)
      : ctx.eventService.getEventsInRange(userId, startUtc, endUtc);

  const lang = (ctx.user.language ?? 'en') as 'ru' | 'en';
  const sender = ctx.sender;
  const tr = t(lang).aiTools.meta;

  try {
    const buffer = await renderMonthImage(
      ctx.renderService,
      imageAgenda(ctx, scope, userId, lang, occurrences),
      year,
      month,
      ctx.user.timezone,
      lang,
      userId,
    );
    const file = new File([buffer], 'month.png', { type: 'image/png' });
    const sent = await sendAgendaImage(file, {
      language: ctx.user.language,
      sendPhoto: (photo) => sender.sendPhoto!(ctx.chatId, photo),
      sendDocument: sender.sendDocument
        ? (document, options) => sender.sendDocument!(ctx.chatId, document, options.caption)
        : undefined,
    });
    schedulePinFireAndForget(ctx, sent.message_id);
    return {
      success: true,
      output: tr.monthImageSent(input.month),
      agentHint:
        'The monthly image has already been delivered to the chat. Do NOT call render_month_image again with identical arguments in this turn.',
    };
  } catch (err) {
    const imageError = agendaImageErrorMessage(err);
    if (imageError) return { success: false, error: imageError };
    renderLogger.error({ err, month: input.month }, 'Month image render failed');
    return { success: false, error: tr.monthImageFailed(input.month) };
  }
}
handleRenderMonthImage.meta = { skipActionLog: true, delivers: true } satisfies ToolHandlerMeta;
