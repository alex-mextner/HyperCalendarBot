import { TZDate } from '@date-fns/tz';
import { z } from 'zod';
import { normalize } from './normalizer.ts';
import { resolveVariables, type UserContext } from './variable-resolver.ts';
import { WorkflowInputError, type WorkflowInputValue } from './workflow-input.ts';
import type { I18nMap } from './workflow-schema.ts';

/**
 * Typed bindings turn raw regex captures into validated values before any tool runs.
 * Parsing is table-driven and never evaluates code; a value that cannot be parsed
 * unambiguously fails the whole workflow before its first step.
 */

const BINDING_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_ENTRIES = 96;
const Template = z.string().min(1).max(512);
const Scalar = z.union([z.string().max(64), z.number().finite(), z.boolean()]);
const KeyedValues = z
  .record(z.string().min(1).max(64), Scalar)
  .refine((values) => Object.keys(values).length > 0 && Object.keys(values).length <= MAX_ENTRIES, 'Invalid map size');

const PERIOD_KEYS = [
  'today',
  'tomorrow',
  'day_after_tomorrow',
  'yesterday',
  'week',
  'next_week',
  'month',
  'next_month',
  'weekend',
] as const;
const DAY_WORDS = ['today', 'tomorrow', 'day_after_tomorrow', 'yesterday'] as const;
const PeriodKey = z.enum(PERIOD_KEYS);
const DayWord = z.enum(DAY_WORDS);
const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const BindingSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('integer'),
      from: Template,
      min: z.number().int().optional(),
      max: z.number().int().optional(),
      optional: z.boolean().optional(),
      default: z.number().int().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('enum'),
      from: Template,
      values: KeyedValues,
      optional: z.boolean().optional(),
      default: Scalar.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      from: Template,
      max: z.number().int().min(1).max(500).optional(),
      optional: z.boolean().optional(),
      default: z.string().max(64).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('date'),
      from: Template,
      words: z.record(z.string().min(1).max(64), DayWord).optional(),
      future: z.boolean().optional(),
      optional: z.boolean().optional(),
      default: DayWord.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('time'),
      from: Template,
      optional: z.boolean().optional(),
      default: HourMinute.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('period'),
      from: Template,
      values: z.record(z.string().min(1).max(64), PeriodKey),
      optional: z.boolean().optional(),
      default: PeriodKey.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('datetime'),
      date: z.string().regex(BINDING_NAME),
      time: z.string().regex(BINDING_NAME),
      future: z.boolean().optional(),
      plus_minutes: z.number().int().min(1).max(1440).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('duration'),
      from: Template,
      unit: Template,
      units: z.record(z.string().min(1).max(64), z.number().int().positive().max(10080)),
      min: z.number().int().positive().optional(),
      max: z.number().int().positive().optional(),
      default_amount: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ type: z.literal('relative_instant'), duration: z.string().regex(BINDING_NAME) }).strict(),
  z.object({ type: z.literal('timezone'), from: Template }).strict(),
  z
    .object({ type: z.literal('eventref'), from: Template, reject: z.array(z.string().max(32)).max(24).optional() })
    .strict(),
  z.object({ type: z.literal('recipient'), from: Template }).strict(),
]);
export type Binding = z.infer<typeof BindingSchema>;
export const BindingsSchema = z
  .record(z.string().regex(BINDING_NAME), BindingSchema)
  .refine((bindings) => Object.keys(bindings).length <= 16, 'Too many bindings');
export type Bindings = z.infer<typeof BindingsSchema>;
export type BindValues = { [name: string]: WorkflowInputValue };

const fail = (): never => {
  throw new WorkflowInputError('INVALID_INPUT');
};
const pad2 = (n: number): string => String(n).padStart(2, '0');

interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

function isoDay({ y, m, d }: CalendarDay): string {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

/** Calendar arithmetic on the proleptic calendar; independent of any UTC offset. */
function addDays(day: CalendarDay, delta: number): CalendarDay {
  const moved = new Date(Date.UTC(day.y, day.m - 1, day.d + delta));
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate() };
}

