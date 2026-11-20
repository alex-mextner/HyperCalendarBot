// src/database/repositories/event-duplicate-match.ts
// Pure comparisons EventRepository.createUnlessDuplicate uses to decide whether a create repeats a saved event.
import type { CreateEventData } from '../types.ts';

export type CreateOutcome = 'created' | 'duplicate' | 'same_day';

/** The calendar day (YYYY-MM-DD) an instant falls on in `timezone`. */
export function localDay(instant: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(instant));
  } catch {
    return instant.slice(0, 10);
  }
}

/** Timed events are the same span when start and end are the same instants, however the offset is spelled. */
export function sameInstants(data: CreateEventData) {
  const start = Date.parse(data.start_at);
  const end = data.end_at ? Date.parse(data.end_at) : null;
  return (c: { start_at: string; end_at: string | null }) =>
    Date.parse(c.start_at) === start && (c.end_at ? Date.parse(c.end_at) : null) === end;
}

/** What the caller stated beyond title and time (description, location, reminders) must not differ from the saved row. */
export function sameDetails(
  data: CreateEventData,
  saved: { description: string | null; location: string | null; reminder_overrides: string | null },
): boolean {
  const same = (stated: string | undefined, have: string | null) =>
    stated === undefined || stated.trim() === (have ?? '').trim();
  return (
    same(data.description, saved.description) &&
    same(data.location, saved.location) &&
    (data.reminder_minutes === undefined ||
      JSON.stringify(data.reminder_minutes) === JSON.stringify(parseMinutes(saved.reminder_overrides)))
  );
}

function parseMinutes(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Titles are the same event's when they differ only in surrounding or repeated whitespace, case or Unicode form. */
export function normalizedTitle(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
