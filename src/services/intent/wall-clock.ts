import { TZDate } from '@date-fns/tz';

/** Wall-clock helpers shared by typed bindings and event-time arithmetic; independent of the host zone. */

export interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

export const pad2 = (n: number): string => String(n).padStart(2, '0');

function offsetMinutesAt(utcMs: number, timezone: string): number {
  return -new TZDate(utcMs, timezone).getTimezoneOffset();
}

function formatOffset(minutes: number): string {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export function formatLocalInstant(utcMs: number, timezone: string): string {
  const local = new TZDate(utcMs, timezone);
  const stamp =
    `${String(local.getFullYear()).padStart(4, '0')}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}` +
    `T${pad2(local.getHours())}:${pad2(local.getMinutes())}:00`;
  return `${stamp}${formatOffset(offsetMinutesAt(utcMs, timezone))}`;
}

/** Local calendar day and HH:MM of an instant in an IANA zone. */
export function localParts(utcMs: number, timezone: string): { date: string; time: string } {
  const local = new TZDate(utcMs, timezone);
  return {
    date: `${String(local.getFullYear()).padStart(4, '0')}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`,
    time: `${pad2(local.getHours())}:${pad2(local.getMinutes())}`,
  };
}

/**
 * Resolve a wall-clock time in an IANA zone to exactly one instant. A time skipped by a
 * clock change or repeated by one has zero or two instants and yields null, never a guess.
 */
export function uniqueInstant(day: CalendarDay, hour: number, minute: number, timezone: string): number | null {
  const wall = Date.UTC(day.y, day.m - 1, day.d, hour, minute);
  const candidates = new Set<number>();
  for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) {
    const offset = offsetMinutesAt(probe, timezone);
    const instant = wall - offset * 60_000;
    if (offsetMinutesAt(instant, timezone) === offset) candidates.add(instant);
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}
