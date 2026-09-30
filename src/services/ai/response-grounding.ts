// src/services/ai/response-grounding.ts
// Deterministic evidence matching for agent prose. Checks whether the concrete
// facts in an answer (clock times, calendar days, quoted text, event ids) come
// from tool results of the same run, and collects the schedule events those
// reads returned so an unverified answer can fall back to verified data.

import { TZDate } from '@date-fns/tz';
import { addDays, format } from 'date-fns';
import type { EventSummary } from '../intent/variable-resolver.ts';
import type { ToolResultData } from './types.ts';

/** Tools whose results describe the user's schedule. */
export const SCHEDULE_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_events',
  'search_events',
  'get_upcoming',
  'get_event',
  'get_free_slots',
]);

/** One executed tool call and the result it returned in this run. */
export interface ToolEvidence {
  name: string;
  input: { [key: string]: unknown };
  success: boolean;
  output?: string;
  data?: ToolResultData;
}

export interface GroundingReport {
  /** Concrete facts found in the prose. */
  checked: number;
  /** The prose tokens no same-run tool result supports. */
  ungrounded: string[];
  /** The ungrounded tokens that quote a title or give an event id, never a bare time or date. */
  ungroundedTitlesAndIds: string[];
  /**
   * Tokens supported only by context, not by calendar data: today's or tomorrow's date,
   * the user's own words, or the arguments the model chose for its tool calls.
   */
  contextOnly: string[];
  /** The contextOnly tokens that name a day: only today's or tomorrow's date backs them. */
  contextOnlyDays: string[];
}

interface EvidenceIndex {
  /** HH:MM wall clock in the user's zone. */
  localTimes: Set<string>;
  /** HH:MM UTC; prose may use these only when it labels them as UTC. */
  utcTimes: Set<string>;
  /** MM-DD calendar days the evidence covers, in the user's zone and in UTC. */
  days: Set<string>;
  ids: Set<number>;
  /** Normalized text of the successful results, for quotes. */
  text: string;
}

/** What the prose may mention without it being calendar data. */
interface GroundingContext {
  /** Today and tomorrow in the user's zone (MM-DD): naming them needs no read. */
  days: Set<string>;
  /** Normalized user message and tool-call arguments. */
  text: string;
}

type Fact =
  | { kind: 'time'; token: string; value: string; utc: boolean }
  | { kind: 'instant'; token: string; utcTime: string | null; localTime: string | null; days: string[] }
  | { kind: 'day'; token: string; value: string }
  | { kind: 'dayOrTime'; token: string; day: string | null; time: string | null }
  | { kind: 'quote'; token: string; value: string }
  | { kind: 'id'; token: string; value: number };

/** A get_events range longer than this is only indexed up to this many days. */
const MAX_RANGE_DAYS = 62;
/** How far after a clock time a "UTC" label may appear, e.g. "10:30 – 11:30 (UTC)". */
const UTC_LABEL_WINDOW = 20;

