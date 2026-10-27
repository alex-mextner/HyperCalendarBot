// src/bot/handlers/callback/agenda-routes.ts
// Agenda callbacks: daily/weekly image views and the share navigator (today/tomorrow/week).

import { TZDate } from '@date-fns/tz';
import type { Lang } from '../../../config/constants.ts';
import { CB, t } from '../../../config/constants.ts';
import type { User } from '../../../database/types.ts';
import { enrichAgenda, enrichAgendaEvents } from '../../../services/event/agenda-enrichment.ts';
import { formatDayAgenda, formatEventDetail, formatWeekAgenda } from '../../../services/event/formatters.ts';
import { mapDailyAgendaData, mapWeeklyOverviewData } from '../../../services/image/data-mapper.ts';
import { agendaImageErrorMessage, sendAgendaImage } from '../../../utils/agenda-image.ts';
import { autoPin } from '../../../utils/auto-pin.ts';
import { getDayRangeUtc, getWeekRangeUtc, localCalendarWeekDays } from '../../../utils/date.ts';
import { imageLogger } from '../../../utils/logger.ts';
import { getTheme } from '../../../worker/templates/themes.ts';
import { sendAgendaText } from '../../commands/agenda-text.ts';
import { getGroupId, isGroup } from '../../group-context.ts';
import type { BotCallbackContext } from '../../types.ts';
import type { CallbackDispatch, CallbackRouteDeps } from './types.ts';

interface AgendaView {
  timezone: string;
  groupId: number | undefined;
}

