/**
 * Wording for a get_events read that SUCCEEDED and found nothing.
 *
 * Reached from `handleGetEvents` (AI tool and intent workflows, whose output can be sent to the
 * user verbatim). It names the checked local day or window and the calendar that was read, so an
 * empty answer is informative instead of a database phrase like "no events in this range".
 *
 * Invariants:
 * - Only called after a successful read; a failed read must surface as an error, never as this text.
 * - The read matches events by their START: `[start, end)` for personal/delegated calendars and
 *   `[start, end]` for group calendars. An event that began earlier and still overlaps is NOT
 *   returned (#570), so every wording — day, range or window — says only that nothing STARTS there,
 *   never that the day or the person is free. An end at exactly local midnight is labelled as the
 *   previous day.
 * - Day arithmetic uses the user's IANA timezone, so 23h/25h DST days stay one calendar day.
 */
import { TZDate } from '@date-fns/tz';
import { type Lang, type Messages, t } from '../../config/constants.ts';

export type AgendaScope = 'personal' | 'group' | 'delegated';

export interface AgendaInterval {
  start: Date;
  end: Date;
}

interface EmptyAgendaInput {
  interval: AgendaInterval;
  timezone: string;
  language: Lang;
  scope: AgendaScope;
  now?: Date;
}

interface LocalMoment {
  /** Days since the epoch of the local calendar date — DST-independent. */
  dayIndex: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** True when the local time is exactly 00:00:00.000. */
  atMidnight: boolean;
  /**
   * True only at 23:59:59.999, the last instant a `[start, end)` read can cover; an end at
   * 23:59:59.000 leaves the final sub-second unread, so it is described as a window instead.
   */
  atEndOfDay: boolean;
}

type Shape =
  | { kind: 'days'; firstDay: number; lastDay: number; lastInstant: Date }
  | { kind: 'window'; sameDay: boolean };

export const DAY_MS = 86_400_000;

function toLocal(instant: Date, timezone: string): LocalMoment {
  const local = new TZDate(instant.getTime(), timezone);
  const hours = local.getHours();
  const minutes = local.getMinutes();
  const seconds = local.getSeconds();
  return {
    dayIndex: Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / DAY_MS,
    hours,
    minutes,
    seconds,
    atMidnight: hours === 0 && minutes === 0 && seconds === 0 && local.getMilliseconds() === 0,
    atEndOfDay: hours === 23 && minutes === 59 && seconds === 59 && local.getMilliseconds() === 999,
  };
}

/** Whole local days (an end at local midnight is exclusive) or a partial window. */
function classify(interval: AgendaInterval, start: LocalMoment, end: LocalMoment): Shape {
  if (start.atMidnight && (end.atMidnight || end.atEndOfDay)) {
    const exclusiveEnd = end.atMidnight;
    return {
      kind: 'days',
      firstDay: start.dayIndex,
      lastDay: exclusiveEnd ? end.dayIndex - 1 : end.dayIndex,
      lastInstant: exclusiveEnd ? new Date(interval.end.getTime() - 1) : interval.end,
    };
  }
  return { kind: 'window', sameDay: start.dayIndex === end.dayIndex };
}

export function relativeDayWord(
  words: Messages['aiTools']['events']['emptyAgenda']['relativeDay'],
  delta: number,
): string | null {
  if (delta === -1) return words.yesterday;
  if (delta === 0) return words.today;
  if (delta === 1) return words.tomorrow;
  if (delta === 2) return words.dayAfterTomorrow;
  return null;
}

function dateFormatter(language: Lang, timezone: string, includeYear: boolean): (instant: Date) => string {
  const format = new Intl.DateTimeFormat(language, {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    ...(includeYear ? { year: 'numeric' as const } : {}),
  });
  // Russian long dates end with the "г." year abbreviation, which reads bureaucratic in a chat.
  return (instant) => format.format(instant).replace(/\s*г\.$/, '');
}

/** HH:mm, or HH:mm:ss when seconds are set, so the label never names a wider window than was read. */
function timeLabel(moment: LocalMoment): string {
  const parts = [moment.hours, moment.minutes, ...(moment.seconds === 0 ? [] : [moment.seconds])];
  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}

function yearOf(instant: Date, timezone: string): number {
  return new TZDate(instant.getTime(), timezone).getFullYear();
}

export function formatEmptyAgenda(input: EmptyAgendaInput): string {
  const { interval, timezone, language, scope } = input;
  if (!(interval.start.getTime() < interval.end.getTime())) throw new RangeError('Invalid calendar interval');
  const now = input.now ?? new Date();
  const start = toLocal(interval.start, timezone);
  const end = toLocal(interval.end, timezone);
  const shape = classify(interval, start, end);
  const lastInstant = shape.kind === 'days' ? shape.lastInstant : interval.end;
  const years = new Set([interval.start, lastInstant, now].map((instant) => yearOf(instant, timezone)));
  const formatDate = dateFormatter(language, timezone, years.size > 1);
  const today = toLocal(now, timezone).dayIndex;
  const messages = t(language).aiTools.events.emptyAgenda;
  const calendar = messages.calendar[scope];
  const relative = relativeDayWord(messages.relativeDay, start.dayIndex - today);
  const firstDate = formatDate(interval.start);

  if (shape.kind === 'window') {
    const past = interval.end.getTime() <= now.getTime();
    if (shape.sameDay) {
      const template = past ? messages.windowPast : messages.window;
      return template(relative, firstDate, timeLabel(start), timeLabel(end), calendar);
    }
    const template = past ? messages.windowSpanPast : messages.windowSpan;
    return template(
      messages.dateTime(firstDate, timeLabel(start)),
      messages.dateTime(formatDate(interval.end), timeLabel(end)),
      calendar,
    );
  }
  if (shape.firstDay === shape.lastDay) {
    return shape.firstDay < today
      ? messages.dayPast(relative, firstDate, calendar)
      : messages.dayUpcoming(relative, firstDate, calendar);
  }
  const lastDate = formatDate(lastInstant);
  if (shape.lastDay < today) return messages.rangePast(firstDate, lastDate, calendar);
  if (shape.firstDay >= today) return messages.rangeUpcoming(firstDate, lastDate, calendar);
  return messages.rangeCurrent(firstDate, lastDate, calendar);
}
