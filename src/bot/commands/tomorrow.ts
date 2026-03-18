// src/bot/commands/tomorrow.ts

import { TZDate } from '@date-fns/tz';
import { addDays } from 'date-fns';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda } from '../../services/event/formatters.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { renderDayImage } from '../../services/image/render-day.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import { imageLogger } from '../../utils/logger.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleTomorrow(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  renderService?: RenderService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  if (isGroup(ctx as never)) {
    const groupId = getGroupId(ctx as never)!;
    const timezone = groupRepo?.getTimezone(groupId) ?? null;
    if (!timezone) {
      await ctx.send(
        lang === 'ru'
          ? '⚙️ Сначала задайте таймзону группы через /settings'
          : '⚙️ Set the group timezone first via /settings',
      );
      return;
    }
    const tzNow = new TZDate(new Date(), timezone);
    const tzTomorrow = addDays(tzNow, 1);
    const dayStart = new TZDate(
      new Date(tzTomorrow.getFullYear(), tzTomorrow.getMonth(), tzTomorrow.getDate(), 0, 0, 0),
      timezone,
    );
    const dayEnd = new TZDate(
      new Date(tzTomorrow.getFullYear(), tzTomorrow.getMonth(), tzTomorrow.getDate(), 23, 59, 59, 999),
      timezone,
    );
    const occurrences = eventService.getEventsInRangeForGroup(groupId, dayStart.toISOString(), dayEnd.toISOString());
    const holidays = holidayService?.getHolidaysForDate(user.telegram_id, dayStart.toISOString().slice(0, 10)) ?? [];
    const text = formatDayAgenda(occurrences, dayStart.toISOString(), timezone, lang, holidays);
    await ctx.send(text, { parse_mode: 'HTML' });
    return;
  }

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
