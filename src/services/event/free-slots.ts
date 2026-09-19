import type { CalendarEvent, EventOccurrence, GroupMember } from '../../database/types.ts';
import { getDayRangeUtc, localCalendarDate } from '../../utils/date.ts';
import { logger } from '../../utils/logger.ts';

const freeSlotsLogger = logger.child({ module: 'free-slots' });

/** Time an event without a usable end is assumed to occupy. */
const DEFAULT_BLOCK_MINUTES = 30;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_BLOCK_MS = DEFAULT_BLOCK_MINUTES * MINUTE_MS;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

interface TimeSpan {
  startMs: number;
  endMs: number;
}

/**
 * Epoch ms of a stored timestamp. SQLite `datetime('now')` values have a space
 * separator and no zone (UTC); ISO values carry `T` and a zone. Comparing the
 * strings lexically mixes the two spellings, so callers compare these numbers.
 */
function storedInstantMs(value: string): number {
  return Date.parse(SQLITE_DATETIME.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}

/** Whether an occurrence start falls inside the member's joined/left window; unreadable bounds deny. */
export function isWithinMembership(occurrenceStart: string, membership: GroupMember): boolean {
  const startMs = storedInstantMs(occurrenceStart);
  const joinedMs = storedInstantMs(membership.joined_at);
  const leftMs = membership.left_at ? storedInstantMs(membership.left_at) : Number.POSITIVE_INFINITY;
  return startMs >= joinedMs && startMs < leftMs;
}

function templateDurationMs(template: CalendarEvent): number {
  if (!template.end_at) return 0;
  const durationMs = Date.parse(template.end_at) - Date.parse(template.start_at);
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
}

/**
 * Range to expand a recurring template over so that every occurrence touching
 * [startUtc, endUtc] is produced. `expandRecurrence` keeps only occurrences whose
 * START lies in its range, so the range begins one occurrence length earlier.
 * All-day occurrences start at UTC midnight of a floating calendar date, which can
 * sit up to a day away from the requester's local day boundaries.
 */
export function recurrenceExpansionRange(
  template: CalendarEvent,
  startUtc: string,
  endUtc: string,
): { fromUtc: string; toUtc: string } {
  const allDayPadMs = template.all_day === 1 ? DAY_MS : 0;
  const lookbackMs = (templateDurationMs(template) || DEFAULT_BLOCK_MS) + allDayPadMs;
  return {
    fromUtc: new Date(Date.parse(startUtc) - lookbackMs).toISOString(),
    toUtc: new Date(Date.parse(endUtc) + allDayPadMs).toISOString(),
  };
}

/** Exceptions that were moved away from their original date, so range expansion never emits them. */
export function movedExceptionOccurrences(
  template: CalendarEvent,
  exceptions: CalendarEvent[],
  alreadyEmitted: EventOccurrence[],
): EventOccurrence[] {
  const emittedIds = new Set(alreadyEmitted.filter((o) => o.is_exception).map((o) => o.event.id));
  const durationMs = templateDurationMs(template);
  return exceptions
    .filter((exception) => !exception.is_cancelled && !emittedIds.has(exception.id))
    .map((exception) => ({
      event: exception,
      occurrence_start: exception.start_at,
      occurrence_end:
        exception.end_at ?? (durationMs ? new Date(Date.parse(exception.start_at) + durationMs).toISOString() : null),
      is_exception: true,
    }));
}

function nextCalendarDate(dateIso: string): string {
  const next = new Date(`${dateIso}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function localDayStartMs(dateIso: string, timezone: string): number {
  return Date.parse(getDayRangeUtc(localCalendarDate(dateIso, timezone), timezone).start);
}

/** All-day values are floating calendar dates: they occupy the requester's local day(s), not a UTC instant. */
function allDaySpan(occurrence: EventOccurrence, timezone: string): TimeSpan | null {
  const firstDate = occurrence.occurrence_start.slice(0, 10);
  if (!DATE_ONLY.test(firstDate)) return null;
  // A later end date is exclusive (Google convention); anything else is a single day.
  const endDate = occurrence.occurrence_end?.slice(0, 10);
  const lastDateExclusive =
    endDate && DATE_ONLY.test(endDate) && endDate > firstDate ? endDate : nextCalendarDate(firstDate);
  try {
    return { startMs: localDayStartMs(firstDate, timezone), endMs: localDayStartMs(lastDateExclusive, timezone) };
  } catch {
    // An impossible calendar date is unreadable data; the caller treats null as busy.
    return null;
  }
}

function timedSpan(occurrence: EventOccurrence): TimeSpan | null {
  const startMs = Date.parse(occurrence.occurrence_start);
  if (Number.isNaN(startMs)) return null;
  const endMs = occurrence.occurrence_end ? Date.parse(occurrence.occurrence_end) : Number.NaN;
  return { startMs, endMs: endMs > startMs ? endMs : startMs + DEFAULT_BLOCK_MS };
}

/** The time an occurrence occupies, or null when its stored times cannot be read. */
function occurrenceBusySpan(occurrence: EventOccurrence, timezone: string): TimeSpan | null {
  return occurrence.event.all_day === 1 ? allDaySpan(occurrence, timezone) : timedSpan(occurrence);
}

function clipToWindow(spans: TimeSpan[], window: TimeSpan): TimeSpan[] {
  return spans
    .map((span) => ({ startMs: Math.max(span.startMs, window.startMs), endMs: Math.min(span.endMs, window.endMs) }))
    .filter((span) => span.endMs > span.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

function mergeSorted(spans: TimeSpan[]): TimeSpan[] {
  const merged: TimeSpan[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function gapsAround(busy: TimeSpan[], window: TimeSpan): TimeSpan[] {
  const gaps: TimeSpan[] = [];
  let cursor = window.startMs;
  for (const span of busy) {
    if (span.startMs > cursor) gaps.push({ startMs: cursor, endMs: span.startMs });
    cursor = span.endMs;
  }
  if (cursor < window.endMs) gaps.push({ startMs: cursor, endMs: window.endMs });
  return gaps;
}

function busySpans(occurrences: EventOccurrence[], window: TimeSpan, timezone: string): TimeSpan[] {
  const spans: TimeSpan[] = [];
  for (const occurrence of occurrences) {
    const span = occurrenceBusySpan(occurrence, timezone);
    if (span) {
      spans.push(span);
      continue;
    }
    // Unreadable stored times: an event that cannot be placed must not read as free time.
    freeSlotsLogger.warn(
      { eventId: occurrence.event.id, startAt: occurrence.occurrence_start },
      'Unreadable event time treated as busy for the whole window',
    );
    spans.push(window);
  }
  return spans;
}

/** Free time inside `window`: busy spans clipped to the window, merged, and inverted. */
export function computeFreeSpans(occurrences: EventOccurrence[], window: TimeSpan, timezone: string): TimeSpan[] {
  const busy = mergeSorted(clipToWindow(busySpans(occurrences, window, timezone), window));
  return gapsAround(busy, window);
}
