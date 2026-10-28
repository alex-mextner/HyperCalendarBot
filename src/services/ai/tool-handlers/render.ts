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

/** Outcome of one guard phase: the value to carry forward, or the tool result to return immediately. */
type Guard<T> = { ok: true; value: T } | { ok: false; result: ToolResult };

/** What every agenda-image tool needs once its shared guards have passed. */
interface ImageRenderTarget {
  renderService: NonNullable<AgentContext['renderService']>;
  sender: NonNullable<AgentContext['sender']>;
  userId: number;
  scope: Scope;
}

/** Guards shared by the day/week/month image tools: renderer + photo transport, secretary read access, group scope. */
function resolveImageRenderTarget(
  ctx: AgentContext,
  input: { scope?: Scope; owner_id?: number },
): Guard<ImageRenderTarget> {
  const { renderService, sender } = ctx;
  if (!renderService || !sender?.sendPhoto) {
    return { ok: false, result: { success: false, error: 'Image rendering not available.' } };
  }
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { ok: false, result: { success: false, error: access.error } };
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { ok: false, result: { success: false, error: 'Group context required for group scope' } };
  }
  return { ok: true, value: { renderService, sender, userId: access.effectiveUserId, scope } };
}

function imageLanguage(ctx: AgentContext): 'ru' | 'en' {
  return (ctx.user.language ?? 'en') as 'ru' | 'en';
}

/** Events of the target (group or the effective user) inside an explicit UTC range. */
function rangeOccurrences(
  ctx: AgentContext,
  target: ImageRenderTarget,
  startUtc: string,
  endUtc: string,
): EventOccurrence[] {
  return target.scope === 'group'
    ? ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, startUtc, endUtc)
    : ctx.eventService.getEventsInRange(target.userId, startUtc, endUtc);
}

/** Presentation-ready agenda; private-chat personal views skip the shared-agenda repository. */
function agendaForImage(
  ctx: AgentContext,
  target: ImageRenderTarget,
  occurrences: EventOccurrence[],
  lang: 'ru' | 'en',
): EventOccurrence[] {
  return enrichAgenda(
    occurrences,
    { userId: target.userId, language: lang, groupId: target.scope === 'group' ? ctx.groupChatId : undefined },
    ctx.isGroup && target.scope !== 'group' ? undefined : ctx.eventService.agendaRepository,
  );
}

/** Send the rendered PNG (photo, or document when oversized) and schedule the best-effort pin. */
async function deliverAgendaPng(
  ctx: AgentContext,
  target: ImageRenderTarget,
  buffer: Uint8Array,
  filename: string,
): Promise<void> {
  const { sender } = target;
  const file = new File([buffer], filename, { type: 'image/png' });
  const sent = await sendAgendaImage(file, {
    language: ctx.user.language,
    sendPhoto: (photo) => sender.sendPhoto!(ctx.chatId, photo),
    sendDocument: sender.sendDocument
      ? (document, options) => sender.sendDocument!(ctx.chatId, document, options.caption)
      : undefined,
  });
  schedulePinFireAndForget(ctx, sent.message_id);
}

/** Typed agenda-image errors are the user-facing answer; anything else is logged and reported with `fallbackError`. */
function imageRenderFailure(
  err: unknown,
  fallbackError: string,
  logContext: Record<string, string>,
  logMessage: string,
): ToolResult {
  const imageError = agendaImageErrorMessage(err);
  if (imageError) return { success: false, error: imageError };
  renderLogger.error({ err, ...logContext }, logMessage);
  return { success: false, error: fallbackError };
}

/** The day to picture: the requested one, or the upcoming day this run changed. Null when the date is invalid. */
function resolveDayToRender(
  ctx: AgentContext,
  requested: string,
): { date: string; dateObj: TZDate; redirected: boolean } | null {
  let dateObj: TZDate;
  try {
    dateObj = localCalendarDate(requested, ctx.user.timezone);
  } catch {
    return null;
  }
  const instead = upcomingChangedDayInstead(ctx, requested);
  if (instead) dateObj = localCalendarDate(instead, ctx.user.timezone);
  return { date: instead ?? requested, dateObj, redirected: !!instead };
}

/**
 * Monday (ISO date) of the week containing `weekStart` in the user's timezone — the AI may send any weekday.
 * Null when `weekStart` is not a real YYYY-MM-DD calendar date.
 *
 * Parse via the year/month/day component TZDate constructor, which builds the wall clock time directly in
 * the user's timezone. Anchoring the string at UTC (or host-local) noon first and then converting would
 * shift the local calendar day forward in UTC+12/+13/+14 zones, turning a Sunday input into local Monday
 * and resolving startOfWeek to next week's Monday.
 */
function resolveWeekStartIso(weekStart: string, timezone: string): string | null {
  const match = weekStart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new TZDate(year, month - 1, day, 12, timezone);
  // Reject overflow (e.g. month 13, Feb 30): the TZDate/native Date constructor rolls invalid
  // components into the next month/year instead of throwing, so verify the built date's
  // components still match what was supplied rather than trust the roll-over silently.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return startOfWeek(date, { weekStartsOn: 1 }).toISOString().slice(0, 10);
}

