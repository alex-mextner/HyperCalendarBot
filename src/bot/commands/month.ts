import { enrichAgenda } from '../../services/event/agenda-enrichment.ts';
import { agendaImageErrorMessage, sendAgendaImage } from '../../utils/agenda-image.ts';
// src/bot/commands/month.ts

import { TZDate } from '@date-fns/tz';
import { endOfMonth, format, getDay, getDaysInMonth, startOfMonth } from 'date-fns';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { EventOccurrence } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { mapMonthlyCalendarData } from '../../services/image/data-mapper.ts';
import type { ImageRenderer } from '../../services/image/render-service.ts';
import { autoPin } from '../../utils/auto-pin.ts';
import { imageLogger } from '../../utils/logger.ts';
import { getTheme } from '../../worker/templates/themes.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import { monthNavKeyboard } from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';
import { isCallbackContext } from '../types.ts';

export async function handleMonth(
  ctx: BotCommandContext | BotCallbackContext,
  eventService: EventService,
  yearMonth?: string,
  renderService?: ImageRenderer,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';

  if (isGroup(ctx)) {
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

    const allOccurrences = enrichAgenda(
      eventService.getEventsInRangeForGroup(groupId, monthStartUtc, monthEndUtc),
      { userId: user.telegram_id, language: lang, groupId },
      eventService.agendaRepository,
    );

    const eventCounts: Record<number, number> = {};
    for (const occ of allOccurrences) {
      const localDate = new TZDate(occ.occurrence_start, timezone);
      const day = localDate.getDate();
      eventCounts[day] = (eventCounts[day] ?? 0) + 1;
    }

    const header = 'Mo Tu We Th Fr Sa Su';
    const firstDayOfWeek = (getDay(monthStart) + 6) % 7;
    let grid = '';
    for (let i = 0; i < firstDayOfWeek; i++) grid += '   ';
    for (let d = 1; d <= daysInMonth; d++) {
      const dayStr = String(d).padStart(2, ' ');
      grid += `${dayStr} `;
      if ((firstDayOfWeek + d) % 7 === 0) grid += '\n';
    }

    const countLines = Object.entries(eventCounts)
      .map(([d, c]) => `${d}·${c}`)
      .join('  ');
    const ym = format(monthStart, 'yyyy-MM');
    const text = `📅 ${monthLabel}\n\n<code>${header}\n${grid.trimEnd()}</code>\n\n${countLines ? `Events: ${countLines}` : 'No events this month.'}`;

    if (yearMonth && isCallbackContext(ctx)) {
      await ctx.editText(text, {
        parse_mode: 'HTML',
        reply_markup: monthNavKeyboard(ym),
      });
    } else {
      await ctx.send(text, {
        parse_mode: 'HTML',
        reply_markup: monthNavKeyboard(ym),
      });
    }
    return;
  }

  let refDate: Date;
  if (yearMonth) {
    const [y, m] = yearMonth.split('-').map(Number) as [number, number];
    refDate = new TZDate(y, m - 1, 1, 0, 0, 0, 0, user.timezone);
  } else {
    refDate = TZDate.tz(user.timezone);
  }

  const monthStart = startOfMonth(refDate);
  const monthEnd = endOfMonth(refDate);
  const monthLabel = format(monthStart, lang === 'ru' ? 'LLLL yyyy' : 'MMMM yyyy');
  const daysInMonth = getDaysInMonth(monthStart);

  // Count events per day — single range query for the whole month, then bucket
  const monthStartUtc = new TZDate(
    monthStart.getFullYear(),
    monthStart.getMonth(),
    1,
    0,
    0,
    0,
    0,
    user.timezone,
  ).toISOString();
  const monthEndUtc = new TZDate(
    monthEnd.getFullYear(),
    monthEnd.getMonth(),
    daysInMonth,
    23,
    59,
    59,
    999,
    user.timezone,
  ).toISOString();
  const allOccurrences = enrichAgenda(
    eventService.getEventsInRange(user.telegram_id, monthStartUtc, monthEndUtc),
    { userId: user.telegram_id, language: lang },
    eventService.agendaRepository,
  );

  const eventCounts: Record<number, number> = {};
  for (const occ of allOccurrences) {
    const localDate = new TZDate(occ.occurrence_start, user.timezone);
    const day = localDate.getDate();
    eventCounts[day] = (eventCounts[day] ?? 0) + 1;
  }

  // Build calendar grid
  const header = 'Mo Tu We Th Fr Sa Su';
  const firstDayOfWeek = (getDay(monthStart) + 6) % 7; // 0=Mon
  let grid = '';

  // Pad first week
  for (let i = 0; i < firstDayOfWeek; i++) grid += '   ';

  for (let d = 1; d <= daysInMonth; d++) {
    const dayStr = String(d).padStart(2, ' ');
    grid += `${dayStr} `;
    if ((firstDayOfWeek + d) % 7 === 0) grid += '\n';
  }

  // Event counts summary
  const countLines = Object.entries(eventCounts)
    .map(([d, c]) => `${d}·${c}`)
    .join('  ');

  const ym = format(monthStart, 'yyyy-MM');
  const text = `📅 ${monthLabel}\n\n<code>${header}\n${grid.trimEnd()}</code>\n\n${countLines ? `Events: ${countLines}` : 'No events this month.'}`;

  if (yearMonth && isCallbackContext(ctx)) {
    await ctx.editText(text, {
      parse_mode: 'HTML',
      reply_markup: monthNavKeyboard(ym),
    });
  } else {
    await ctx.send(text, {
      parse_mode: 'HTML',
      reply_markup: monthNavKeyboard(ym),
    });
  }

  // Render month image (only on initial /month command, not nav callbacks)
  if (!yearMonth && renderService) {
    try {
      const occurrencesByDay = new Map<string, EventOccurrence[]>();
      for (const occ of allOccurrences) {
        const localDate = new TZDate(occ.occurrence_start, user.timezone);
        const dayIso = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;
        if (!occurrencesByDay.has(dayIso)) occurrencesByDay.set(dayIso, []);
        occurrencesByDay.get(dayIso)!.push(occ);
      }

      const userNow = new TZDate(new Date(), user.timezone);
      const todayIso = `${userNow.getFullYear()}-${String(userNow.getMonth() + 1).padStart(2, '0')}-${String(userNow.getDate()).padStart(2, '0')}`;

      const data = mapMonthlyCalendarData({
        occurrencesByDay,
        year: monthStart.getFullYear(),
        month: monthStart.getMonth(),
        timezone: user.timezone,
        locale: lang,
        theme: getTheme(),
        todayIso,
      });

      const buffer = await renderService.renderDirect({
        type: 'monthly-calendar',
        data,
        userId: user.telegram_id,
      });
      const file = new File([buffer], 'month.png', { type: 'image/png' });
      const sent = await sendAgendaImage(file, {
        language: user.language,
        sendPhoto: (photo) => ctx.sendPhoto(photo),
        sendDocument: (document, options) => ctx.sendDocument(document, options),
      });
      autoPin(user.telegram_id, sent.id, {
        pinChatMessage: (chatId, messageId, options) =>
          ctx.bot.api.pinChatMessage({
            chat_id: chatId,
            message_id: messageId,
            disable_notification: options.disable_notification,
          }),
        sendMessage: async (chatId, text) => {
          await ctx.bot.api.sendMessage({ chat_id: chatId, text });
        },
        isGroupChat: false,
        groupChatRepo: groupRepo,
      }).catch((err) => {
        imageLogger.error({ err }, 'autoPin failed');
      });
    } catch (err) {
      imageLogger.error({ err }, 'Month render failed');
      await ctx.send(
        agendaImageErrorMessage(err) ?? 'Agenda image could not be generated. Choose a shorter date range.',
      );
    }
  }
}
