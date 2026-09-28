// src/services/event/wall-clock.ts
//
// Resolves a local calendar wall-clock reading (Y-M-D H:M:S) in an IANA timezone to the
// real UTC instant(s) it denotes, distinguishing the two DST edge cases RFC 5545 leaves to
// the implementation: a spring-forward "gap" (the wall-clock reading never happens — e.g.
// 02:30 on the day clocks jump 02:00→03:00) and a fall-back "repeat" (the wall-clock reading
// happens twice, at two different UTC instants and offsets — e.g. 02:30 on the day clocks
// fall back 03:00→02:00). See docs/superpowers/specs/2026-09-28-recurrence-semantics-583.md §3.
//
// Used by recurrence.ts to turn each rrule-generated occurrence into a real UTC instant
// instead of blindly reapplying the template's own local time (see recurrence.ts's history
// note on the BYHOUR=10,14 bug this replaces), and by the exception-identity migration
// backfill to recompute which occurrence a legacy exception belongs to.

export type WallClockResolution =
  | { kind: 'unique'; instant: Date }
  | { kind: 'gap' }
  | { kind: 'ambiguous'; first: Date; second: Date };

export interface WallClock {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

function offsetMinutesAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  if (offsetPart === 'GMT') return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offsetPart);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export function wallClockAt(instant: Date, timezone: string): WallClock {
  const raw = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value] as const),
  );
  return {
    y: Number(raw.year),
    mo: Number(raw.month),
    d: Number(raw.day),
    h: Number(raw.hour),
    mi: Number(raw.minute),
    s: Number(raw.second),
  };
}

/**
 * Resolve a local wall-clock reading in `timezone` to the UTC instant(s) it denotes.
 *
 * Algorithm: read the UTC offset a full day before and a full day after the naive instant
 * (`Date.UTC(y, mo-1, d, h, mi, s)`, i.e. treating the wall-clock reading as if it were UTC).
 * A DST transition changes a zone's offset at most once within any ±24h window in every real
 * IANA zone, so these two offsets bracket any nearby transition. Each offset yields one
 * candidate UTC instant; a candidate is valid only if formatting it back through the zone
 * reproduces the exact wall-clock reading requested. Zero valid candidates = gap, one = the
 * unique answer, two = the fall-back repeat (returned earliest-first).
 */
export function resolveWallClock(wall: WallClock, timezone: string): WallClockResolution {
  const { y, mo, d, h, mi, s } = wall;
  const naiveUtcMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const DAY_MS = 24 * 60 * 60_000;
  const offsetBefore = offsetMinutesAt(new Date(naiveUtcMs - DAY_MS), timezone);
  const offsetAfter = offsetMinutesAt(new Date(naiveUtcMs + DAY_MS), timezone);

  const candidateMs = [...new Set([naiveUtcMs - offsetBefore * 60_000, naiveUtcMs - offsetAfter * 60_000])];
  const valid: number[] = [];
  for (const ms of candidateMs) {
    const reconstructed = wallClockAt(new Date(ms), timezone);
    if (
      reconstructed.y === y &&
      reconstructed.mo === mo &&
      reconstructed.d === d &&
      reconstructed.h === h &&
      reconstructed.mi === mi &&
      reconstructed.s === s
    ) {
      valid.push(ms);
    }
  }

  if (valid.length === 0) return { kind: 'gap' };
  valid.sort((a, b) => a - b);
  if (valid.length === 1) return { kind: 'unique', instant: new Date(valid[0]!) };
  return { kind: 'ambiguous', first: new Date(valid[0]!), second: new Date(valid[1]!) };
}

/**
 * Extract the wall-clock reading a "fake-UTC" rrule-generated Date represents: recurrence.ts
 * feeds rrule a DTSTART whose UTC getters hold the intended *local* Y-M-D H:M:S (rrule's own
 * TZID handling is system-timezone-dependent, so the engine expands in pure UTC and resolves
 * the real UTC instant itself via `resolveWallClock`).
 */
export function wallClockFromFakeUtc(date: Date): WallClock {
  return {
    y: date.getUTCFullYear(),
    mo: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    h: date.getUTCHours(),
    mi: date.getUTCMinutes(),
    s: date.getUTCSeconds(),
  };
}

/** Local calendar date (YYYY-MM-DD) that a real UTC instant falls on in `timezone`. */
export function toLocalDateKey(instant: Date, timezone: string): string {
  const wall = wallClockAt(instant, timezone);
  return `${wall.y}-${String(wall.mo).padStart(2, '0')}-${String(wall.d).padStart(2, '0')}`;
}
