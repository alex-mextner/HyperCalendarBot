import { TZDate } from '@date-fns/tz';
import { z } from 'zod';
import { canonicalize, repairTypos } from './canonical-input.ts';
import {
  addDays,
  type CalendarDay,
  DAY_WORD_OFFSETS,
  daysInMonth,
  fail,
  isoDay,
  pad2,
  parseDate,
  parseTime,
  today,
  weekdayMondayZero,
} from './date-time-words.ts';
import { parseEventPhrase } from './event-phrase.ts';
import { distinctiveStem } from './event-reference.ts';
import { humanWhen } from './human-time.ts';
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
      /** Upper-case the first letter, as a calendar title reads ("растяжка" → "Растяжка"). */
      capitalize: z.boolean().optional(),
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
      /** 'both': a read that also answers for the day before when 'today'/'tomorrow' is said just after midnight. */
      after_midnight: z.literal('both').optional(),
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
    .object({
      type: z.literal('eventref'),
      from: Template,
      reject: z.array(z.string().max(32)).max(24).optional(),
      /** Search by the most distinctive word's stem, so an inflected mention ("йогу") finds its event ("Йога"). */
      stem: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('event_phrase'),
      from: Template,
      /** The phrase must name a day / a clock time; a reference phrase ("удали стендап") must name neither. */
      date: z.enum(['require', 'forbid']).optional(),
      time: z.enum(['require', 'forbid']).optional(),
      /** An explicit end time or duration is read; 'forbid' rejects a phrase that carries one. */
      span: z.enum(['allow', 'forbid']).optional(),
      invitee: z.enum(['require', 'forbid']).optional(),
      /**
       * The title is the mention of an existing event, not a new name: it is read as an event reference (`ref`,
       * found by its distinctive word) and a digit left in it, a bare hour that no grammar read, makes the phrase refused.
       */
      reference: z.boolean().optional(),
      /** Words that make a reference mean "many events" ("все"); the phrase is refused when it contains one. */
      reject: z.array(z.string().max(32)).max(24).optional(),
      future: z.boolean().optional(),
      default_minutes: z.number().int().min(1).max(1440).optional(),
    })
    .strict(),
  z.object({ type: z.literal('recipient'), from: Template }).strict(),
]);
export type Binding = z.infer<typeof BindingSchema>;
export const BindingsSchema = z
  .record(z.string().regex(BINDING_NAME), BindingSchema)
  .refine((bindings) => Object.keys(bindings).length <= 16, 'Too many bindings');
export type Bindings = z.infer<typeof BindingsSchema>;
export type BindValues = { [name: string]: WorkflowInputValue };

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

/**
 * Resolve a wall-clock time in an IANA zone to exactly one instant. A time skipped by a
 * clock change or repeated by one has zero or two instants and is rejected, never guessed.
 */
