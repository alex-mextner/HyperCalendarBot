import { t } from '../../../config/constants.ts';
import { autoPin } from '../../../utils/auto-pin.ts';
import { getDayRangeUtc } from '../../../utils/date.ts';
import { logger } from '../../../utils/logger.ts';
import { getTheme } from '../../../worker/templates/themes.ts';
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
  const dateObj = new Date(`${input.date}T12:00:00Z`);
  const occurrences =
    scope === 'group'
      ? (() => {
          const { start, end } = getDayRangeUtc(dateObj, ctx.user.timezone);
          return ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, start, end);
        })()
      : ctx.eventService.getEventsForDay(userId, dateObj, ctx.user.timezone);
  const holidays = ctx.holidayService?.getHolidaysForDate(userId, input.date) ?? [];
  const lang = (ctx.user.language ?? 'en') as 'ru' | 'en';
  const sender = ctx.sender;
  const tr = t(lang).aiTools.meta;

  try {
    const buffer = await renderDayImage(
      ctx.renderService,
      occurrences,
      input.date,
      ctx.user.timezone,
      lang,
      userId,
      holidays,
    );
    const file = new File([buffer], 'day.png', { type: 'image/png' });
    const sent = await sender.sendPhoto!(ctx.chatId, file);
    schedulePinFireAndForget(ctx, sent.message_id);
    return {
      success: true,
      output: tr.dayImageSent(input.date),
      agentHint:
        'The day image has already been delivered to the chat. Do NOT call render_day_image again for this date in this turn.',
    };
  } catch (err) {
    renderLogger.error({ err, date: input.date }, 'Day image render failed');
    return { success: false, error: tr.dayImageFailed(input.date) };
  }
}
handleRenderDayImage.meta = { skipActionLog: true } satisfies ToolHandlerMeta;

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
    const sent = await sender.sendPhoto!(ctx.chatId, file);
    schedulePinFireAndForget(ctx, sent.message_id);

    const voiceNote = ctx.inputMode === 'live_call' ? ` ${tr.tableRenderingVoice}` : '';
    return {
      success: true,
      output: `${tr.tableSent(input.title)}${voiceNote}`,
      agentHint:
        'The table has already been delivered to the chat. Do NOT call render_table again with identical arguments in this turn.',
    };
  } catch (err) {
    renderLogger.error({ err, title: input.title }, 'Table image render failed');
    return { success: false, error: tr.tableFailed(input.title) };
  }
}
handleRenderTable.meta = { skipActionLog: true } satisfies ToolHandlerMeta;

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

  const weekStartDate = new Date(`${input.week_start}T12:00:00Z`);
  const weekEndDate = new Date(weekStartDate.getTime() + 6 * 86400000);
  const startUtc = new Date(
    Date.UTC(weekStartDate.getUTCFullYear(), weekStartDate.getUTCMonth(), weekStartDate.getUTCDate()),
  ).toISOString();
  const endUtc = new Date(
    Date.UTC(weekEndDate.getUTCFullYear(), weekEndDate.getUTCMonth(), weekEndDate.getUTCDate(), 23, 59, 59, 999),
  ).toISOString();

  const occurrences =
    scope === 'group'
      ? ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, startUtc, endUtc)
      : ctx.eventService.getEventsInRange(userId, startUtc, endUtc);

  const lang = (ctx.user.language ?? 'en') as 'ru' | 'en';
  const sender = ctx.sender;
  const tr = t(lang).aiTools.meta;

  try {
    const buffer = await renderWeekImage(
      ctx.renderService,
      occurrences,
      input.week_start,
      ctx.user.timezone,
      lang,
      userId,
    );
    const file = new File([buffer], 'week.png', { type: 'image/png' });
    const sent = await sender.sendPhoto!(ctx.chatId, file);
    schedulePinFireAndForget(ctx, sent.message_id);
    return {
      success: true,
      output: tr.weekImageSent(input.week_start),
      agentHint:
        'The weekly image has already been delivered to the chat. Do NOT call render_week_image again with identical arguments in this turn.',
    };
  } catch (err) {
    renderLogger.error({ err, weekStart: input.week_start }, 'Week image render failed');
    return { success: false, error: tr.weekImageFailed(input.week_start) };
  }
}
handleRenderWeekImage.meta = { skipActionLog: true } satisfies ToolHandlerMeta;

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
    const buffer = await renderMonthImage(ctx.renderService, occurrences, year, month, ctx.user.timezone, lang, userId);
    const file = new File([buffer], 'month.png', { type: 'image/png' });
    const sent = await sender.sendPhoto!(ctx.chatId, file);
    schedulePinFireAndForget(ctx, sent.message_id);
    return {
      success: true,
      output: tr.monthImageSent(input.month),
      agentHint:
        'The monthly image has already been delivered to the chat. Do NOT call render_month_image again with identical arguments in this turn.',
    };
  } catch (err) {
    renderLogger.error({ err, month: input.month }, 'Month image render failed');
    return { success: false, error: tr.monthImageFailed(input.month) };
  }
}
handleRenderMonthImage.meta = { skipActionLog: true } satisfies ToolHandlerMeta;