const ISO_DATETIME = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?/g;
const COLON_TIME = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g;
const DOTTED = /(?<![\d.])(\d{1,2})\.(\d{2})(?:\.(\d{4}|\d{2}))?(?!\d|\.\d)/g;
const UTC_LABEL = /\b(?:UTC|GMT)\b/i;
/** A quoted span: an event title or someone's words. */
export const QUOTED = /«([^«»\n]{1,80})»|“([^“”\n]{1,80})”|„([^“”\n]{1,80})“|"([^"\n]{1,80})"/g;
const EVENT_ID = /\bid\s*[:#№]?\s*(\d{1,9})\b/gi;

const RU_MONTHS = [
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
const EN_MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const EN_MONTH_PATTERN = `(${EN_MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)`;
const RU_DAY_MONTH = new RegExp(`(?<!\\d)(\\d{1,2})(?:-?(?:го|е|ое))?\\s+(${RU_MONTHS.join('|')})(?![а-яё])`, 'gi');
const EN_DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${EN_MONTH_PATTERN}\\b`, 'gi');
const EN_MONTH_DAY = new RegExp(`\\b${EN_MONTH_PATTERN}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');

/**
 * Past-tense or passive statements that a calendar change already happened,
 * and generic completion confirmations ("Готово", "Done", ✅).
 * Future forms ("перенесу", "создам") and nouns ("создатель") do not match.
 */
const COMPLETED_WRITE_PATTERNS = [
  /(?<![а-яё])(?:удалил|создал|добавил|отменил|изменил|обновил|отправил|пригласил|сохранил|записал|поставил|переименовал|сделал)(?:а|и)?(?![а-яё])/i,
  /(?<![а-яё])(?:удал[её]н|создан|добавлен|отмен[её]н|измен[её]н|обновл[её]н|отправлен|приглаш[её]н|сохран[её]н|переименован|сделан)(?:а|о|ы)?(?![а-яё])/i,
  /(?<![а-яё])(?:перен[её]с(?:ла|ли)?|перенес[её]н(?:а|о|ы)?|готово)(?![а-яё])/i,
  /\b(?:deleted|removed|created|added|moved|rescheduled|cancell?ed|updated|renamed|sent|invited|saved|booked|done|all set)\b/i,
  /✅/u,
];

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function monthIndex(name: string): number {
  const lower = name.toLowerCase();
  const ru = RU_MONTHS.indexOf(lower);
  if (ru >= 0) return ru + 1;
  return EN_MONTHS.findIndex((month) => month.startsWith(lower.slice(0, 3))) + 1;
}

function dayKey(month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${pad2(month)}-${pad2(day)}`;
}

/** Blank matched spans so later patterns cannot re-read their digits. */
function blank(text: string, start: number, length: number): string {
  return text.slice(0, start) + ' '.repeat(length) + text.slice(start + length);
}

function isUtcLabelled(text: string, start: number, end: number): boolean {
  const lineEnd = text.indexOf('\n', end);
  const after = text.slice(end, lineEnd === -1 ? end + UTC_LABEL_WINDOW : Math.min(lineEnd, end + UTC_LABEL_WINDOW));
  return UTC_LABEL.test(after) || /UTC\s*$/i.test(text.slice(Math.max(0, start - 4), start));
}

function instantFact(match: RegExpExecArray, timezone: string): Fact {
  const [token, year, month, day, hour, minute, zone] = match;
  const calendarDay = `${month}-${day}`;
  if (hour === undefined || minute === undefined) return { kind: 'day', token, value: calendarDay };
  if (zone === undefined) {
    return { kind: 'instant', token, utcTime: null, localTime: `${hour}:${minute}`, days: [calendarDay] };
  }
  const offset = zone === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const instant = new Date(`${year}-${month}-${day}T${hour}:${minute}:00${offset}`);
  if (Number.isNaN(instant.getTime())) return { kind: 'day', token, value: calendarDay };
  const utc = instant.toISOString();
  const local = new TZDate(instant.getTime(), timezone);
  return {
    kind: 'instant',
    token,
    utcTime: utc.slice(11, 16),
    localTime: format(local, 'HH:mm'),
    days: [utc.slice(5, 10), format(local, 'MM-dd')],
  };
}

/** Every concrete, checkable fact in a piece of text. */
function extractFacts(source: string, timezone: string): Fact[] {
  const facts: Fact[] = [];
  let text = source;

  for (const match of source.matchAll(ISO_DATETIME)) {
    facts.push(instantFact(match, timezone));
    text = blank(text, match.index, match[0].length);
  }
  for (const pattern of [RU_DAY_MONTH, EN_DAY_MONTH]) {
    for (const match of text.matchAll(pattern)) {
      const key = dayKey(monthIndex(match[2] ?? ''), Number(match[1]));
      if (key) facts.push({ kind: 'day', token: match[0], value: key });
      text = blank(text, match.index, match[0].length);
    }
  }
  for (const match of text.matchAll(EN_MONTH_DAY)) {
    const key = dayKey(monthIndex(match[1] ?? ''), Number(match[2]));
    if (key) facts.push({ kind: 'day', token: match[0], value: key });
    text = blank(text, match.index, match[0].length);
  }
  for (const match of text.matchAll(COLON_TIME)) {
    const end = match.index + match[0].length;
    const meridiem = /^\s?([ap])\.?\s?m\b/i.exec(text.slice(end, end + 6))?.[1]?.toLowerCase();
    const hour = Number(match[1]);
    const hour24 = meridiem && hour >= 1 && hour <= 12 ? (hour % 12) + (meridiem === 'p' ? 12 : 0) : hour;
    const value = `${pad2(hour24)}:${match[2]}`;
    facts.push({ kind: 'time', token: match[0], value, utc: isUtcLabelled(text, match.index, end) });
    text = blank(text, match.index, match[0].length);
  }
  for (const match of text.matchAll(DOTTED)) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const day = dayKey(second, first);
    if (match[3] !== undefined) {
      if (day) facts.push({ kind: 'day', token: match[0], value: day });
      continue;
    }
    const time = first <= 23 && second <= 59 ? `${pad2(first)}:${match[2]}` : null;
    if (day || time) facts.push({ kind: 'dayOrTime', token: match[0], day, time });
  }
  for (const match of source.matchAll(QUOTED)) {
    const quoted = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    const value = normalizeText(quoted).replace(/^[\s.,!?;:—-]+|[\s.,!?;:—-]+$/g, '');
    if (value) facts.push({ kind: 'quote', token: match[0], value });
  }
  for (const match of source.matchAll(EVENT_ID)) {
    facts.push({ kind: 'id', token: match[0], value: Number(match[1]) });
  }
  return facts;
}

function isEventSummary(value: unknown): value is EventSummary {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'id' in value &&
    typeof value.id === 'number' &&
    'title' in value &&
    typeof value.title === 'string' &&
    'date' in value &&
    typeof value.date === 'string' &&
    'all_day' in value &&
    typeof value.all_day === 'boolean'
  );
}

function eventSummaries(data: ToolResultData | undefined): EventSummary[] {
  if (Array.isArray(data)) return data.filter(isEventSummary);
  return isEventSummary(data) ? [data] : [];
}

function addFact(index: EvidenceIndex, fact: Fact): void {
  switch (fact.kind) {
    case 'time':
      (fact.utc ? index.utcTimes : index.localTimes).add(fact.value);
      return;
    case 'instant':
      if (fact.utcTime) index.utcTimes.add(fact.utcTime);
      if (fact.localTime) index.localTimes.add(fact.localTime);
      for (const day of fact.days) index.days.add(day);
      return;
    case 'day':
      index.days.add(fact.value);
      return;
    case 'dayOrTime':
      if (fact.day) index.days.add(fact.day);
      if (fact.time) index.localTimes.add(fact.time);
      return;
    case 'id':
      index.ids.add(fact.value);
      return;
    case 'quote':
      return;
  }
}

/** Local calendar day of a date-only or instant boundary of a read range. */
function localDay(value: unknown, timezone: string): TZDate | null {
  if (typeof value !== 'string') return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return new TZDate(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), timezone);
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : new TZDate(instant.getTime(), timezone);
}

/** A successful read of a day range backs statements about every day in it, empty ones included. */
function addReadRange(index: EvidenceIndex, start: unknown, end: unknown, timezone: string): void {
  const first = localDay(start, timezone);
  const last = localDay(end, timezone) ?? first;
  if (!first || !last) return;
  for (let offset = 0; offset < MAX_RANGE_DAYS; offset++) {
    const day = addDays(first, offset);
    if (format(day, 'yyyy-MM-dd') > format(last, 'yyyy-MM-dd')) break;
    index.days.add(format(day, 'MM-dd'));
  }
}

function indexEvidence(tools: readonly ToolEvidence[], timezone: string): EvidenceIndex {
  const index: EvidenceIndex = {
    localTimes: new Set(),
    utcTimes: new Set(),
    days: new Set(),
    ids: new Set(),
    text: '',
  };
  const texts: string[] = [];

  for (const tool of tools) {
    if (!tool.success) continue;
    if (tool.output) {
      texts.push(tool.output);
      // A conversion or other computed output is the model's arithmetic, not calendar data.
      if (SCHEDULE_READ_TOOLS.has(tool.name)) {
        for (const fact of extractFacts(tool.output, timezone)) addFact(index, fact);
      }
    }
    for (const event of eventSummaries(tool.data)) {
      index.ids.add(event.id);
      index.days.add(event.date.slice(5));
      if (event.time) index.localTimes.add(event.time);
      if (event.end_at) {
        for (const fact of extractFacts(event.end_at, timezone)) addFact(index, fact);
      }
      texts.push(event.title, event.description ?? '', event.location ?? '');
    }
    if (tool.name === 'get_events') addReadRange(index, tool.input.start_date, tool.input.end_date, timezone);
    if (tool.name === 'get_free_slots') addReadRange(index, tool.input.date, tool.input.date, timezone);
  }
  index.text = normalizeText(texts.join('\n'));
  return index;
}

function groundingContext(
  tools: readonly ToolEvidence[],
  timezone: string,
  userMessage: string,
  now: Date,
): GroundingContext {
  const today = new TZDate(now.getTime(), timezone);
  const texts = [userMessage];
  for (const tool of tools) {
    if (!tool.success) continue;
    for (const value of Object.values(tool.input)) {
      if (typeof value === 'string') texts.push(value);
    }
  }
  return {
    days: new Set([format(today, 'MM-dd'), format(addDays(today, 1), 'MM-dd')]),
    text: normalizeText(texts.join('\n')),
  };
}

/** Whether the evidence backs the fact; with `context`, today's and tomorrow's dates and the user's and tool-call words count too. */
function isGrounded(fact: Fact, index: EvidenceIndex, context: GroundingContext | null): boolean {
  const hasDay = (day: string) => index.days.has(day) || context?.days.has(day) === true;
  switch (fact.kind) {
    case 'time':
      return index.localTimes.has(fact.value) || (fact.utc && index.utcTimes.has(fact.value));
    case 'instant':
      return (
        fact.days.some(hasDay) &&
        ((fact.utcTime !== null && index.utcTimes.has(fact.utcTime)) ||
          (fact.localTime !== null && index.localTimes.has(fact.localTime)))
      );
    case 'day':
      return hasDay(fact.value);
    case 'dayOrTime':
      return (fact.day !== null && hasDay(fact.day)) || (fact.time !== null && index.localTimes.has(fact.time));
    case 'quote':
      return index.text.includes(fact.value) || context?.text.includes(fact.value) === true;
    case 'id':
      return index.ids.has(fact.value);
  }
}

/**
 * Match every concrete fact in `response` against the successful tool results
 * of the same run. Clock times must match the user's local wall clock; a UTC
 * clock time counts only when the prose labels it as UTC, so an answer that
 * shows stored UTC times as local ones is never considered grounded.
 */
export function checkGrounding(
  response: string,
  tools: readonly ToolEvidence[],
  timezone: string,
  userMessage: string,
  now: Date = new Date(),
): GroundingReport {
  const index = indexEvidence(tools, timezone);
  const context = groundingContext(tools, timezone, userMessage, now);
  const report: GroundingReport = {
    checked: 0,
    ungrounded: [],
    ungroundedTitlesAndIds: [],
    contextOnly: [],
    contextOnlyDays: [],
  };
  for (const fact of extractFacts(response, timezone)) {
    report.checked++;
    // Context only widens what counts, so the evidence-only check comes first.
    if (isGrounded(fact, index, null)) continue;
    if (isGrounded(fact, index, context)) {
      report.contextOnly.push(fact.token);
      // The context backs a quote with words and a day, instant or day-or-time fact with its day.
      if (fact.kind === 'day' || fact.kind === 'instant' || fact.kind === 'dayOrTime') {
        report.contextOnlyDays.push(fact.token);
      }
    } else {
      report.ungrounded.push(fact.token);
      if (fact.kind === 'quote' || fact.kind === 'id') report.ungroundedTitlesAndIds.push(fact.token);
    }
  }
  return report;
}

/** Whether the prose states that a calendar change has already been made. */
export function claimsCompletedWrite(response: string): boolean {
  return COMPLETED_WRITE_PATTERNS.some((pattern) => pattern.test(response));
}

/**
 * Events returned by the run's successful schedule reads, deduplicated and in
 * chronological order. Only data the handlers returned — never the prose.
 */
export function verifiedScheduleEvents(tools: readonly ToolEvidence[]): EventSummary[] {
  const seen = new Map<string, EventSummary>();
  for (const tool of tools) {
    if (!tool.success || !SCHEDULE_READ_TOOLS.has(tool.name)) continue;
    for (const event of eventSummaries(tool.data)) {
      seen.set(`${event.id}|${event.date}|${event.time ?? ''}`, event);
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.date === b.date ? (a.time ?? '').localeCompare(b.time ?? '') : a.date.localeCompare(b.date),
  );
}
