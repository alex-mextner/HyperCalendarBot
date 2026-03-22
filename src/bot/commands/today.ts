// src/bot/commands/today.ts

import { TZDate } from '@date-fns/tz';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { renderDayImage } from '../../services/image/render-day.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import { autoPin } from '../../utils/auto-pin.ts';
import { imageLogger } from '../../utils/logger.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleToday(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  renderService?: RenderService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
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
    const now = new Date();
    const tzNow = new TZDate(now, timezone);
    const dayStart = new TZDate(new Date(tzNow.getFullYear(), tzNow.getMonth(), tzNow.getDate(), 0, 0, 0), timezone);
    const dayEnd = new TZDate(
      new Date(tzNow.getFullYear(), tzNow.getMonth(), tzNow.getDate(), 23, 59, 59, 999),
      timezone,
    );
    const occurrences = eventService.getEventsInRangeForGroup(groupId, dayStart.toISOString(), dayEnd.toISOString());
    const holidays = holidayService?.getHolidaysForDate(user.telegram_id, tzNow.toISOString().slice(0, 10)) ?? [];
    const text = formatDayAgenda(occurrences, now.toISOString(), timezone, lang, holidays);
    await ctx.send(text, { parse_mode: 'HTML' });
    return;
  }

  const now = new Date();
  const occurrences = eventService.getEventsForDay(user.telegram_id, now, user.timezone);
  const dateIso = new TZDate(now, user.timezone).toISOString().slice(0, 10);
  const holidays = holidayService?.getHolidaysForDate(user.telegram_id, dateIso) ?? [];
  const text = formatDayAgenda(occurrences, now.toISOString(), user.timezone, user.language, holidays);

  await ctx.send(text, { parse_mode: 'HTML' });

  if (renderService) {
    try {
      const buffer = await renderDayImage(
        renderService,
        occurrences,
        dateIso,
        user.timezone,
        user.language as 'ru' | 'en',
        user.telegram_id,
        holidays,
      );
      const file = new File([buffer], 'today.png', { type: 'image/png' });
      const sent = await ctx.sendPhoto(file);
      autoPin(user.telegram_id, sent.id, {
        pinChatMessage: (chatId, messageId, options) =>
          ctx.bot.api.pinChatMessage({
            chat_id: chatId,
            message_id: messageId,
            disable_notification: options.disable_notification,
          }),
        sendMessage: (chatId, text) => ctx.bot.api.sendMessage({ chat_id: chatId, text }),
        isGroupChat: false,
        groupChatRepo: groupRepo,
      }).catch((err) => {
        imageLogger.error({ err }, 'autoPin failed');
      });
    } catch (err) {
      imageLogger.error({ err }, 'Render failed');
    }
  }
}
