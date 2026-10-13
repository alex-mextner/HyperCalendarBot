// src/services/calendar/wall-clock.ts
//
// Pure proleptic-calendar-day and DST-aware instant arithmetic. No network/DB access,
// no reads of the system clock — every function takes its day/time/zone explicitly, so
// callers own the "now" and results are fully deterministic for a given input.
//
// A wall-clock helper with the same shape (CalendarDay, a DST-aware probe-based instant
// resolver, offset formatting) is sketched, unfinished, in the unmerged, dirty
// `feat/contextual-intents-20260919` worktree (#334) at
// `src/services/intent/wall-clock.ts` / `src/services/intent/event-time.ts` — see that
// worktree's `docs/superpowers/specs/2026-09-28-unified-calendar-dialogue-design.md` §3,
// which explicitly asks for interface reconciliation before treating it as a ready
// dependency. Neither file is importable from this branch (that worktree is not merged
// to main), so this is a fresh implementation deliberately shaped to match it, not a
// copy of it — a future #334 merge can adopt this module instead of diverging from it.
// That prototype's own `uniqueInstant` collapses both DST gap and DST fold to a single
// `null`; this module's `resolveWallInstant` distinguishes them (`'gap'` vs `'fold'`)
// because the shared parser must tell a user "that time doesn't exist" from "that time
// happened twice, which did you mean" — reconciling #334 onto this module, not the
// other way around, is GH-652's job.
//
// Used by wall-time-parser.ts to resolve a local wall-clock time to a UTC instant,
// rejecting times a clock change skipped (DST gap) or answering with both candidates
// for times a clock change repeated (DST fold) rather than silently picking one.

import { TZDate } from '@date-fns/tz';

export interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function isoDay(day: CalendarDay): string {
  return `${String(day.y).padStart(4, '0')}-${pad2(day.m)}-${pad2(day.d)}`;
}

/** Days in month `m` of year `y`, via the day-0-of-next-month idiom. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Rejects impossible calendar dates (Feb 30, month 13, ...) rather than letting them roll over. */
export function validCalendarDay(day: CalendarDay): boolean {
  return (
    Number.isInteger(day.y) &&
    Number.isInteger(day.m) &&
    Number.isInteger(day.d) &&
    day.y >= 1970 &&
    day.y <= 9999 &&
    day.m >= 1 &&
    day.m <= 12 &&
    day.d >= 1 &&
    day.d <= daysInMonth(day.y, day.m)
  );
}

/** Calendar arithmetic on the proleptic calendar; independent of any UTC offset or wall clock. */
export function addOneDay(day: CalendarDay): CalendarDay {
  const moved = new Date(Date.UTC(day.y, day.m - 1, day.d + 1));
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate() };
}

function offsetMinutesAt(utcMs: number, timezone: string): number {
  return -new TZDate(utcMs, timezone).getTimezoneOffset();
}

/** Renders a zone offset in `+HH:MM`/`-HH:MM` form. */
function formatOffset(minutes: number): string {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** The local calendar day + HH:MM + zone offset a candidate instant renders as, e.g. for a DST-fold choice. */
export function formatOffsetInstant(day: CalendarDay, hour: number, minute: number, offsetMinutes: number): string {
  return `${isoDay(day)}T${pad2(hour)}:${pad2(minute)}:00${formatOffset(offsetMinutes)}`;
}

export type WallInstantResolution =
  | { kind: 'unique'; ms: number }
  | { kind: 'gap' }
  | { kind: 'fold'; instants: readonly [WallInstantCandidate, WallInstantCandidate] };

export interface WallInstantCandidate {
  ms: number;
  offsetMinutes: number;
}

/**
 * Resolve a wall-clock time in an IANA zone to a UTC instant. A time skipped by a clock
 * change forward (spring-forward gap) has zero valid instants; a time repeated by a clock
 * change back (fall-back fold) has two. Both are reported explicitly — never guessed.
 */
export function resolveWallInstant(
  day: CalendarDay,
  hour: number,
  minute: number,
  timezone: string,
): WallInstantResolution {
  const wall = Date.UTC(day.y, day.m - 1, day.d, hour, minute);
  const candidates = new Map<number, number>();
  for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) {
    const offset = offsetMinutesAt(probe, timezone);
    const instant = wall - offset * 60_000;
    if (offsetMinutesAt(instant, timezone) === offset) candidates.set(instant, offset);
  }
  if (candidates.size === 0) return { kind: 'gap' };
  const sorted = [...candidates.entries()].sort(([a], [b]) => a - b);
  if (sorted.length === 1) {
    const [ms] = sorted[0]!;
    return { kind: 'unique', ms };
  }
  const [[firstMs, firstOffset], [secondMs, secondOffset]] = sorted as [[number, number], [number, number]];
  return {
    kind: 'fold',
    instants: [
      { ms: firstMs, offsetMinutes: firstOffset },
      { ms: secondMs, offsetMinutes: secondOffset },
    ],
  };
}

/**
 * UTC instant of local midnight for a calendar day in a zone, rendered with that zone's actual
 * offset (via `TZDate#toISOString`) so the date prefix always equals the calendar day — the
 * minimal storage shape an all-day event needs to survive julianday() range queries AND naive
 * date-prefix extraction (Google's `start.date`/`end.date`, `free-slots.ts`'s `allDaySpan`)
 * without a second schema or a UTC-midnight approximation that silently shifts in negative zones.
 * `null` when that midnight was skipped entirely by a clock change (e.g. Pacific/Apia's
 * 2011-12-30, erased outright when the International Date Line moved) — reject rather than
 * silently normalize onto a neighboring day. A repeated (fall-back) midnight resolves to its
 * earliest instant: the day boundary itself, not a chosen wall-clock time, has no ambiguity to ask
 * the user about.
 */
export function localMidnightInstant(day: CalendarDay, timezone: string): string | null {
  const resolution = resolveWallInstant(day, 0, 0, timezone);
  if (resolution.kind === 'gap') return null;
  const ms = resolution.kind === 'unique' ? resolution.ms : resolution.instants[0].ms;
  return new TZDate(ms, timezone).toISOString();
}
