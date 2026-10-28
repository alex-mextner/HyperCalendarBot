// get_events range handling: turns the model's start_date/end_date strings into the exact instants
// the SQLite query and the empty-agenda formatter share, in the user's IANA zone.
import { getDayRangeUtc, localCalendarDate } from '../../../../utils/date.ts';
import type { AgendaInterval } from '../../empty-agenda.ts';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?$/;
const UTC_DAY_START_RE = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/;
const UTC_DAY_END_RE = /^(\d{4}-\d{2}-\d{2})T23:59:59(?:\.999)?Z$/;

/** UTC edges of a local calendar day. Throws on an impossible date, so callers validate first. */
export function expandDateOnly(dateStr: string, timezone: string): { start: string; end: string } {
  // Built from components in the user's zone: an offset-less string would be parsed in the host
  // zone and land on the next local day for UTC+13/+14 users.
  return getDayRangeUtc(localCalendarDate(dateStr, timezone), timezone);
}

/** True for a real calendar date; `new Date` would silently roll 2026-02-30 over into March. */
export function isRealCalendarDate(dateOnly: string): boolean {
  try {
    localCalendarDate(dateOnly, 'UTC');
    return true;
  } catch {
    // An impossible date is invalid caller input, reported as INVALID_RANGE by the handler.
    return false;
  }
}

/**
 * One get_events bound as an instant. A date-only value is the edge of that local day; a datetime
 * without an offset is UTC, as the tool contract states (a pair of UTC day edges is first turned
 * into local days by `localDaysForUtcDayEdges`). Anything else is null, so the formatter and the
 * SQLite query can never read the same string as two different instants.
 */
export function parseRangeBound(value: string, timezone: string, edge: 'start' | 'end'): Date | null {
  if (!isRealCalendarDate(value.slice(0, 10))) return null;
  if (DATE_ONLY_RE.test(value)) return new Date(expandDateOnly(value, timezone)[edge]);
  const match = DATETIME_RE.exec(value);
  if (!match) return null;
  const [, date, time, offset] = match;
  // Canonical ISO for `new Date`: "T" separator, millisecond precision, "+HH:MM" offset, UTC default.
  const zone = offset === undefined ? 'Z' : offset.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const instant = new Date(`${date}T${time?.replace(/(\.\d{3})\d+$/, '$1')}${zone}`);
  return Number.isFinite(instant.getTime()) ? instant : null;
}

/**
 * Models often send a user's day as UTC day edges (`…T00:00:00Z`..`…T23:59:59Z`). Outside UTC that
 * window is shifted by the offset: it misses the day's early events and takes in the next day's
 * (#550). Such a pair is read as those local days; any other instant, an explicit offset or half a
 * pair stays verbatim, and a zone at UTC on those days keeps the exact input. The day-reference
 * guard judges a get_events call by these same bounds, so it checks the days actually read.
 */
export function localDaysForUtcDayEdges(
  input: { start_date: string; end_date: string },
  timezone: string,
): { start_date: string; end_date: string } {
  const startDay = UTC_DAY_START_RE.exec(input.start_date)?.[1];
  const endDay = UTC_DAY_END_RE.exec(input.end_date)?.[1];
  // The date checks also keep an impossible day (2026-02-30) out of expandDateOnly, which throws.
  if (!startDay || !endDay || !isRealCalendarDate(startDay) || !isRealCalendarDate(endDay)) return input;
  const utcEquivalent =
    expandDateOnly(startDay, timezone).start === `${startDay}T00:00:00.000Z` &&
    expandDateOnly(endDay, timezone).end === `${endDay}T23:59:59.999Z`;
  return utcEquivalent ? input : { start_date: startDay, end_date: endDay };
}

export function resolveRangeInterval(
  input: { start_date: string; end_date: string },
  timezone: string,
): AgendaInterval | null {
  const bounds = localDaysForUtcDayEdges(input, timezone);
  const start = parseRangeBound(bounds.start_date, timezone, 'start');
  const end = parseRangeBound(bounds.end_date, timezone, 'end');
  if (!start || !end || start.getTime() >= end.getTime()) return null;
  return { start, end };
}
