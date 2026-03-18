// src/bot/commands/today.ts

import { TZDate } from '@date-fns/tz';
import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { renderDayImage } from '../../services/image/render-day.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import { imageLogger } from '../../utils/logger.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleToday(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  renderService?: RenderService,
  chatHistory?: ChatHistoryRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
  const now = new Date();
  const occurrences = eventService.getEventsForDay(user.telegram_id, now, user.timezone);
  const dateIso = new TZDate(now, user.timezone).toISOString().slice(0, 10);
  const holidays = holidayService?.getHolidaysForDate(user.telegram_id, dateIso) ?? [];
  const text = formatDayAgenda(occurrences, now.toISOString(), user.timezone, user.language, holidays);

  await ctx.send(text, { parse_mode: 'HTML' });

  if (chatHistory && ctx.chatId) {
    const chatId = Number(ctx.chatId);
    chatHistory.save(user.telegram_id, 'user', '/today', chatId);
    chatHistory.save(user.telegram_id, 'assistant', text, chatId);
  }

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
      await ctx.sendPhoto(file);
    } catch (err) {
      imageLogger.error({ error: (err as Error).message }, 'Render failed');
    }
  }
}