export async function handleRenderDayImage(
  ctx: AgentContext,
  input: { date: string; scope?: Scope; owner_id?: number },
): Promise<ToolResult> {
  const guard = resolveImageRenderTarget(ctx, input);
  if (!guard.ok) return guard.result;
  const target = guard.value;
  const { userId, scope } = target;

  const day = resolveDayToRender(ctx, input.date);
  if (!day) return { success: false, error: 'Invalid calendar date.' };
  const { date, dateObj, redirected } = day;

  const occurrences =
    scope === 'group'
      ? (() => {
          const { start, end } = getDayRangeUtc(dateObj, ctx.user.timezone);
          return ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, start, end);
        })()
      : ctx.eventService.getEventsForDay(userId, dateObj, ctx.user.timezone);
  const holidays = ctx.holidayService?.getHolidaysForDate(userId, date) ?? [];
  const lang = imageLanguage(ctx);
  const tr = t(lang).aiTools.meta;

  try {
    const buffer = await renderDayImage(
      target.renderService,
      agendaForImage(ctx, target, occurrences, lang),
      date,
      ctx.user.timezone,
      lang,
      userId,
      holidays,
    );
    await deliverAgendaPng(ctx, target, buffer, 'day.png');
    return {
      success: true,
      output: redirected ? tr.dayImageSentInstead(date, input.date) : tr.dayImageSent(date),
      agentHint:
        'The day image has already been delivered to the chat. Do NOT call render_day_image again for this date in this turn.',
    };
  } catch (err) {
    return imageRenderFailure(err, tr.dayImageFailed(date), { date, requested: input.date }, 'Day image render failed');
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
  const guard = resolveImageRenderTarget(ctx, input);
  if (!guard.ok) return guard.result;
  const target = guard.value;

  const lang = imageLanguage(ctx);
  const tr = t(lang).aiTools.meta;

  const weekStartIso = resolveWeekStartIso(input.week_start, ctx.user.timezone);
  if (!weekStartIso) {
    return { success: false, error: tr.weekImageFailed(input.week_start) };
  }

  const { start: startUtc, end: endUtc } = getWeekRangeUtc(
    localCalendarDate(weekStartIso, ctx.user.timezone),
    ctx.user.timezone,
  );

  const occurrences = rangeOccurrences(ctx, target, startUtc, endUtc);

  try {
    const buffer = await renderWeekImage(
      target.renderService,
      agendaForImage(ctx, target, occurrences, lang),
      weekStartIso,
      ctx.user.timezone,
      lang,
      target.userId,
    );
    await deliverAgendaPng(ctx, target, buffer, 'week.png');
    return {
      success: true,
      output: tr.weekImageSent(formatWeekLabel(weekStartIso, lang)),
      agentHint:
        'The weekly image has already been delivered to the chat. Do NOT call render_week_image again with identical arguments in this turn.',
    };
  } catch (err) {
    return imageRenderFailure(
      err,
      tr.weekImageFailed(input.week_start),
      { weekStart: input.week_start },
      'Week image render failed',
    );
  }
}
handleRenderWeekImage.meta = { skipActionLog: true, delivers: true } satisfies ToolHandlerMeta;

export async function handleRenderMonthImage(
  ctx: AgentContext,
  input: { month: string; scope?: Scope; owner_id?: number },
): Promise<ToolResult> {
  const guard = resolveImageRenderTarget(ctx, input);
  if (!guard.ok) return guard.result;
  const target = guard.value;

  // Parse "YYYY-MM" or "YYYY-MM-DD"
  const parts = input.month.split('-');
  const year = Number.parseInt(parts[0]!, 10);
  const month = Number.parseInt(parts[1]!, 10) - 1; // 0-based

  const startUtc = new Date(Date.UTC(year, month, 1)).toISOString();
  const endUtc = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)).toISOString();

  const occurrences = rangeOccurrences(ctx, target, startUtc, endUtc);

  const lang = imageLanguage(ctx);
  const tr = t(lang).aiTools.meta;

  try {
    const buffer = await renderMonthImage(
      target.renderService,
      agendaForImage(ctx, target, occurrences, lang),
      year,
      month,
      ctx.user.timezone,
      lang,
      target.userId,
    );
    await deliverAgendaPng(ctx, target, buffer, 'month.png');
    return {
      success: true,
      output: tr.monthImageSent(input.month),
      agentHint:
        'The monthly image has already been delivered to the chat. Do NOT call render_month_image again with identical arguments in this turn.',
    };
  } catch (err) {
    return imageRenderFailure(
      err,
      tr.monthImageFailed(input.month),
      { month: input.month },
      'Month image render failed',
    );
  }
}
handleRenderMonthImage.meta = { skipActionLog: true, delivers: true } satisfies ToolHandlerMeta;
