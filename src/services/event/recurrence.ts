import { TZDate } from '@date-fns/tz';
import { rrulestr } from 'rrule';
import type { CalendarEvent, EventOccurrence } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';

const recurrenceLogger = logger.child({ module: 'recurrence' });

/** Pad range by ±3h to catch occurrences that shift across boundaries after DST adjustment */
const DST_PAD_MS = 3 * 60 * 60_000;

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

  // Always expand in pure UTC — rrule's TZID output is system-timezone-dependent
  // (local time leaked into getUTC* accessors). We expand in UTC and adjust each
  // occurrence for DST ourselves using TZDate.
  const rruleString = `DTSTART:${formatRRuleDate(dtstart)}\n${rruleLine}`;
  const rule = rrulestr(rruleString);

  // For timed events with a timezone, extract the template's local time
  // so we can reconstruct the correct UTC for each occurrence's DST offset.
  const adjustDst = !template.all_day && !!template.timezone;
  let localH = 0;
  let localM = 0;
  let localS = 0;
  if (adjustDst) {
    const tz = new TZDate(dtstart, template.timezone);
    localH = tz.getHours();
    localM = tz.getMinutes();
    localS = tz.getSeconds();
  }

  const durationMs = template.end_at ? new Date(template.end_at).getTime() - dtstart.getTime() : 0;

  // Match exceptions by local calendar date when adjusting for DST — handles both
  // old exceptions (stored with pre-DST UTC) and new ones (stored with post-DST UTC).
  const exceptionMap = new Map<string, CalendarEvent>();
  for (const exc of exceptions) {
    if (exc.original_start_at) {
      const key = adjustDst
        ? toLocalDateKey(exc.original_start_at, template.timezone)
        : new Date(exc.original_start_at).toISOString();
      exceptionMap.set(key, exc);
    }
  }

  const rangeStart = new Date(rangeStartUtc);
  const rangeEnd = new Date(rangeEndUtc);

  // Pad range so occurrences that shift across the boundary after DST adjustment
  // aren't lost. Post-filter to the original range after conversion.
  const paddedStart = adjustDst ? new Date(rangeStart.getTime() - DST_PAD_MS) : rangeStart;
  const paddedEnd = adjustDst ? new Date(rangeEnd.getTime() + DST_PAD_MS) : rangeEnd;
  const dates = rule.between(paddedStart, paddedEnd, true);

  const occurrences: EventOccurrence[] = [];

  for (const date of dates) {
    const utcDate = adjustDst ? adjustOccurrenceForDst(date, template.timezone, localH, localM, localS) : date;
    if (utcDate.getTime() < rangeStart.getTime() || utcDate.getTime() > rangeEnd.getTime()) continue;

    const occStart = utcDate.toISOString();
    const occKey = adjustDst ? toLocalDateKey(occStart, template.timezone) : occStart;
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
      const occEnd = durationMs ? new Date(utcDate.getTime() + durationMs).toISOString() : null;
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

/** Format a UTC Date for rrule DTSTART (e.g. `20260301T090000Z`) */
function formatRRuleDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * Adjust an occurrence from template UTC time to the correct UTC time
 * for the event's local wall-clock time on that local calendar date.
 *
 * Example: template at 12:30 Belgrade (11:30 UTC in CET).
 * On a summer occurrence, 12:30 Belgrade = 10:30 UTC (CEST).
 * This function converts 11:30 UTC → 10:30 UTC.
 */
function adjustOccurrenceForDst(date: Date, timezone: string, h: number, m: number, s: number): Date {
  // Determine which local calendar date this UTC occurrence maps to
  const occTz = new TZDate(date, timezone);
  // Construct a TZDate at midnight UTC on that local date, then set the
  // event's intended local time — TZDate applies DST rules for this date.
  const local = new TZDate(new Date(Date.UTC(occTz.getFullYear(), occTz.getMonth(), occTz.getDate())), timezone);
  local.setHours(h, m, s, 0);
  return new Date(local.getTime());
}

/** Extract local calendar date string (YYYY-MM-DD) from a UTC ISO timestamp */
function toLocalDateKey(utcIso: string, timezone: string): string {
  const tz = new TZDate(new Date(utcIso), timezone);
  return `${tz.getFullYear()}-${String(tz.getMonth() + 1).padStart(2, '0')}-${String(tz.getDate()).padStart(2, '0')}`;
}
