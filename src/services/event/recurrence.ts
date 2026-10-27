import { TZDate } from '@date-fns/tz';
import { type RRule, type RRuleSet, rrulestr } from 'rrule';
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

  const durationMs = template.end_at ? new Date(template.end_at).getTime() - dtstart.getTime() : 0;
  const exceptionMap = buildExceptionMap(exceptions, adjustDst, template.timezone);

  const utcDates = expandUtcDates(rule, template, dtstart, new Date(rangeStartUtc), new Date(rangeEndUtc));

  const occurrences: EventOccurrence[] = [];
  for (const utcDate of utcDates) {
    const occStart = utcDate.toISOString();
    const occKey = adjustDst ? toLocalDateKey(occStart, template.timezone) : occStart;
    const occurrence = buildOccurrence(template, exceptionMap.get(occKey), utcDate, durationMs);
    if (occurrence) occurrences.push(occurrence);
  }

  return occurrences.sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start));
}

/** Occurrence instants within [rangeStart, rangeEnd], DST-adjusted to the template's local time for timed zoned events. */
function expandUtcDates(
  rule: RRule | RRuleSet,
  template: CalendarEvent,
  dtstart: Date,
  rangeStart: Date,
  rangeEnd: Date,
): Date[] {
  const adjustDst = !template.all_day && !!template.timezone;
  const local = adjustDst ? templateLocalTime(dtstart, template.timezone) : { h: 0, m: 0, s: 0 };

  // Pad range so occurrences that shift across the boundary after DST adjustment
  // aren't lost. Post-filter to the original range after conversion.
  const paddedStart = adjustDst ? new Date(rangeStart.getTime() - DST_PAD_MS) : rangeStart;
  const paddedEnd = adjustDst ? new Date(rangeEnd.getTime() + DST_PAD_MS) : rangeEnd;

  return rule
    .between(paddedStart, paddedEnd, true)
    .map((date) => (adjustDst ? adjustOccurrenceForDst(date, template.timezone, local.h, local.m, local.s) : date))
    .filter((utcDate) => !(utcDate.getTime() < rangeStart.getTime() || utcDate.getTime() > rangeEnd.getTime()));
}

/** Local wall-clock time-of-day of the template's first occurrence in its timezone */
function templateLocalTime(dtstart: Date, timezone: string): { h: number; m: number; s: number } {
  const tz = new TZDate(dtstart, timezone);
  return { h: tz.getHours(), m: tz.getMinutes(), s: tz.getSeconds() };
}

/**
 * Match exceptions by local calendar date when adjusting for DST — handles both
 * old exceptions (stored with pre-DST UTC) and new ones (stored with post-DST UTC).
 */
function buildExceptionMap(
  exceptions: CalendarEvent[],
  adjustDst: boolean,
  timezone: string,
): Map<string, CalendarEvent> {
  const exceptionMap = new Map<string, CalendarEvent>();
  for (const exc of exceptions) {
    if (!exc.original_start_at) continue;
    const key = adjustDst
      ? toLocalDateKey(exc.original_start_at, timezone)
      : new Date(exc.original_start_at).toISOString();
    exceptionMap.set(key, exc);
  }
  return exceptionMap;
}

/** Build the occurrence for one expanded date; null when the matching exception cancels it */
function buildOccurrence(
  template: CalendarEvent,
  exception: CalendarEvent | undefined,
  utcDate: Date,
  durationMs: number,
): EventOccurrence | null {
  if (!exception) {
    return {
      event: template,
      occurrence_start: utcDate.toISOString(),
      occurrence_end: durationMs ? new Date(utcDate.getTime() + durationMs).toISOString() : null,
      is_exception: false,
    };
  }
  if (exception.is_cancelled) return null;
  const occEnd =
    exception.end_at ??
    (durationMs ? new Date(new Date(exception.start_at).getTime() + durationMs).toISOString() : null);
  return {
    event: exception,
    occurrence_start: exception.start_at,
    occurrence_end: occEnd,
    is_exception: true,
  };
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