export function uniqueInstant(day: CalendarDay, hour: number, minute: number, timezone: string): number {
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

/**
 * One free-form phrase read into the slots of a calendar request. The parser refuses anything ambiguous; here the
 * requested shape (day and time required or forbidden, span, invitee) is enforced and the start and end instants are
 * built in the user's zone, so a time skipped or repeated by a clock change fails before any tool runs.
 */
function buildEventPhrase(
  binding: Extract<Binding, { type: 'event_phrase' }>,
  raw: string,
  evaluation: Evaluation,
): WorkflowInputValue {
  const { now, userCtx } = evaluation;
  const reference = binding.reference === true;
  // A day word spelled with one slip ("пятнитцу") is read as the word it is a single edit from; the title is unaffected
  // unless it is itself that close to a command or day word.
  const text = reference ? (repairTypos(canonicalize(raw))?.text ?? raw) : raw;
  const phrase = parseEventPhrase(text, { now, timezone: userCtx.timezone, requireTitle: !reference });
  const shape = (rule: 'require' | 'forbid' | undefined, present: boolean) => {
    if ((rule === 'require' && !present) || (rule === 'forbid' && present)) fail();
  };
  shape(binding.date, phrase.date !== null);
  shape(binding.time, phrase.time !== null);
  shape(binding.invitee ?? 'forbid', phrase.invitee !== null);
  const hasSpan = phrase.endTime !== null || phrase.durationMinutes !== null;
  if (hasSpan && (binding.span ?? 'forbid') === 'forbid') fail();
  const out: { [key: string]: WorkflowInputValue } = { title: phrase.title, has_end: hasSpan };
  if (reference) out.ref = parseMention(phrase.title, binding.reject);
  if (phrase.date !== null) out.date = phrase.date;
  if (phrase.time !== null) out.time = phrase.time;
  if (phrase.invitee !== null) out.invitee = phrase.invitee;
  if (phrase.date !== null && phrase.time !== null) {
    const day = parseDayPart(phrase.date);
    const [hour, minute] = phrase.time.split(':').map(Number) as [number, number];
    const start = uniqueInstant(day, hour, minute, userCtx.timezone);
    if (binding.future && start <= now.getTime()) fail();
    let minutes = binding.default_minutes ?? 60;
    if (phrase.endTime !== null) {
      const [endHour, endMinute] = phrase.endTime.split(':').map(Number) as [number, number];
      minutes = Math.round((uniqueInstant(day, endHour, endMinute, userCtx.timezone) - start) / 60_000);
      if (minutes <= 0) fail();
    } else if (phrase.durationMinutes !== null) minutes = phrase.durationMinutes;
    out.start = formatLocalInstant(start, userCtx.timezone);
    out.end = formatLocalInstant(start + minutes * 60_000, userCtx.timezone);
    out.when_text = humanWhen(out.start, { now, timezone: userCtx.timezone, language: userCtx.language });
    if (phrase.endTime !== null) out.end_suffix = `–${phrase.endTime}`;
  }
  return out;
}

/** "встречу #12", "meeting 12": a noun that only says "an event" in front of a number names that number. */
const NOUN_BEFORE_ID = /^(?:встреч[ауие]|запись|meetings?|appointments?)\s+(?=(?:#|№|id\s*:?\s*)?\d{1,9}$)/iu;

/** A mention of an existing event as an event reference: a number, or the word its title is found by. */
function parseMention(title: string, reject: string[] | undefined): WorkflowInputValue {
  const ref = parseEventRef(title.replace(NOUN_BEFORE_ID, ''), reject, true);
  // A digit the grammar did not read as a day or clock time ("на 2", "to 4") is a time it could not place: refuse.
  if (typeof ref === 'object' && ref !== null && !Array.isArray(ref) && ref.kind === 'name' && /\d/.test(title))
    return fail();
  return ref;
}

/**
 * 'week' ("на неделю", "на этой неделе", "this week") is today and the six following
 * local days, so a week plan never starts in the past; on a Monday it equals the
 * calendar week. 'next_week' is the next calendar week, Monday to Sunday.
 */
function periodRange(
  key: (typeof PERIOD_KEYS)[number],
  current: CalendarDay,
): { start: CalendarDay; end: CalendarDay } {
  const monday = addDays(current, -weekdayMondayZero(current));
  switch (key) {
    case 'week':
      return { start: current, end: addDays(current, 6) };
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

/** Saturday in the Monday-zero weekday index; Saturday and Sunday are the weekend. */
const SATURDAY = 5;

/**
 * Monday of the Monday–Sunday calendar week that pictures the period, for tools that can only
 * draw a whole calendar week; workflows read it only for week periods. 'week' on a Saturday or
 * Sunday gives the coming week: the current one has at most a day left, and the rolling 'week'
 * range lies mostly in the next one.
 */
function calendarWeekStart(key: (typeof PERIOD_KEYS)[number], start: CalendarDay): CalendarDay {
  const weekday = weekdayMondayZero(start);
  const monday = addDays(start, -weekday);
  return key === 'week' && weekday >= SATURDAY ? addDays(monday, 7) : monday;
}

function buildPeriod(key: (typeof PERIOD_KEYS)[number], now: Date, timezone: string): WorkflowInputValue {
  const { start, end } = periodRange(key, today(now, timezone));
  const days = Array.from({ length: 7 }, (_, index) => isoDay(addDays(start, index)));
  return {
    key,
    kind: periodKind(key),
    start: isoDay(start),
    end: isoDay(end),
    month: isoDay(start).slice(0, 7),
    calendar_week_start: isoDay(calendarWeekStart(key, start)),
    days,
  };
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

const capitalizeFirst = (text: string): string => (text === '' ? text : text[0]!.toUpperCase() + text.slice(1));

const QUOTE_PAIRS: { [open: string]: string } = { '«': '»', '"': '"', '“': '”', "'": "'" };

function parseText(raw: string, max: number): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  const closing = QUOTE_PAIRS[text[0] ?? ''];
  if (closing && text.length >= 2 && text.endsWith(closing)) text = text.slice(1, -1).trim();
  if (text === '' || text.length > max || hasControlCharacters(text)) return fail();
  return text;
}

function parseEventRef(raw: string, reject: string[] | undefined, stem: boolean | undefined): WorkflowInputValue {
  const idMatch = /^(?:#|№|id\s*:?\s*)?(\d{1,9})$/i.exec(raw.trim());
  if (idMatch) return Number(idMatch[1]) > 0 ? { kind: 'id', id: Number(idMatch[1]) } : fail();
  const label = parseText(raw, 120);
  const blocked = new Set((reject ?? []).map(normalize));
  if (
    normalize(label)
      .split(' ')
      .some((token) => blocked.has(token))
  )
    return fail();
  if (!stem) return { kind: 'name', query: label, label };
  const query = distinctiveStem(label);
  return query === null ? fail() : { kind: 'name', query, label };
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
  /** The marked date binding read as counted from the day that has just ended, if any. */
  dayBefore: string | null;
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

function evaluateOne(
  binding: Binding,
  bound: BindValues,
  evaluation: Evaluation,
  dayBefore: boolean,
): WorkflowInputValue {
  const { userCtx, now } = evaluation;
  if (binding.type === 'datetime') return buildDatetime(binding, bound, now, userCtx.timezone);
  if (binding.type === 'relative_instant') {
    const duration = bound[binding.duration];
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 10080) return fail();
    // A calendar entry starts on a whole minute; the nearest one keeps it within half a minute of the asked delay.
    const wholeMinute = Math.round((now.getTime() + duration * 60000) / 60000) * 60000;
    return formatLocalInstant(wholeMinute, userCtx.timezone);
  }
  const raw = resolveFrom(binding.from, evaluation);
  const optionalDefault = 'optional' in binding && binding.optional && isBlank(raw);
  switch (binding.type) {
    case 'integer':
      return optionalDefault ? (binding.default ?? fail()) : parseInteger(raw, binding);
    case 'enum':
      return optionalDefault ? (binding.default ?? fail()) : lookup(binding.values, raw);
    case 'text':
      return optionalDefault
        ? (binding.default ?? fail())
        : binding.capitalize
          ? capitalizeFirst(parseText(raw, binding.max ?? 200))
          : parseText(raw, binding.max ?? 200);
    case 'date':
      return optionalDefault
        ? isoDay(addDays(today(now, userCtx.timezone), DAY_WORD_OFFSETS[binding.default ?? fail()]))
        : parseDate(raw, binding, now, userCtx.timezone, dayBefore);
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
      return parseEventRef(raw, binding.reject, binding.stem);
    case 'event_phrase':
      return buildEventPhrase(binding, raw, evaluation);
    case 'recipient':
      return parseRecipient(raw);
  }
}

function periodKey(values: { [key: string]: (typeof PERIOD_KEYS)[number] }, raw: string): (typeof PERIOD_KEYS)[number] {
  const key = normalize(raw);
  return Object.hasOwn(values, key) ? values[key]! : fail();
}

function evaluateAll(bindings: Bindings, evaluation: Evaluation): BindValues {
  const bound: BindValues = {};
  for (const [name, binding] of Object.entries(bindings)) {
    bound[name] = evaluateOne(binding, bound, evaluation, name === evaluation.dayBefore);
  }
  return bound;
}

/** Bindings are evaluated in declaration order; a datetime may only read earlier bindings. */
export function evaluateBindings(
  bindings: Bindings,
  captures: { [key: string]: string },
  userCtx: UserContext,
  i18n: I18nMap | undefined,
  now: Date = new Date(),
): BindValues {
  return evaluateAll(bindings, { captures, userCtx, i18n, now, dayBefore: null });
}

/** The bindings as read for one of the days a marked date word may mean. */
export interface DayReading {
  /** YYYY-MM-DD the marked date binding takes in this reading. */
  day: string;
  bind: BindValues;
}

/**
 * The literal reading of the bindings and, when the date binding marked `after_midnight: 'both'`
 * reads 'today' or 'tomorrow' before 04:00 local, one reading per day that word may mean, the
 * earlier day first and the literal reading last. The validator allows one marked binding; should
 * a rule carry more, only the first is shifted, so each answer is labelled with the day it read.
 */
export function evaluateBindingReadings(
  bindings: Bindings,
  captures: { [key: string]: string },
  userCtx: UserContext,
  i18n: I18nMap | undefined,
  now: Date = new Date(),
): { literal: BindValues; afterMidnight: DayReading[] | null } {
  const literal = evaluateBindings(bindings, captures, userCtx, i18n, now);
  const marked = Object.keys(bindings).find((name) => {
    const binding = bindings[name];
    return binding?.type === 'date' && binding.after_midnight === 'both';
  });
  if (marked === undefined) return { literal, afterMidnight: null };
  let before: BindValues;
  try {
    before = evaluateAll(bindings, { captures, userCtx, i18n, now, dayBefore: marked });
  } catch (error) {
    // The earlier day is an extra reading, never a reason to fail: its wall time may not exist.
    if (error instanceof WorkflowInputError) return { literal, afterMidnight: null };
    throw error;
  }
  if (before[marked] === literal[marked]) return { literal, afterMidnight: null };
  return {
    literal,
    afterMidnight: [
      { day: String(before[marked]), bind: before },
      { day: String(literal[marked]), bind: literal },
    ],
  };
}
