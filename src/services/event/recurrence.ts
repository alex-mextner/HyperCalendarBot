import { TZDate } from '@date-fns/tz';
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
  const rruleLine =
    template.recurrence_rule.split('\n').find((line) => line.startsWith('RRULE:')) ?? template.recurrence_rule;

  // Use TZID-aware DTSTART for timed events so rrule preserves local wall-clock
  // time across DST transitions. All-day events stay in UTC (only the date matters).
  const useTzid = !template.all_day && !!template.timezone;
  let rruleString: string;
  if (useTzid) {
    const localDtstart = new TZDate(dtstart, template.timezone);
    rruleString = `DTSTART;TZID=${template.timezone}:${formatRRuleDateLocal(localDtstart)}\n${rruleLine}`;
  } else {
    rruleString = `DTSTART:${formatRRuleDate(dtstart)}\n${rruleLine}`;
  }
  const rule = rrulestr(rruleString);

  const durationMs = template.end_at ? new Date(template.end_at).getTime() - new Date(template.start_at).getTime() : 0;

  // Match exceptions by local calendar date when using TZID — handles both old
  // exceptions (stored with pre-DST UTC) and new ones (stored with post-DST UTC).
  const exceptionMap = new Map<string, CalendarEvent>();
  for (const exc of exceptions) {
    if (exc.original_start_at) {
      const key = useTzid
        ? toLocalDateKey(exc.original_start_at, template.timezone)
        : new Date(exc.original_start_at).toISOString();
      exceptionMap.set(key, exc);
    }
  }

  const rangeStart = new Date(rangeStartUtc);
  const rangeEnd = new Date(rangeEndUtc);
  const dates = rule.between(rangeStart, rangeEnd, true);

  const occurrences: EventOccurrence[] = [];

  for (const date of dates) {
    const occStart = date.toISOString();
    const occKey = useTzid ? toLocalDateKey(occStart, template.timezone) : occStart;
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

/** Format a UTC Date for DTSTART without TZID (e.g. `20260301T090000Z`) */
function formatRRuleDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Format a TZDate in local time for DTSTART;TZID (e.g. `20260301T120000`, no Z suffix) */
function formatRRuleDateLocal(date: TZDate): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}`;
}

/** Extract local calendar date string (YYYY-MM-DD) from a UTC ISO timestamp */
function toLocalDateKey(utcIso: string, timezone: string): string {
  const tz = new TZDate(new Date(utcIso), timezone);
  return `${tz.getFullYear()}-${String(tz.getMonth() + 1).padStart(2, '0')}-${String(tz.getDate()).padStart(2, '0')}`;
}