function weekdayMondayZero(day: CalendarDay): number {
  return (new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay() + 6) % 7;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validDay(day: CalendarDay): boolean {
  return (
    day.y >= 1970 && day.y <= 2200 && day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= daysInMonth(day.y, day.m)
  );
}

function today(now: Date, timezone: string): CalendarDay {
  const local = new TZDate(now, timezone);
  return { y: local.getFullYear(), m: local.getMonth() + 1, d: local.getDate() };
}

const DAY_WORD_OFFSETS: { [word in (typeof DAY_WORDS)[number]]: number } = {
  yesterday: -1,
  today: 0,
  tomorrow: 1,
  day_after_tomorrow: 2,
};

const MONTHS: { [name: string]: number } = {
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

function parseAbsoluteDay(text: string): { day: Partial<CalendarDay> & { m: number; d: number } } | null {
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

function parseDate(raw: string, binding: Extract<Binding, { type: 'date' }>, now: Date, timezone: string): string {
  const key = normalize(raw);
  const current = today(now, timezone);
  const word = binding.words && Object.hasOwn(binding.words, key) ? binding.words[key] : undefined;
  if (word) return isoDay(addDays(current, DAY_WORD_OFFSETS[word]));
  const parsed = parseAbsoluteDay(key);
  if (!parsed) return fail();
  const withYear = (year: number): CalendarDay => ({ y: year, m: parsed.day.m, d: parsed.day.d });
  let day = withYear(parsed.day.y ?? current.y);
  if (!validDay(day)) return fail();
  if (parsed.day.y === undefined && binding.future && isoDay(day) < isoDay(current)) day = withYear(current.y + 1);
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
function parseTime(raw: string): string {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === 'полдень' || text === 'noon') return '12:00';
  if (text === 'полночь' || text === 'midnight') return '00:00';
  const match = /^(\d{1,2})(?:[:.\s](\d{2}))?(?: ?(am|pm|a m|p m|утра|дня|вечера|ночи))?$/.exec(text);
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

function offsetMinutesAt(utcMs: number, timezone: string): number {
  return -new TZDate(utcMs, timezone).getTimezoneOffset();
}

function formatOffset(minutes: number): string {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function formatLocalInstant(utcMs: number, timezone: string): string {
  const local = new TZDate(utcMs, timezone);
  const stamp =
    `${String(local.getFullYear()).padStart(4, '0')}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}` +
    `T${pad2(local.getHours())}:${pad2(local.getMinutes())}:00`;
  return `${stamp}${formatOffset(offsetMinutesAt(utcMs, timezone))}`;
}

/**
 * Resolve a wall-clock time in an IANA zone to exactly one instant. A time skipped by a
 * clock change or repeated by one has zero or two instants and is rejected, never guessed.
 */
function uniqueInstant(day: CalendarDay, hour: number, minute: number, timezone: string): number {
  const wall = Date.UTC(day.y, day.m - 1, day.d, hour, minute);
  const candidates = new Set<number>();
  for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) {
    const offset = offsetMinutesAt(probe, timezone);
    const instant = wall - offset * 60_000;
    if (offsetMinutesAt(instant, timezone) === offset) candidates.add(instant);
  }
  return candidates.size === 1 ? [...candidates][0]! : fail();
}

function parseDayPart(value: WorkflowInputValue | undefined): CalendarDay {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : fail();
}

function buildDatetime(
  binding: Extract<Binding, { type: 'datetime' }>,
  bound: BindValues,
  now: Date,
  timezone: string,
): string {
  const day = parseDayPart(bound[binding.date]);
  const clock = bound[binding.time];
  const parts = typeof clock === 'string' ? /^(\d{2}):(\d{2})$/.exec(clock) : null;
  if (!parts) return fail();
  const start = uniqueInstant(day, Number(parts[1]), Number(parts[2]), timezone);
  if (binding.future && start <= now.getTime()) return fail();
  return formatLocalInstant(start + (binding.plus_minutes ?? 0) * 60_000, timezone);
}

function periodRange(
  key: (typeof PERIOD_KEYS)[number],
  current: CalendarDay,
): { start: CalendarDay; end: CalendarDay } {
  const monday = addDays(current, -weekdayMondayZero(current));
  switch (key) {
    case 'week':
      return { start: monday, end: addDays(monday, 6) };
    case 'next_week':
      return { start: addDays(monday, 7), end: addDays(monday, 13) };
    case 'weekend':
      return { start: addDays(monday, 5), end: addDays(monday, 6) };
    case 'month':
    case 'next_month': {
      const shift = key === 'month' ? 0 : 1;
      const first = new Date(Date.UTC(current.y, current.m - 1 + shift, 1));
      const y = first.getUTCFullYear();
      const m = first.getUTCMonth() + 1;
      return { start: { y, m, d: 1 }, end: { y, m, d: daysInMonth(y, m) } };
    }
    default: {
      const day = addDays(current, DAY_WORD_OFFSETS[key]);
      return { start: day, end: day };
    }
  }
}

function periodKind(key: (typeof PERIOD_KEYS)[number]): 'day' | 'week' | 'month' | 'weekend' {
  if (key === 'week' || key === 'next_week') return 'week';
  if (key === 'month' || key === 'next_month') return 'month';
  return key === 'weekend' ? 'weekend' : 'day';
}

function buildPeriod(key: (typeof PERIOD_KEYS)[number], now: Date, timezone: string): WorkflowInputValue {
  const { start, end } = periodRange(key, today(now, timezone));
  const days = Array.from({ length: 7 }, (_, index) => isoDay(addDays(start, index)));
  return { key, kind: periodKind(key), start: isoDay(start), end: isoDay(end), month: isoDay(start).slice(0, 7), days };
}

function parseDuration(raw: string, unitRaw: string, binding: Extract<Binding, { type: 'duration' }>): number {
  const amountText = raw.trim();
  const amount =
    amountText === '' ? binding.default_amount : /^\d{1,5}$/.test(amountText) ? Number(amountText) : undefined;
  const unit = normalize(unitRaw);
  if (amount === undefined || !Object.hasOwn(binding.units, unit)) return fail();
  const minutes = amount * binding.units[unit]!;
  if (minutes < (binding.min ?? 1) || minutes > (binding.max ?? 1440)) return fail();
  return minutes;
}

function parseTimezone(raw: string): string {
  const text = raw.trim();
  const shape = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;
  if (!shape.test(text)) return fail();
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: text }).resolvedOptions().timeZone;
  } catch {
    return fail();
  }
}

function hasControlCharacters(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 32 || (code >= 127 && code < 160)) return true;
  }
  return false;
}

