import { TZDate } from '@date-fns/tz';
import { addDays, addMinutes, endOfDay, endOfWeek, format, parseISO, startOfDay, startOfWeek } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';

export function toUserTime(isoUtc: string, timezone: string): string {
  const d = new TZDate(isoUtc, timezone);
  return format(d, 'HH:mm');
}

export function formatTime(isoUtc: string, timezone: string): string {
  return toUserTime(isoUtc, timezone);
}

export function formatDateHeader(isoUtc: string, timezone: string, lang: string): string {
  const d = new TZDate(isoUtc, timezone);
  const locale = lang === 'ru' ? ru : enUS;
  return format(d, 'EEEE, MMMM d', { locale });
}

export function formatDateShort(isoUtc: string, timezone: string, lang: string): string {
  const d = new TZDate(isoUtc, timezone);
  const locale = lang === 'ru' ? ru : enUS;
  // ru: EEEEEE → 2-char weekday (пн, вт, ..., вс).
  // en: EEE → standard US 3-char weekday (Mon, Tue, ..., Sun).
  const pattern = lang === 'ru' ? 'EEEEEE d' : 'EEE d';
  return format(d, pattern, { locale });
}

/** "28 сентября" / "September 28" and the weekday name of a YYYY-MM-DD calendar day. */
export function describeCalendarDay(dayKey: string, lang: string): { day: string; weekday: string } {
  const date = parseISO(dayKey);
  const locale = lang === 'ru' ? ru : enUS;
  return {
    day: format(date, lang === 'ru' ? 'd MMMM' : 'MMMM d', { locale }),
    weekday: format(date, 'EEEE', { locale }),
  };
}

export function formatTimeRange(startUtc: string, endUtc: string | null, timezone: string): string {
  const start = toUserTime(startUtc, timezone);
  if (!endUtc) return start;
  return `${start}–${toUserTime(endUtc, timezone)}`;
}

const LOCAL_DAY = 'EEE yyyy-MM-dd';

/**
 * The calendar date an all-day value stands for. Date-only values and UTC midnights (Google sync,
 * birthdays) are floating dates: their UTC date part. Any other instant is the user's local midnight
 * converted to UTC (the model resolves local dates to UTC, e.g. Belgrade Mon 28 → 27T22:00Z), so it
 * is read on the user's wall clock.
 */
function allDayCalendarDate(value: string, timezone: string): string {
  const ms = Date.parse(value);
  if (ms % 86_400_000 === 0) return new Date(ms).toISOString().slice(0, 10);
  return format(new TZDate(ms, timezone), 'yyyy-MM-dd');
}

/**
 * The calendar dates of an all-day event (see allDayCalendarDate). A later end date is exclusive
 * (the Google convention); a missing or earlier-or-equal end means a single day, so `endExclusive`
 * is null.
 */
export function allDayDates(
  startIso: string,
  endIso: string | null,
  timezone: string,
): { first: string; endExclusive: string | null } {
  const first = allDayCalendarDate(startIso, timezone);
  const end = endIso ? allDayCalendarDate(endIso, timezone) : null;
  return { first, endExclusive: end && end > first ? end : null };
}

/**
 * An event's span on the user's wall clock with English weekday and zone, e.g.
 * `Mon 2026-09-28 12:30–13:30 (Europe/Belgrade)` or `Mon 2026-09-28 23:00 – Tue 2026-09-29 01:00 (…)`.
 * All-day values (see allDayDates) render as `Mon 2026-09-28 all day` without a clock time or zone.
 */
