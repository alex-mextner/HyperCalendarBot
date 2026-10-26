// Human wording of calendar days for intent answers: "завтра, вт 6 октября", never a raw 2026-10-06. The relative
// word is computed from the user's own local today, so it is right in every zone and across midnight.
import { addDays, type CalendarDay, isoDay, today, weekdayMondayZero } from './date-time-words.ts';

const RU_MONTH = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
const EN_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RU_WEEKDAY = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const EN_WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const RU_RELATIVE: { [offset: number]: string } = { [-1]: 'вчера', 0: 'сегодня', 1: 'завтра', 2: 'послезавтра' };
const EN_RELATIVE: { [offset: number]: string } = {
  [-1]: 'yesterday',
  0: 'today',
  1: 'tomorrow',
  2: 'day after tomorrow',
};

export interface HumanTimeContext {
  now: Date;
  timezone: string;
  language: string;
}

function parseIsoDay(iso: string): CalendarDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

function dayDistance(from: CalendarDay, to: CalendarDay): number {
  return Math.round((Date.UTC(to.y, to.m - 1, to.d) - Date.UTC(from.y, from.m - 1, from.d)) / 86_400_000);
}

export interface HumanDayParts {
  /** "завтра" / "tomorrow" for the few days that have a word of their own, otherwise null. */
  relative: string | null;
  /** "вт 6 октября" / "Tue Oct 6"; the year is added only when it is not the current one. */
  calendar: string;
}

/** The two halves of a human day, so callers can lead with either ("Завтра, вт 6 октября:" or "Свободно завтра"). */
export function humanDayParts(iso: string, context: HumanTimeContext): HumanDayParts | null {
  const day = parseIsoDay(iso);
  if (!day) return null;
  const current = today(context.now, context.timezone);
  const ru = context.language === 'ru';
  const relative = (ru ? RU_RELATIVE : EN_RELATIVE)[dayDistance(current, day)] ?? null;
  const weekday = (ru ? RU_WEEKDAY : EN_WEEKDAY)[weekdayMondayZero(day)]!;
  const year = day.y === current.y ? '' : ` ${day.y}`;
  const calendar = ru
    ? `${weekday} ${day.d} ${RU_MONTH[day.m - 1]}${year}`
    : `${weekday} ${EN_MONTH[day.m - 1]} ${day.d}${year}`;
  return { relative, calendar };
}

/** "завтра, вт 6 октября" / "tomorrow, Tue Oct 6"; the year is added only when it is not the current one. */
export function humanDay(iso: string, context: HumanTimeContext): string {
  const parts = humanDayParts(iso, context);
  if (!parts) return iso;
  return parts.relative ? `${parts.relative}, ${parts.calendar}` : parts.calendar;
}

/** A day as the first words of a line: "Завтра, вт 6 октября" / "Tomorrow, Tue Oct 6". */
export function humanDayHeading(iso: string, context: HumanTimeContext): string {
  const text = humanDay(iso, context);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The day of an ISO instant with an offset ("2026-10-06T10:30:00+02:00") as the user's wall clock shows it. */
export function humanWhen(instant: string, context: HumanTimeContext): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(instant);
  if (!match) return instant;
  const joiner = context.language === 'ru' ? 'в' : 'at';
  return `${humanDay(match[1]!, context)} ${joiner} ${match[2]}`;
}

const RU_UNITS = {
  minute: ['минуту', 'минуты', 'минут'],
  hour: ['час', 'часа', 'часов'],
  day: ['день', 'дня', 'дней'],
} as const;
const EN_UNITS = { minute: ['minute', 'minutes'], hour: ['hour', 'hours'], day: ['day', 'days'] } as const;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

/** "1 минуту", "2 минуты", "5 минут" (and 11–14, which take the plural, as 5 does). */
function russianCount(amount: number, forms: readonly [string, string, string]): string {
  const lastTwo = amount % 100;
  const last = amount % 10;
  const form =
    lastTwo >= 11 && lastTwo <= 14 ? forms[2] : last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2];
  return `${amount} ${form}`;
}

/** A length of time as people say it: "20 минут", "2 часа", "1 час 30 минут", "1 day 2 hours". */
export function humanDuration(totalMinutes: number, language: string): string {
  const parts: string[] = [];
  let rest = Math.max(0, Math.round(totalMinutes));
  for (const [unit, size] of [
    ['day', MINUTES_PER_DAY],
    ['hour', MINUTES_PER_HOUR],
    ['minute', 1],
  ] as const) {
    const amount = Math.floor(rest / size);
    rest -= amount * size;
    if (amount === 0) continue;
    parts.push(
      language === 'ru'
        ? russianCount(amount, RU_UNITS[unit])
        : `${amount} ${amount === 1 ? EN_UNITS[unit][0] : EN_UNITS[unit][1]}`,
    );
  }
  return parts.length === 0 ? (language === 'ru' ? '0 минут' : '0 minutes') : parts.join(' ');
}

export const nextDay = (iso: string): string => {
  const day = parseIsoDay(iso);
  return day ? isoDay(addDays(day, 1)) : iso;
};
