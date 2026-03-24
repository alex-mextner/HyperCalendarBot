import { rrulestr } from 'rrule';
import type { CalendarEvent, EventOccurrence } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';

const recurrenceLogger = logger.child({ module: 'recurrence' });

export function expandRecurrence(
  template: CalendarEvent,
  exceptions: CalendarEvent[],
  rangeStartUtc: string,
  rangeEndUtc: string,
): EventOccurrence[] {
  if (!template.recurrence_rule) return [];

  const dtstart = new Date(template.start_at);
  if (Number.isNaN(dtstart.getTime())) {
    recurrenceLogger.warn(
      { eventId: template.id, startAt: template.start_at },
      'Skipping event with invalid start_at date',
    );
    return [];
  }
  const rruleString = `DTSTART:${formatRRuleDate(dtstart)}\nRRULE:${template.recurrence_rule}`;
  const rule = rrulestr(rruleString);

  const durationMs = template.end_at ? new Date(template.end_at).getTime() - new Date(template.start_at).getTime() : 0;

  const exceptionMap = new Map<string, CalendarEvent>();
  for (const exc of exceptions) {
    if (exc.original_start_at) {
      const key = new Date(exc.original_start_at).toISOString();
      exceptionMap.set(key, exc);
    }
  }

  const rangeStart = new Date(rangeStartUtc);
  const rangeEnd = new Date(rangeEndUtc);
  const dates = rule.between(rangeStart, rangeEnd, true);

  const occurrences: EventOccurrence[] = [];

  for (const date of dates) {
    const occStart = date.toISOString();
    const occKey = occStart;
    const exception = exceptionMap.get(occKey);

    if (exception) {
      if (exception.is_cancelled) {
        continue;
      }
      const occEnd =
        exception.end_at ??
        (durationMs ? new Date(new Date(exception.start_at).getTime() + durationMs).toISOString() : null);
      occurrences.push({
        event: exception,
        occurrence_start: exception.start_at,
        occurrence_end: occEnd,
        is_exception: true,
      });
    } else {
      const occEnd = durationMs ? new Date(date.getTime() + durationMs).toISOString() : null;
      occurrences.push({
        event: template,
        occurrence_start: occStart,
        occurrence_end: occEnd,
        is_exception: false,
      });
    }
  }

  return occurrences.sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start));
}

function formatRRuleDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