export function registerAgendaRoutes(dispatch: CallbackDispatch, deps: CallbackRouteDeps): void {
  const { eventService, holidayService } = deps;
  const { renderService, groupRepo } = deps.opts;

  function agendaView(ctx: BotCallbackContext, user: User): AgendaView | null {
    const chat = ctx.message?.chat;
    if (chat?.type === 'private') return { timezone: user.timezone, groupId: undefined };
    const groupId = getGroupId(ctx);
    if (!groupId || !Number.isSafeInteger(groupId) || groupId >= 0) return null;
    const group = groupRepo?.findByChatId(groupId);
    if (!group?.is_active || !group.timezone) return null;
    try {
      new Intl.DateTimeFormat('en', { timeZone: group.timezone });
    } catch {
      return null;
    }
    return { timezone: group.timezone, groupId };
  }

  interface AgendaViewer {
    userId: number;
    language: Lang;
    groupId: number | undefined;
  }

  async function deliverAgendaImage(
    ctx: BotCallbackContext,
    lang: Lang,
    userId: number,
    filename: string,
    render: () => Promise<Buffer>,
  ): Promise<void> {
    try {
      const buffer = await render();
      const file = new File([buffer], filename, { type: 'image/png' });
      if (!ctx.message) {
        await ctx.answer({ text: t(lang).callbackErrors.couldNotSendImage });
        return;
      }
      const sent = await sendAgendaImage(file, {
        language: lang,
        sendPhoto: (photo) => ctx.message!.sendPhoto(photo),
        sendDocument: (document, options) => ctx.message!.sendDocument(document, options),
      });
      if (!sent) return;
      pinSentAgenda(ctx, Number(ctx.chatId ?? userId), sent.id);
    } catch (err) {
      imageLogger.error({ err }, 'Render failed');
      if (ctx.message) {
        await ctx.message.send(agendaImageErrorMessage(err) ?? t(lang).callbackErrors.imageGenerationFailed);
      } else {
        await ctx.answer({ text: t(lang).callbackErrors.renderFailed });
      }
    }
  }

  function pinSentAgenda(ctx: BotCallbackContext, chatId: number, messageId: number): void {
    autoPin(chatId, messageId, {
      pinChatMessage: (cid, pinnedId, options) =>
        ctx.bot.api.pinChatMessage({
          chat_id: cid,
          message_id: pinnedId,
          disable_notification: options.disable_notification,
        }),
      sendMessage: (cid, text) => ctx.bot.api.sendMessage({ chat_id: cid, text }).then(() => {}),
      isGroupChat: isGroup(ctx),
      groupChatRepo: groupRepo,
    }).catch((err) => {
      imageLogger.error({ err }, 'autoPin failed');
    });
  }

  // Image: daily agenda
  dispatch.set(CB.IMG_DAILY, async (ctx, payload, _parts, user) => {
    if (!renderService) {
      await ctx.answer();
      return;
    }
    const dateIso = payload;
    const lang = (user.language ?? 'en') as Lang;
    await ctx.answer();

    const view = agendaView(ctx, user);
    if (!view) return;
    const { timezone, groupId } = view;
    const now = new Date();
    const [year, month, day] = dateIso.split('-').map(Number);
    const dayDate = new TZDate(year!, month! - 1, day!, 12, timezone);
    const { start, end } = getDayRangeUtc(dayDate, timezone);
    const occurrences = enrichAgenda(
      groupId === undefined
        ? eventService.getEventsForDay(user.telegram_id, dayDate, timezone)
        : eventService.getEventsInRangeForGroup(groupId, start, end),
      { userId: user.telegram_id, language: lang, groupId },
      eventService.agendaRepository,
    );

    const userNow = new TZDate(now, timezone);
    const todayIso = userNow.toISOString().slice(0, 10);
    const isToday = dateIso === todayIso;
    const currentTimeMinutes = isToday ? userNow.getHours() * 60 + userNow.getMinutes() : undefined;

    const holidays = holidayService.getHolidaysForDate(user.telegram_id, dateIso);

    const imgData = mapDailyAgendaData({
      occurrences,
      dateIso,
      timezone,
      locale: user.language as 'ru' | 'en',
      theme: getTheme(),
      currentTimeMinutes,
      isHoliday: holidays.length > 0,
      holidayName: holidays[0]?.name,
    });

    await deliverAgendaImage(ctx, lang, user.telegram_id, 'agenda.png', () =>
      renderService.renderDirect({ type: 'daily-agenda', data: imgData, userId: user.telegram_id }),
    );
  });

  // Image: weekly overview
  dispatch.set(CB.IMG_WEEKLY, async (ctx, payload, _parts, user) => {
    if (!renderService) {
      await ctx.answer();
      return;
    }
    const weekStartIso = payload;
    const lang = (user.language ?? 'en') as Lang;
    await ctx.answer();

    const view = agendaView(ctx, user);
    if (!view) return;
    const { timezone, groupId } = view;
    const now = new Date();
    const [year, month, day] = weekStartIso.split('-').map(Number);
    const weekStartDate = new TZDate(year!, month! - 1, day!, 12, timezone);
    const { start, end } = getWeekRangeUtc(weekStartDate, timezone);
    const occurrences = enrichAgenda(
      groupId === undefined
        ? eventService.getEventsInRange(user.telegram_id, start, end)
        : eventService.getEventsInRangeForGroup(groupId, start, end),
      { userId: user.telegram_id, language: lang, groupId },
      eventService.agendaRepository,
    );

    const occurrencesByDay = new Map<string, typeof occurrences>();
    for (const dayKey of localCalendarWeekDays(start, timezone)) {
      occurrencesByDay.set(dayKey, []);
    }
    for (const occ of occurrences) {
      const occDate = new TZDate(new Date(occ.occurrence_start), timezone).toISOString().slice(0, 10);
      const dayList = occurrencesByDay.get(occDate);
      if (dayList) {
        dayList.push(occ);
      }
    }

    const userNow = new TZDate(now, timezone);
    const todayIso = userNow.toISOString().slice(0, 10);

    const imgData = mapWeeklyOverviewData({
      occurrencesByDay,
      weekStartIso,
      timezone,
      locale: user.language as 'ru' | 'en',
      theme: getTheme(),
      todayIso,
    });

    await deliverAgendaImage(ctx, lang, user.telegram_id, 'week.png', () =>
      renderService.renderDirect({ type: 'weekly-overview', data: imgData, userId: user.telegram_id }),
    );
  });

  async function sendShareAgenda(
    ctx: BotCallbackContext,
    user: User,
    subAction: 'today' | 'tomorrow' | 'week',
    view: AgendaView,
    viewer: AgendaViewer,
  ): Promise<unknown> {
    const lang = viewer.language;
    const { timezone, groupId } = view;
    const date = new TZDate(new Date(), timezone);
    if (subAction === 'tomorrow') date.setDate(date.getDate() + 1);
    const { start, end } = subAction === 'week' ? getWeekRangeUtc(date, timezone) : getDayRangeUtc(date, timezone);
    const occurrences = enrichAgenda(
      groupId === undefined
        ? subAction === 'week'
          ? eventService.getEventsForWeek(user.telegram_id, date, timezone)
          : eventService.getEventsForDay(user.telegram_id, date, timezone)
        : eventService.getEventsInRangeForGroup(groupId, start, end),
      viewer,
      eventService.agendaRepository,
    );
    await ctx.answer();
    if (occurrences.length === 0) return ctx.editText(t(lang).no_events_to_share);
    const agenda =
      subAction === 'week'
        ? formatWeekAgenda(occurrences, start, end, timezone, lang)
        : formatDayAgenda(occurrences, date.toISOString(), timezone, lang);
    if (!ctx.message) return;
    await sendAgendaText(ctx.message, `${agenda}\n\n${t(lang).callbackErrors.forwardHint}`);
    // Delivery is evidence: do not report success before all chunks were accepted.
    await ctx.editText(t(lang).callbackErrors.sentBelow);
  }

  async function sendShareEvent(
    ctx: BotCallbackContext,
    user: User,
    eventId: number,
    view: AgendaView,
    viewer: AgendaViewer,
  ): Promise<unknown> {
    const lang = viewer.language;
    const { timezone, groupId } = view;
    const event =
      groupId === undefined
        ? eventService.getEvent(eventId, user.telegram_id)
        : eventService.getEventForGroup(eventId, groupId);
    if (!event) return ctx.answer({ text: t(lang).callbackErrors.notFound });
    const detail = formatEventDetail(
      enrichAgendaEvents([event], viewer, eventService.agendaRepository)[0]!,
      timezone,
      lang,
    );
    await ctx.answer();
    if (!ctx.message) return;
    await sendAgendaText(ctx.message, `${detail}\n\n${t(lang).callbackErrors.forwardHint}`);
    await ctx.editText(t(lang).callbackErrors.sentBelow);
  }

  // Share navigator callbacks
  dispatch.set(CB.SHARE_EVENT, async (ctx, payload, _parts, user) => {
    const lang = (user.language ?? 'en') as Lang;
    const subParts = payload.split(':');
    const subAction = subParts[0]!;

    const view = agendaView(ctx, user);
    if (!view) {
      await ctx.answer();
      return;
    }
    const viewer = { userId: user.telegram_id, language: lang, groupId: view.groupId };

    if (subAction === 'today' || subAction === 'tomorrow' || subAction === 'week') {
      await sendShareAgenda(ctx, user, subAction, view, viewer);
      return;
    }
    if (subAction === 'evt') {
      await sendShareEvent(ctx, user, Number(subParts[1]), view, viewer);
      return;
    }
    await ctx.answer();
  });
}