const QUOTE_PAIRS: { [open: string]: string } = { '«': '»', '"': '"', '“': '”', "'": "'" };

function parseText(raw: string, max: number): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  const closing = QUOTE_PAIRS[text[0] ?? ''];
  if (closing && text.length >= 2 && text.endsWith(closing)) text = text.slice(1, -1).trim();
  if (text === '' || text.length > max || hasControlCharacters(text)) return fail();
  return text;
}

function parseEventRef(raw: string, reject: string[] | undefined): WorkflowInputValue {
  const idMatch = /^(?:#|№|id\s*:?\s*)?(\d{1,9})$/i.exec(raw.trim());
  if (idMatch) return Number(idMatch[1]) > 0 ? { kind: 'id', id: Number(idMatch[1]) } : fail();
  const query = parseText(raw, 120);
  const blocked = new Set((reject ?? []).map(normalize));
  if (
    normalize(query)
      .split(' ')
      .some((token) => blocked.has(token))
  )
    return fail();
  return { kind: 'name', query };
}

function parseRecipient(raw: string): WorkflowInputValue {
  const text = raw.trim();
  const username = /^@([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(text);
  if (username) return { kind: 'username', username: username[1]!, label: `@${username[1]!}` };
  const id = /^\d{5,15}$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(id) && id > 0 ? { kind: 'id', id, label: String(id) } : fail();
}

function parseInteger(raw: string, binding: Extract<Binding, { type: 'integer' }>): number {
  if (!/^\d{1,9}$/.test(raw.trim())) return fail();
  const value = Number(raw.trim());
  return value < (binding.min ?? 0) || value > (binding.max ?? 1_000_000) ? fail() : value;
}

function lookup(values: { [key: string]: WorkflowInputValue }, raw: string): WorkflowInputValue {
  const key = normalize(raw);
  return Object.hasOwn(values, key) ? values[key]! : fail();
}

interface Evaluation {
  captures: { [key: string]: string };
  userCtx: UserContext;
  i18n: I18nMap | undefined;
  now: Date;
}

function resolveFrom(template: string, evaluation: Evaluation): string {
  const resolved = resolveVariables(template, evaluation.captures, evaluation.userCtx, undefined, evaluation.i18n, {
    strict: true,
  });
  return typeof resolved === 'string' ? resolved : String(resolved);
}

function isBlank(raw: string): boolean {
  return raw.trim() === '';
}

function evaluateOne(binding: Binding, bound: BindValues, evaluation: Evaluation): WorkflowInputValue {
  const { userCtx, now } = evaluation;
  if (binding.type === 'datetime') return buildDatetime(binding, bound, now, userCtx.timezone);
  if (binding.type === 'relative_instant') {
    const duration = bound[binding.duration];
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 10080) return fail();
    return new Date(now.getTime() + duration * 60000).toISOString();
  }
  const raw = resolveFrom(binding.from, evaluation);
  const optionalDefault = 'optional' in binding && binding.optional && isBlank(raw);
  switch (binding.type) {
    case 'integer':
      return optionalDefault ? (binding.default ?? fail()) : parseInteger(raw, binding);
    case 'enum':
      return optionalDefault ? (binding.default ?? fail()) : lookup(binding.values, raw);
    case 'text':
      return optionalDefault ? (binding.default ?? fail()) : parseText(raw, binding.max ?? 200);
    case 'date':
      return optionalDefault
        ? isoDay(addDays(today(now, userCtx.timezone), DAY_WORD_OFFSETS[binding.default ?? fail()]))
        : parseDate(raw, binding, now, userCtx.timezone);
    case 'time':
      return optionalDefault ? (binding.default ?? fail()) : parseTime(raw);
    case 'period':
      return buildPeriod(
        optionalDefault ? (binding.default ?? fail()) : periodKey(binding.values, raw),
        now,
        userCtx.timezone,
      );
    case 'duration':
      return parseDuration(raw, resolveFrom(binding.unit, evaluation), binding);
    case 'timezone':
      return parseTimezone(raw);
    case 'eventref':
      return parseEventRef(raw, binding.reject);
    case 'recipient':
      return parseRecipient(raw);
  }
}

function periodKey(values: { [key: string]: (typeof PERIOD_KEYS)[number] }, raw: string): (typeof PERIOD_KEYS)[number] {
  const key = normalize(raw);
  return Object.hasOwn(values, key) ? values[key]! : fail();
}

/** Bindings are evaluated in declaration order; a datetime may only read earlier bindings. */
export function evaluateBindings(
  bindings: Bindings,
  captures: { [key: string]: string },
  userCtx: UserContext,
  i18n: I18nMap | undefined,
  now: Date = new Date(),
): BindValues {
  const bound: BindValues = {};
  for (const [name, binding] of Object.entries(bindings)) {
    bound[name] = evaluateOne(binding, bound, { captures, userCtx, i18n, now });
  }
  return bound;
}