export function formatLocalEventSpan(
  startIso: string,
  endIso: string | null,
  allDay: boolean,
  timezone: string,
): string {
  if (allDay) {
    const { first, endExclusive } = allDayDates(startIso, endIso, timezone);
    const firstDay = format(localCalendarDate(first, timezone), LOCAL_DAY);
    if (!endExclusive) return `${firstDay} all day`;
    const lastDay = format(addDays(localCalendarDate(endExclusive, timezone), -1), LOCAL_DAY);
    return lastDay === firstDay ? `${firstDay} all day` : `${firstDay} – ${lastDay} all day`;
  }
  // Parse to an instant first: a date-only string passed to TZDate would be read as zone midnight.
  const start = new TZDate(new Date(startIso), timezone);
  const zone = `(${timezone})`;
  if (!endIso) return `${format(start, `${LOCAL_DAY} HH:mm`)} ${zone}`;
  const end = new TZDate(new Date(endIso), timezone);
  if (format(start, 'yyyy-MM-dd') === format(end, 'yyyy-MM-dd')) {
    return `${format(start, `${LOCAL_DAY} HH:mm`)}–${format(end, 'HH:mm')} ${zone}`;
  }
  return `${format(start, `${LOCAL_DAY} HH:mm`)} – ${format(end, `${LOCAL_DAY} HH:mm`)} ${zone}`;
}

export function getDayRangeUtc(date: Date, timezone: string): { start: string; end: string } {
  const localDate = new TZDate(date.getTime(), timezone);
  const start = startOfDay(localDate);
  const end = endOfDay(localDate);
  return { start: new Date(start.getTime()).toISOString(), end: new Date(end.getTime()).toISOString() };
}

export function getWeekRangeUtc(date: Date, timezone: string): { start: string; end: string } {
  const localDate = new TZDate(date.getTime(), timezone);
  const start = startOfWeek(localDate, { weekStartsOn: 1 });
  const end = endOfWeek(localDate, { weekStartsOn: 1 });
  return {
    start: new Date(startOfDay(start).getTime()).toISOString(),
    end: new Date(endOfDay(end).getTime()).toISOString(),
  };
}

export function getNDayRangeUtc(date: Date, days: number, timezone: string): { start: string; end: string } {
  const localDate = new TZDate(date.getTime(), timezone);
  const start = startOfDay(localDate);
  const end = endOfDay(addDays(localDate, days - 1));
  return { start: new Date(start.getTime()).toISOString(), end: new Date(end.getTime()).toISOString() };
}

