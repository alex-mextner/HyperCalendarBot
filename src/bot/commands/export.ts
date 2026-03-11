// src/bot/commands/export.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User, CalendarEvent } from '../../database/types.ts';
import { generateIcs } from '../../services/ics/generator.ts';
import { getNDayRangeUtc } from '../../utils/date.ts';

export async function handleExport(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  // Export next 365 days of events — use occurrence dates, not template dates
  const { start, end } = getNDayRangeUtc(new Date(), 365, user.timezone);
  const occurrences = eventService.getEventsInRange(user.telegram_id, start, end);
  const events: CalendarEvent[] = occurrences.map(o => ({
    ...o.event,
    // Override with concrete occurrence dates (critical for recurring events)
    start_at: o.occurrence_start,
    end_at: o.occurrence_end ?? o.event.end_at,
    // Strip recurrence_rule — we export expanded occurrences, not templates
    recurrence_rule: null,
    recurrence_end_at: null,
  }));

  if (events.length === 0) {
    await ctx.send(lang === 'ru' ? 'Нет событий для экспорта.' : 'No events to export.');
    return;
  }

  const ics = generateIcs(events);
  const buffer = Buffer.from(ics, 'utf-8');

  await ctx.sendDocument({
    document: { filename: 'calendar.ics', value: buffer },
    caption: lang === 'ru'
      ? `📤 Экспортировано ${events.length} событий.`
      : `📤 Exported ${events.length} events.`,
  });
}
