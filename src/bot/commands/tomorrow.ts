// src/bot/commands/tomorrow.ts

import { TZDate } from '@date-fns/tz';
import { addDays } from 'date-fns';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { renderDayImage } from '../../services/image/render-day.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import { imageLogger } from '../../utils/logger.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleTomorrow(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  renderService?: RenderService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const tomorrow = addDays(new Date(), 1);
  const occurrences = eventService.getEventsForDay(user.telegram_id, tomorrow, user.timezone);
  const dateIso = new TZDate(tomorrow, user.timezone).toISOString().slice(0, 10);
  const holidays = holidayService?.getHolidaysForDate(user.telegram_id, dateIso) ?? [];
  const text = formatDayAgenda(occurrences, tomorrow.toISOString(), user.timezone, user.language, holidays);

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
      const file = new File([buffer], 'tomorrow.png', { type: 'image/png' });
      await ctx.sendPhoto(file);
    } catch (err) {
      imageLogger.error({ error: (err as Error).message }, 'Render failed');
    }
  }
}