export function localCalendarWeekDays(utcStartIso: string, timezone: string): string[] {
  const calendarStart = new TZDate(new Date(utcStartIso), timezone).toISOString().slice(0, 10);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${calendarStart}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

function isValidClock(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * Per-format outcome: `undefined` = the text is not in this format (try the next one);
 * `null` = it is, but the value is invalid (final); a Date = parsed.
 */
type FormatResult = Date | null | undefined;

interface SimpleDateContext {
  trimmed: string;
  ref: TZDate;
  timezone: string;
}

/** The given clock time (hour and minute default to 0) on the local day of `day`; null when not a real clock time. */
function clockOnDay(day: Date, h: string | undefined, m: string | undefined): Date | null {
  const hour = Number(h ?? 0);
  const minute = Number(m ?? 0);
  if (!isValidClock(hour, minute)) return null;
  const result = addMinutes(startOfDay(day), hour * 60 + minute);
  return new Date(result.toISOString());
}

/**
 * Formats naming a day relative to today plus a clock time. `hourGroup` is the capture group of the hour
 * (the minutes follow it); the keyword group before it is not needed.
 */
const RELATIVE_DAY_RULES: readonly { pattern: RegExp; dayOffset: number; hourGroup: number }[] = [
  // Bare time: "15:30", "в 19:00", "at 8" → today
  { pattern: /^(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?$/, dayOffset: 0, hourGroup: 1 },
  { pattern: /^(today|сегодня)\s+(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?$/, dayOffset: 0, hourGroup: 2 },
  {
    pattern: /^(tomorrow|завтра)(?:\s+(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?)?$/,
    dayOffset: 1,
    hourGroup: 2,
  },
  // "послезавтра" / "day after tomorrow" — with optional time
  {
    pattern: /^(послезавтра|day after tomorrow)(?:\s+(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?)?$/,
    dayOffset: 2,
    hourGroup: 2,
  },
];

function parseRelativeDay({ trimmed, ref }: SimpleDateContext): FormatResult {
  for (const { pattern, dayOffset, hourGroup } of RELATIVE_DAY_RULES) {
    const match = trimmed.match(pattern);
    if (match) return clockOnDay(addDays(ref, dayOffset), match[hourGroup], match[hourGroup + 1]);
  }
  return undefined;
}

const DAY_NAMES: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 0,
  пн: 1,
  вт: 2,
  ср: 3,
  чт: 4,
  пт: 5,
  сб: 6,
  вс: 0,
  понедельник: 1,
  вторник: 2,
  среда: 3,
  четверг: 4,
  пятница: 5,
  суббота: 6,
  воскресенье: 0,
};

const WEEKDAY_CLOCK = /^(?:next\s+)?([a-zа-яё]+)\s+(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?$/;

/** "пн 10:00", "next friday at 9": the next such weekday, strictly after today. */
function parseWeekdayClock({ trimmed, ref }: SimpleDateContext): FormatResult {
  const match = trimmed.match(WEEKDAY_CLOCK);
  if (!match) return undefined;
  const [, dayStr, h, m] = match;
  const targetDay = DAY_NAMES[dayStr!];
  if (targetDay === undefined) return undefined;
  let daysToAdd = targetDay - ref.getDay();
  if (daysToAdd <= 0) daysToAdd += 7;
  return clockOnDay(addDays(ref, daysToAdd), h, m);
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
  янв: 0,
  фев: 1,
  мар: 2,
  апр: 3,
  май: 4,
  июн: 5,
  июл: 6,
  авг: 7,
  сен: 8,
  окт: 9,
  ноя: 10,
  дек: 11,
  // Full Russian — nominative
  январь: 0,
  февраль: 1,
  март: 2,
  апрель: 3,
  июнь: 5,
  июль: 6,
  август: 7,
  сентябрь: 8,
  октябрь: 9,
  ноябрь: 10,
  декабрь: 11,
  // Full Russian — genitive
  января: 0,
  февраля: 1,
  марта: 2,
  апреля: 3,
  мая: 4,
  июня: 5,
  июля: 6,
  августа: 7,
  сентября: 8,
  октября: 9,
  ноября: 10,
  декабря: 11,
};

// Both "mar 15 19:30" and "15 mar 19:30" (day-first); month-first is tried first.
const MONTH_FIRST_DATE = /^([a-zа-яё]+)\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/;
const DAY_FIRST_DATE = /^(\d{1,2})\s+([a-zа-яё]+)(?:\s+(\d{1,2}):(\d{2}))?$/;

/** A wall-clock moment in `timezone`; null for an invalid clock or a day missing from that month (no rolling over). */
function exactLocalMoment(
  year: number,
  month: number,
  day: number,
  h: string | undefined,
  m: string | undefined,
  timezone: string,
): Date | null {
  const hour = h ? Number(h) : 0;
  const min = m ? Number(m) : 0;
  if (!isValidClock(hour, min)) return null;
  const d = new TZDate(year, month, day, hour, min, 0, 0, timezone);
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
  return new Date(d.toISOString());
}

/** "mar 15 19:30" / "15 мар 19:30": the date in the reference's year. */
function parseMonthDay({ trimmed, ref, timezone }: SimpleDateContext): FormatResult {
  const match = trimmed.match(MONTH_FIRST_DATE) ?? trimmed.match(DAY_FIRST_DATE);
  if (!match) return undefined;
  const [, first, second, h, m] = match;
  const dayFirst = /^\d+$/.test(first!) && !/^\d+$/.test(second!);
  const [monthName, dayText] = dayFirst ? [second!, first!] : [first!, second!];
  const month = MONTHS[monthName];
  if (month === undefined) return undefined;
  return exactLocalMoment(ref.getFullYear(), month, Number(dayText), h, m, timezone);
}

// Order is significant: the first format that recognises the text decides.
const SIMPLE_DATE_FORMATS = [parseRelativeDay, parseWeekdayClock, parseMonthDay];

export function parseSimpleDate(input: string, timezone: string, refDate?: Date): Date | null {
  const context: SimpleDateContext = {
    ref: refDate ? new TZDate(refDate.getTime(), timezone) : TZDate.tz(timezone),
    trimmed: input.trim().toLowerCase(),
    timezone,
  };
  for (const parseFormat of SIMPLE_DATE_FORMATS) {
    const result = parseFormat(context);
    if (result !== undefined) return result;
  }
  return null;
}

/** Time range in one zone; names the end day when the event ends on a later local day there. */
function formatZonedRange(startAt: string, endAt: string | null, timezone: string, lang: string): string {
  if (!endAt) return toUserTime(startAt, timezone);
  const startDay = format(new TZDate(startAt, timezone), 'yyyy-MM-dd');
  const endDay = format(new TZDate(endAt, timezone), 'yyyy-MM-dd');
  if (startDay === endDay) return formatTimeRange(startAt, endAt, timezone);
  return `${toUserTime(startAt, timezone)} – ${formatDateShort(endAt, timezone, lang)}, ${toUserTime(endAt, timezone)}`;
}

export function formatTimeWithTimezones(
  startAt: string,
  endAt: string | null,
  senderTimezone: string,
  recipientTimezone: string | null,
  recipientOnboarded: boolean,
  lang: string,
): string {
  const senderTime = formatZonedRange(startAt, endAt, senderTimezone, lang);

  if (!recipientOnboarded || !recipientTimezone || recipientTimezone === senderTimezone) {
    return `${senderTime} (${senderTimezone})`;
  }

  const recipientTime = formatZonedRange(startAt, endAt, recipientTimezone, lang);
  return `${senderTime} (${senderTimezone}) / ${recipientTime} (${recipientTimezone})`;
}

export function formatDuration(startUtc: string, endUtc: string, lang: string): string {
  const diffMs = new Date(endUtc).getTime() - new Date(startUtc).getTime();
  const totalMinutes = Math.round(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return lang === 'ru' ? `${minutes}мин` : `${minutes}m`;
  if (minutes === 0) return lang === 'ru' ? `${hours}ч` : `${hours}h`;
  return lang === 'ru' ? `${hours}ч ${minutes}мин` : `${hours}h ${minutes}m`;
}

/** Idioms that no numeric format expresses. */
const SPECIAL_DURATIONS: Record<string, number> = {
  полчаса: 30,
  'half an hour': 30,
  'half hour': 30,
  'полтора часа': 90,
};

const COLON_DURATION = /^(\d+):(\d{2})$/;
const PLAIN_DURATION = /^(\d+)$/;

// Suffix format with full-word support: "1h 30m", "2 часа 15 мин", "45 minutes".
const HOUR_UNIT = '(?:hours?|hr|час(?:а|ов)?|[hч])';
const MINUTE_UNIT = '(?:minutes?|min|минут[аыу]?|мин|[mм])';
const SUFFIX_DURATION = new RegExp(`^(?:(\\d+)\\s*${HOUR_UNIT})?\\s*(?:(\\d+)\\s*${MINUTE_UNIT})?$`);

/** Per-format result: `undefined` = not this format (try the next); a number or null = final answer. */
type DurationResult = number | null | undefined;

/** "1:30", "0:45", "10:30" */
function parseColonDuration(trimmed: string): DurationResult {
  const match = trimmed.match(COLON_DURATION);
  if (!match) return undefined;
  const total = Number(match[1]) * 60 + Number(match[2]);
  return total > 0 ? total : null;
}

function parseSuffixDuration(trimmed: string): DurationResult {
  const match = trimmed.match(SUFFIX_DURATION);
  if (!match || !(match[1] || match[2])) return undefined;
  const hours = match[1] ? Number(match[1]) : 0;
  const mins = match[2] ? Number(match[2]) : 0;
  return hours * 60 + mins || null;
}

/** A bare number is minutes. */
function parsePlainDuration(trimmed: string): DurationResult {
  const match = trimmed.match(PLAIN_DURATION);
  if (!match) return undefined;
  const mins = Number(match[1]);
  return mins > 0 ? mins : null;
}

// First format that recognises the text decides, in this order.
const DURATION_FORMATS = [parseColonDuration, parseSuffixDuration, parsePlainDuration];

export function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();

  // Special forms are checked before the regex formats; own keys only, so "constructor" is no idiom.
  if (Object.hasOwn(SPECIAL_DURATIONS, trimmed)) return SPECIAL_DURATIONS[trimmed]!;

  for (const parseFormat of DURATION_FORMATS) {
    const minutes = parseFormat(trimmed);
    if (minutes !== undefined) return minutes;
  }
  return null;
}

export interface RecurrenceParsed {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
}

/** Fixed phrases. Built per call, exactly as the inline table it replaces, so callers never share an object. */
function fixedRecurrences(): Record<string, RecurrenceParsed> {
  return {
    daily: { freq: 'DAILY', interval: 1 },
    'every day': { freq: 'DAILY', interval: 1 },
    'каждый день': { freq: 'DAILY', interval: 1 },
    ежедневно: { freq: 'DAILY', interval: 1 },
    weekly: { freq: 'WEEKLY', interval: 1 },
    'every week': { freq: 'WEEKLY', interval: 1 },
    'каждую неделю': { freq: 'WEEKLY', interval: 1 },
    еженедельно: { freq: 'WEEKLY', interval: 1 },
    monthly: { freq: 'MONTHLY', interval: 1 },
    'every month': { freq: 'MONTHLY', interval: 1 },
    'каждый месяц': { freq: 'MONTHLY', interval: 1 },
    ежемесячно: { freq: 'MONTHLY', interval: 1 },
    yearly: { freq: 'YEARLY', interval: 1 },
    'every year': { freq: 'YEARLY', interval: 1 },
    'каждый год': { freq: 'YEARLY', interval: 1 },
    ежегодно: { freq: 'YEARLY', interval: 1 },
    'через неделю': { freq: 'WEEKLY', interval: 2 },
  };
}

type RecurrenceFreq = RecurrenceParsed['freq'];

/** "every N <unit>": the unit's frequency is decided by its leading letters (singular or plural). */
const EVERY_N_PATTERN = /^every\s+(\d+)\s+(days?|weeks?|months?|years?)$/;
const EVERY_N_UNITS: readonly (readonly [string, RecurrenceFreq])[] = [
  ['day', 'DAILY'],
  ['week', 'WEEKLY'],
  ['month', 'MONTHLY'],
  ['year', 'YEARLY'],
];

/** "каждые N <unit>" in every agreeing gender/case form of the verb and the unit. */
const KAZHDYE_N_PATTERN = /^кажд(?:ый|ую|ые|ое)\s+(\d+)\s+(дн(?:я|ей|и)|день|недел[юиь]|месяц(?:а|ев)?|год[аов]?)$/;
const KAZHDYE_N_UNITS: readonly (readonly [string, RecurrenceFreq])[] = [
  ['дн', 'DAILY'],
  ['день', 'DAILY'],
  ['недел', 'WEEKLY'],
  ['месяц', 'MONTHLY'],
  ['год', 'YEARLY'],
];

/** Matches "<every> N <unit>"; null when the text does not match or the unit maps to no frequency. */
function parseIntervalPhrase(
  trimmed: string,
  pattern: RegExp,
  units: readonly (readonly [string, RecurrenceFreq])[],
): RecurrenceParsed | null {
  const match = trimmed.match(pattern);
  if (!match) return null;
  const unit = match[2]!;
  const entry = units.find(([prefix]) => unit.startsWith(prefix));
  return entry ? { freq: entry[1], interval: Number(match[1]) } : null;
}

export function parseRecurrence(input: string): RecurrenceParsed | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const simple = fixedRecurrences();
  if (Object.hasOwn(simple, trimmed)) return simple[trimmed] ?? null;

  return (
    parseIntervalPhrase(trimmed, EVERY_N_PATTERN, EVERY_N_UNITS) ??
    parseIntervalPhrase(trimmed, KAZHDYE_N_PATTERN, KAZHDYE_N_UNITS)
  );
}

/** Construct a calendar date in its own zone, without shifting it through UTC. */
export function localCalendarDate(dateIso: string, timezone: string): TZDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
  if (!match) throw new Error('Invalid calendar date');
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new TZDate(year, month, day, 12, timezone);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day)
    throw new Error('Invalid calendar date');
  return date;
}

const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * Epoch ms of a stored timestamp. SQLite `datetime('now')` values have a space
 * separator and no zone (UTC); ISO values carry `T` and a zone. Comparing the
 * strings lexically mixes the two spellings, so callers compare these numbers.
 */
export function storedInstantMs(value: string): number {
  return Date.parse(SQLITE_DATETIME.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}
