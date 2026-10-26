// Clock anchors for benchmark runs: the local day and wall time "now" is frozen to. The default anchor is a fixed
// week in the past (Monday 2026-10-05 plus the conversation's weekday), so relative words and weekday names have a
// known meaning; matrix anchors put the same conversations on either side of every DST transition of a zone.
import { TZDate } from '@date-fns/tz';
import { type Conversation, isoOf, type LocalDay, shiftDay, WEEKDAYS } from './history.ts';

const ANCHOR_MONDAY: LocalDay = { y: 2026, m: 10, d: 5 };

export interface Anchor {
  label: string;
  tz: string;
  /** Local calendar day "today" is on. */
  date: LocalDay;
  /** Local wall time, "HH:MM". */
  at: string;
  /** The frozen instant. */
  instantMs: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** The instant of a local wall time; a time inside a DST gap resolves to the instant TZDate gives (after the gap). */
export function localInstant(tz: string, day: LocalDay, at: string): number {
  const [hour, minute] = at.split(':').map(Number) as [number, number];
  return new TZDate(day.y, day.m - 1, day.d, hour, minute, 0, tz).getTime();
}

export function anchorOf(tz: string, date: LocalDay, at: string, label: string): Anchor {
  return { label, tz, date, at, instantMs: localInstant(tz, date, at) };
}

export function defaultAnchor(conversation: Pick<Conversation, 'tz' | 'clock' | 'date'>): Anchor {
  if (conversation.date) {
    const [y, m, d] = conversation.date.split('-').map(Number) as [number, number, number];
    return anchorOf(conversation.tz, { y, m, d }, conversation.clock.at, 'real');
  }
  const weekday = WEEKDAYS.indexOf(conversation.clock.day);
  return anchorOf(conversation.tz, shiftDay(ANCHOR_MONDAY, weekday), conversation.clock.at, 'default');
}

/** Monday-zero weekday index of a local day. */
export function weekdayIndex(day: LocalDay): number {
  return (new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay() + 6) % 7;
}

export const dayLabel = isoOf;

interface Transition {
  at: number;
  kind: 'forward' | 'back';
}

/** UTC instants in 2026 where the zone's offset changes, found by scanning hours. */
export function transitionsOf(tz: string): Transition[] {
  const out: Transition[] = [];
  let previous = new TZDate(Date.UTC(2026, 0, 1), tz).getTimezoneOffset();
  for (let hour = 1; hour < 365 * 24; hour++) {
    const instant = Date.UTC(2026, 0, 1) + hour * 3_600_000;
    const offset = new TZDate(instant, tz).getTimezoneOffset();
    if (offset !== previous) {
      out.push({ at: instant, kind: offset < previous ? 'forward' : 'back' });
      previous = offset;
    }
  }
  return out;
}

function localDayAt(instantMs: number, tz: string): LocalDay {
  const local = new TZDate(instantMs, tz);
  return { y: local.getFullYear(), m: local.getMonth() + 1, d: local.getDate() };
}

/**
 * The frozen clocks of the TZ/DST matrix for one zone: an ordinary day, the night just after midnight, late evening,
 * and for each DST transition the eve, the transition day before and after the change, and the day after. The wall
 * time-of-day of the conversation's own clock is not used here; every anchor states its own time.
 */
export function matrixAnchors(tz: string): Anchor[] {
  const anchors: Anchor[] = [
    anchorOf(tz, shiftDay(ANCHOR_MONDAY, 1), '12:00', 'noon'),
    anchorOf(tz, shiftDay(ANCHOR_MONDAY, 2), '00:20', 'after_midnight'),
    anchorOf(tz, shiftDay(ANCHOR_MONDAY, 3), '23:40', 'late_evening'),
  ];
  for (const { at, kind } of transitionsOf(tz)) {
    const day = localDayAt(at, tz);
    anchors.push(
      anchorOf(tz, shiftDay(day, -1), '21:00', `${kind}_eve`),
      anchorOf(tz, day, '00:10', `${kind}_day_early`),
      anchorOf(tz, day, '09:00', `${kind}_day_morning`),
      anchorOf(tz, shiftDay(day, 1), '08:00', `${kind}_next_day`),
    );
  }
  return anchors.filter((anchor, index, all) => all.findIndex((other) => other.label === anchor.label) === index);
}

export const clockText = (anchor: Anchor): string => `${isoOf(anchor.date)}T${anchor.at} ${anchor.tz}`;
export { pad2 };
