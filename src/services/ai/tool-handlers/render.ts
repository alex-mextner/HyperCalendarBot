import { t } from '../../../config/constants.ts';
import { autoPin } from '../../../utils/auto-pin.ts';
import { getDayRangeUtc } from '../../../utils/date.ts';
import { logger } from '../../../utils/logger.ts';
import { getTheme } from '../../../worker/templates/themes.ts';
import { renderDayImage } from '../../image/render-day.ts';
import type { AgentContext, ToolResult } from '../types.ts';
import { checkSecretaryAccess } from './secretary-access.ts';
import { resolveScope } from './shared.ts';

type Scope = 'personal' | 'group';

const renderLogger = logger.child({ module: 'ai-tools' });

export function handleRenderDayImage(
  ctx: AgentContext,
  input: { date: string; scope?: Scope; owner_id?: number },
): ToolResult {
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

  const chatId = ctx.chatId;
  const isGroupChat = ctx.isGroup;
  const groupChatRepo = ctx.group?.groupChatRepo;

  renderDayImage(ctx.renderService as never, occurrences, input.date, ctx.user.timezone, lang, userId, holidays)
    .then(async (buffer) => {
      const file = new File([buffer], 'day.png', { type: 'image/png' });
      const sent = await sender.sendPhoto!(chatId, file);
      autoPin(chatId, sent.message_id, {
        pinChatMessage: (cId, mId, opts) => sender.pinChatMessage?.(cId, mId, opts) ?? Promise.resolve(true as true),
        sendMessage: (cId, text) => sender.sendMessage(cId, text).then(() => {}),
        isGroupChat,
        groupChatRepo,
      }).catch((err) => {
        renderLogger.error({ err }, 'autoPin failed');
      });
    })
    .catch((err) => {
      renderLogger.error({ err }, 'Day image render failed');
    });

  return { success: true, output: t(lang).aiTools.meta.dayImageRendering(input.date) };
}

export function handleRenderTable(
  ctx: AgentContext,
  input: { title: string; markdown: string; caption?: string },
): ToolResult {
  if (!ctx.renderService || !ctx.sender?.sendPhoto) {
    return { success: false, error: 'Image rendering not available.' };
  }

  const lang = (ctx.user.language ?? 'en') as 'ru' | 'en';
  const tr = t(lang).aiTools.meta;
  const sender = ctx.sender;
  const chatId = ctx.chatId;
  const isGroupChat = ctx.isGroup;
  const groupChatRepo = ctx.group?.groupChatRepo;

  ctx.renderService
    .renderDirect({
      type: 'md-table',
      data: {
        title: input.title,
        markdown: input.markdown,
        caption: input.caption,
        theme: getTheme(),
      },
      userId: ctx.user.telegram_id,
    })
    .then(async (buffer) => {
      const file = new File([buffer], 'table.png', { type: 'image/png' });
      const sent = await sender.sendPhoto!(chatId, file);
      autoPin(chatId, sent.message_id, {
        pinChatMessage: (cId, mId, opts) => sender.pinChatMessage?.(cId, mId, opts) ?? Promise.resolve(true as true),
        sendMessage: (cId, text) => sender.sendMessage(cId, text).then(() => {}),
        isGroupChat,
        groupChatRepo,
      }).catch((err) => {
        renderLogger.error({ err }, 'autoPin failed');
      });
    })
    .catch((err) => {
      renderLogger.error({ err }, 'Table image render failed');
    });

  const voiceNote = ctx.inputMode === 'live_call' ? ` ${tr.tableRenderingVoice}` : '';

  return {
    success: true,
    output: `${tr.tableRendering(input.title)}${voiceNote}`,
  };
}

export function handleRenderWeekImage(
  ctx: AgentContext,
  input: { week_start: string; scope?: Scope; owner_id?: number },
): ToolResult {
  if (!ctx.renderService) {
    return { success: false, error: 'Image rendering not available.' };
  }
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'read',
  );
  if (!access.ok) return { success: false, error: access.error };
  return { success: true, output: t(ctx.user.language).aiTools.meta.weekImageNotImplemented(input.week_start) };
}
