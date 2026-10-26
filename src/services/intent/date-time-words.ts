// Calendar-day and clock-time vocabulary shared by the typed bindings and the free-form event phrase parser.
// Pure table-driven parsing in the user's IANA zone; anything that cannot be read unambiguously throws
// WorkflowInputError so the caller stops before any tool runs. Calendar arithmetic is independent of UTC offsets.
import { TZDate } from '@date-fns/tz';
import { normalize } from './normalizer.ts';
import { WorkflowInputError } from './workflow-input.ts';

export const fail = (): never => {
  throw new WorkflowInputError('INVALID_INPUT');
};
export const pad2 = (n: number): string => String(n).padStart(2, '0');

export interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

export function isoDay({ y, m, d }: CalendarDay): string {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

export function addDays(day: CalendarDay, delta: number): CalendarDay {
  const moved = new Date(Date.UTC(day.y, day.m - 1, day.d + delta));
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate() };
}

export function weekdayMondayZero(day: CalendarDay): number {
  return (new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay() + 6) % 7;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validDay(day: CalendarDay): boolean {
  return (
    day.y >= 1970 && day.y <= 2200 && day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= daysInMonth(day.y, day.m)
  );
}

export function today(now: Date, timezone: string): CalendarDay {
  const local = new TZDate(now, timezone);
  return { y: local.getFullYear(), m: local.getMonth() + 1, d: local.getDate() };
}

export type DayWord = 'today' | 'tomorrow' | 'day_after_tomorrow' | 'yesterday';
export const DAY_WORD_OFFSETS: { [word in DayWord]: number } = {
  yesterday: -1,
  today: 0,
  tomorrow: 1,
  day_after_tomorrow: 2,
};

export const MONTHS: { [name: string]: number } = {
  январь: 1,
  января: 1,
  jan: 1,
  january: 1,
  февраль: 2,
  февраля: 2,
  feb: 2,
  february: 2,
  март: 3,
  марта: 3,
  mar: 3,
  march: 3,
  апрель: 4,
  апреля: 4,
  apr: 4,
  april: 4,
  май: 5,
  мая: 5,
  may: 5,
  июнь: 6,
  июня: 6,
  jun: 6,
  june: 6,
  июль: 7,
  июля: 7,
  jul: 7,
  july: 7,
  август: 8,
  августа: 8,
  aug: 8,
  august: 8,
  сентябрь: 9,
  сентября: 9,
  sep: 9,
  sept: 9,
  september: 9,
  октябрь: 10,
  октября: 10,
  oct: 10,
  october: 10,
  ноябрь: 11,
  ноября: 11,
  nov: 11,
  november: 11,
  декабрь: 12,
  декабря: 12,
  dec: 12,
  december: 12,
};

/** Monday-zero index of every weekday spelling a user writes after "в"/"on"; accusative forms included. */
export const WEEKDAY_NAMES: { [name: string]: number } = {
  понедельник: 0,
  пн: 0,
  monday: 0,
  mon: 0,
  вторник: 1,
  вт: 1,
  tuesday: 1,
  tue: 1,
  tues: 1,
  среда: 2,
  среду: 2,
  ср: 2,
  wednesday: 2,
  wed: 2,
  четверг: 3,
  чт: 3,
  thursday: 3,
  thu: 3,
  thur: 3,
  thurs: 3,
  пятница: 4,
  пятницу: 4,
  пт: 4,
  friday: 4,
  fri: 4,
  суббота: 5,
  субботу: 5,
  сб: 5,
  saturday: 5,
  sat: 5,
  воскресенье: 6,
  вс: 6,
  sunday: 6,
  sun: 6,
};

export interface AbsoluteDay {
  y?: number;
  m: number;
  d: number;
}

export function parseAbsoluteDay(text: string): { day: AbsoluteDay } | null {
  const iso = /^(\d{4})[-./\s](\d{1,2})[-./\s](\d{1,2})$/.exec(text);
  if (iso) return { day: { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) } };
  const numeric = /^(\d{1,2})[-./\s](\d{1,2})(?:[-./\s](\d{4}))?$/.exec(text);
  if (numeric) {
    return { day: { ...(numeric[3] ? { y: Number(numeric[3]) } : {}), m: Number(numeric[2]), d: Number(numeric[1]) } };
  }
  const dayFirst = /^(\d{1,2})\s+([a-zа-яё]{3,9})(?:\s+(\d{4}))?$/.exec(text);
  if (dayFirst && Object.hasOwn(MONTHS, dayFirst[2]!)) {
    return {
      day: { ...(dayFirst[3] ? { y: Number(dayFirst[3]) } : {}), m: MONTHS[dayFirst[2]!]!, d: Number(dayFirst[1]) },
    };
  }
  const monthFirst = /^([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/.exec(text);
  if (monthFirst && Object.hasOwn(MONTHS, monthFirst[1]!)) {
    return {
      day: {
        ...(monthFirst[3] ? { y: Number(monthFirst[3]) } : {}),
        m: MONTHS[monthFirst[1]!]!,
        d: Number(monthFirst[2]),
      },
    };
  }
  return null;
}

/** Until this local hour, 'today' and 'tomorrow' may still count from the day that has just ended. */
export const AFTER_MIDNIGHT_END_HOUR = 4;

export interface DateOptions {
  words?: { [phrase: string]: DayWord };
  future?: boolean;
  after_midnight?: 'both';
}

// The preposition must be a word of its own: "вторник" must not lose its "в".
const WEEKDAY_PHRASE = /^(?:(?:в|во|on)\s+)?([a-zа-я]{2,12})$/;
const THROUGH_DAYS = /^(?:через|in)\s+(\d{1,3})\s+(дн(?:я|ей)|день|days?|недел(?:ю|и|ь)|weeks?)$/;
const THROUGH_ONE_WEEK = /^(?:через|in)\s+(?:(?:одну|1)\s+)?(?:недел(?:ю)|week)$/;

/**
 * A weekday name is the next such day strictly after today. Saying today's own weekday is ambiguous
 * (today or in a week) and is never guessed. "Через N дней" counts calendar days from today.
 */
function relativeDay(key: string, current: CalendarDay): CalendarDay | null {
  const through = THROUGH_DAYS.exec(key);
  if (through) {
    const count = Number(through[1]);
    const weeks = /^(?:недел|week)/.test(through[2]!);
    return count >= 1 && count <= 366 ? addDays(current, weeks ? count * 7 : count) : fail();
  }
  if (THROUGH_ONE_WEEK.test(key)) return addDays(current, 7);
  const weekday = WEEKDAY_PHRASE.exec(key);
  if (weekday && Object.hasOwn(WEEKDAY_NAMES, weekday[1]!)) {
    const target = WEEKDAY_NAMES[weekday[1]!]!;
    const delta = (target - weekdayMondayZero(current) + 7) % 7;
    return delta === 0 ? fail() : addDays(current, delta);
  }
  return null;
}

/** `dayBefore` reads a marked word said just after midnight as counted from the day that has just ended. */
export function parseDate(raw: string, options: DateOptions, now: Date, timezone: string, dayBefore: boolean): string {
  const key = normalize(raw);
  const current = today(now, timezone);
  const word = options.words && Object.hasOwn(options.words, key) ? options.words[key] : undefined;
  if (word) {
    // Someone still awake at 01:22 on Monday may say 'tomorrow' for Monday and 'today' for Sunday.
    const fromDayBefore =
      dayBefore &&
      options.after_midnight === 'both' &&
      (word === 'today' || word === 'tomorrow') &&
      new TZDate(now, timezone).getHours() < AFTER_MIDNIGHT_END_HOUR;
    return isoDay(addDays(current, DAY_WORD_OFFSETS[word] - (fromDayBefore ? 1 : 0)));
  }
  const relative = relativeDay(key, current);
  if (relative) return isoDay(relative);
  const parsed = parseAbsoluteDay(key);
  if (!parsed) return fail();
  const withYear = (year: number): CalendarDay => ({ y: year, m: parsed.day.m, d: parsed.day.d });
  let day = withYear(parsed.day.y ?? current.y);
  if (!validDay(day)) return fail();
  if (parsed.day.y === undefined && options.future && isoDay(day) < isoDay(current)) day = withYear(current.y + 1);
  return validDay(day) ? isoDay(day) : fail();
}

function hourFromSuffix(hour: number, suffix: string): number {
  if (suffix === 'am' || suffix === 'a m') return hour >= 1 && hour <= 12 ? hour % 12 : fail();
  if (suffix === 'pm' || suffix === 'p m') return hour >= 1 && hour <= 12 ? (hour % 12) + 12 : fail();
  if (suffix === 'утра') return hour >= 4 && hour <= 11 ? hour : fail();
  if (suffix === 'дня') return hour === 12 ? 12 : hour >= 1 && hour <= 6 ? hour + 12 : fail();
  if (suffix === 'вечера') return hour >= 4 && hour <= 11 ? hour + 12 : fail();
  if (suffix === 'ночи')
    return hour === 12 ? 0 : hour >= 1 && hour <= 5 ? hour : hour >= 9 && hour <= 11 ? hour + 12 : fail();
  return fail();
}

/** A bare hour from 1 to 12 is ambiguous between morning and evening and is never guessed. */
export function parseTime(raw: string): string {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === 'полдень' || text === 'noon') return '12:00';
  if (text === 'полночь' || text === 'midnight') return '00:00';
  const match = /^(\d{1,2})(?:[:.\s](\d{2}))?(?: ?(am|pm|a m|p m|утра|дня|вечера|ночи))?(?: ?час(?:а|ов)?)?$/.exec(
    text,
  );
  if (!match) return fail();
  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (minute > 59) return fail();
  let resolved: number;
  if (match[3]) resolved = hourFromSuffix(hour, match[3]);
  else if (hour > 23) return fail();
  else if (match[2] === undefined && hour >= 1 && hour <= 12) return fail();
  else resolved = hour;
  return `${pad2(resolved)}:${pad2(minute)}`;
}
