// src/services/ai/reply-time-guard.ts
// Deterministic backstop for one obviously wrong model output: showing an event's
// UTC clock time as the user's local time. Tool outputs and the stored events carry
// UTC instants; weaker models copy the "10:30" out of "2026-09-28T10:30:00.000Z"
// into a reply for a user whose event is at 12:30 local (2026-09-27 incident, #498).
//
// The guard never calls a model and only touches clock times it can tie to a real
// event: a line that names an event (by title or "id N") and shows that event's UTC
// start instead of its local start is rewritten with the clocks of every event it names.
// 12-hour times ("10:30 AM") are not 24-hour clock values and are left alone. Times on
// lines that name no event (free windows computed from the wrong times) are rewritten
// with the same mapping only when no named event really happens at one of the
// replaced times. Anything ambiguous is left as the model wrote it.

import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { AgentContext } from './types.ts';

/** One event occurrence the model could have been describing. */
export interface EventClock {
  id: number;
  title: string;
  /** UTC ISO instant. */
  startUtc: string;
  /** UTC ISO instant, null when the event has no end. */
  endUtc: string | null;
  /**
   * True when a tool result showed this event to the model in this run. Only such an
   * event, printed at its UTC time, proves the reply used UTC; schedule-window events
   * are corrected alongside it but never trigger a rewrite on their own.
   */
  fromTool: boolean;
}

interface ClockTimes {
  id: number;
  titleKey: string;
  fromTool: boolean;
  utcStart: string;
  localStart: string;
  /** UTC clock time → local clock time, only for times that differ. */
  mapping: Map<string, string>;
  localTimes: string[];
}

/** HH:MM not inside an ISO timestamp (T10:30) or a longer h:m:s value. */
const CLOCK_TIME_RE = /(?<![\d:T])(\d{1,2}):(\d{2})(?![\d:])/g;
/**
 * A clock time the model explicitly labelled as UTC (alone or as a range) is not presented as local:
 * "10:30 по времени UTC", "10:30 (всемирное время)", "по всемирному времени в 10:30", "UTC, 10:30".
 * A whole-hour non-zero offset ("UTC+2", "UTC +2", "GMT-10") names a local zone, so that time is still
 * corrected; "UTC+0" and a signed H:MM ("UTC-11:30", a range end or a half-hour zone) keep the label.
 * Both patterns spell «всемирное (с)координированное время» the same way; keep them in step.
 */
const UTC_LABEL_AFTER_RE =
  /^(?:\s*[-–—]\s*\d{1,2}:\d{2})?[\s(]*(?:по\s+(?:времени\s+)?)?(?:(?:UTC|GMT)(?!\s*[+\-−]0*[1-9]\d*(?![\d:]))|Z(?![A-Za-z])|Гринвич|всемирному|всемирн(?:ое|ому|ого)\s+(?:с?координированн[а-яё]*\s+)?врем[а-яё]*)/i;
// One quantifier owns each separator run ("UTC — (", "UTC, ", "10:30 (UTC)", "id: 7"): adjacent
// \s* groups backtrack quadratically or worse on long blanks, which degenerate model output can contain.
const UTC_LABEL_BEFORE_RE =
  /(?:(?:UTC|GMT)(?:\s*[+\-−]0+(?::0+)?)?|Гринвичу|всемирн(?:ое|ому|ого)\s+(?:с?координированн[а-яё]*\s+)?врем[а-яё]*)[\s:,—–(-]*(?:в\s+)?(?:\d{1,2}:\d{2}\s*[-–—]\s*)?$/i;
/** A 12-hour clock time (alone or as a range): its hour is not a 24-hour clock value. */
const MERIDIEM_AFTER_RE = /^(?:\s*[-–—]\s*\d{1,2}:\d{2})?\s*[ap]\.?m\.?(?![a-z])/i;
const ID_ANCHOR_RE = /(?:\bid[\s:#№]*|#)(\d{1,9})\b/gi;
/** Shorter titles ("Я", "ДР") would anchor to unrelated words. */
const MIN_TITLE_LENGTH = 3;

function titleKey(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();
}

function clockOf(isoUtc: string, timezone: string): { utc: string; local: string } {
  const instant = new Date(isoUtc);
  return { utc: instant.toISOString().slice(11, 16), local: format(new TZDate(instant, timezone), 'HH:mm') };
}

function toClockTimes(event: EventClock, timezone: string): ClockTimes {
  const start = clockOf(event.startUtc, timezone);
  const end = event.endUtc ? clockOf(event.endUtc, timezone) : null;
  const mapping = new Map<string, string>();
  if (start.utc !== start.local) mapping.set(start.utc, start.local);
  if (end && end.utc !== end.local) mapping.set(end.utc, end.local);
  return {
    id: event.id,
    titleKey: titleKey(event.title),
    fromTool: event.fromTool,
    utcStart: start.utc,
    localStart: start.local,
    mapping,
    localTimes: end ? [start.local, end.local] : [start.local],
  };
}

/** The HH:MM a reader takes as a 24-hour local time, or null (invalid, labelled UTC, or AM/PM). */
function shownLocalTime(line: string, index: number, length: number, hour: string, minute: string): string | null {
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  const after = line.slice(index + length);
  if (UTC_LABEL_AFTER_RE.test(after) || MERIDIEM_AFTER_RE.test(after)) return null;
  if (UTC_LABEL_BEFORE_RE.test(line.slice(0, index))) return null;
  return `${hour.padStart(2, '0')}:${minute}`;
}

function shownLocalTimes(line: string): Set<string> {
  const times = new Set<string>();
  for (const match of line.matchAll(CLOCK_TIME_RE)) {
    const time = shownLocalTime(line, match.index, match[0].length, match[1]!, match[2]!);
    if (time) times.add(time);
  }
  return times;
}

function rewriteLine(line: string, mapping: ReadonlyMap<string, string>): string {
  return line.replace(CLOCK_TIME_RE, (whole, hour: string, minute: string, index: number) => {
    const shown = shownLocalTime(line, index, whole.length, hour, minute);
    const local = shown ? mapping.get(shown) : undefined;
    if (!local) return whole;
    // Keep the writer's style: "9:30" stays unpadded, "09:30" stays padded.
    return hour.length === 1 && local.startsWith('0') ? local.slice(1) : local;
  });
}

/** Events a line names: exact ids first; otherwise titles, longest match wins. */
function namedEvents(line: string, events: readonly ClockTimes[]): ClockTimes[] {
  const ids = new Set<number>();
  for (const match of line.matchAll(ID_ANCHOR_RE)) ids.add(Number(match[1]));
  const byId = events.filter((event) => ids.has(event.id));
  if (byId.length > 0) return byId;

  const key = titleKey(line);
  const byTitle = events.filter((event) => event.titleKey.length >= MIN_TITLE_LENGTH && key.includes(event.titleKey));
  return byTitle.filter(
    (event) => !byTitle.some((other) => other.titleKey !== event.titleKey && other.titleKey.includes(event.titleKey)),
  );
}

/**
 * Merge mappings into target, only the UTC times in `only` when given; false when one UTC
 * time would map to two local times.
 */
function mergeMapping(
  target: Map<string, string>,
  source: ReadonlyMap<string, string>,
  only?: ReadonlySet<string>,
): boolean {
  for (const [utc, local] of source) {
    if (only && !only.has(utc)) continue;
    const existing = target.get(utc);
    if (existing !== undefined && existing !== local) return false;
    target.set(utc, local);
  }
  return true;
}

function showsUtcClock(event: ClockTimes, shown: ReadonlySet<string>): boolean {
  for (const utc of event.mapping.keys()) if (shown.has(utc)) return true;
  return false;
}

/**
 * Rewrite clock times that show a named event's UTC time as local. Returns the text
 * unchanged when nothing can be tied to an event or the correction would be ambiguous.
 */
export function correctUtcClockTimes(text: string, events: readonly EventClock[], timezone: string): string {
  const clocks = events.map((event) => toClockTimes(event, timezone)).filter((clock) => clock.mapping.size > 0);
  if (clocks.length === 0) return text;

  const lines = text.split('\n');
  const unnamedLines: number[] = [];
  const derivedMapping = new Map<string, string>();
  let derivedConsistent = true;
  // Local times of every named event: a free-window time equal to one of these may be right.
  const namedLocalTimes = new Set<string>();
  let toolEventShownInUtc = false;

  lines.forEach((line, index) => {
    const named = namedEvents(line, clocks);
    if (named.length === 0) {
      unnamedLines.push(index);
      return;
    }
    for (const event of named) for (const time of event.localTimes) namedLocalTimes.add(time);
    const shown = shownLocalTimes(line);
    if (named.some((event) => shown.has(event.localStart))) return;
    const shownInUtc = named.filter((event) => shown.has(event.utcStart));
    if (shownInUtc.length === 0) return;
    // The line is in UTC, so every named event's UTC time shown on it is converted: a window
    // between two events shows one's UTC end and the other's UTC start. Times the line does
    // not show cannot make it ambiguous.
    const mapping = new Map<string, string>();
    if (!named.every((event) => mergeMapping(mapping, event.mapping, shown))) return;
    lines[index] = rewriteLine(line, mapping);
    toolEventShownInUtc ||= shownInUtc.some((event) => event.fromTool);
    // Free windows are built from both ends of each converted event, shown here or not.
    const converted = named.filter((event) => showsUtcClock(event, shown));
    derivedConsistent &&= converted.every((event) => mergeMapping(derivedMapping, event.mapping));
  });

  if (!toolEventShownInUtc) return text;
  const derivedIsSafe = derivedConsistent && ![...derivedMapping.keys()].some((utc) => namedLocalTimes.has(utc));
  if (derivedIsSafe) for (const index of unnamedLines) lines[index] = rewriteLine(lines[index]!, derivedMapping);
  return lines.join('\n');
}

/**
 * An ask_user question and its buttons reach the user as one message, so they are corrected
 * as one text: a button that only carries a clock ("10:30") follows the question that names
 * the event, under the same rules as an unnamed line of a reply.
 */
export function correctAskedQuestion(
  question: string,
  options: readonly string[],
  events: readonly EventClock[],
  timezone: string,
): { question: string; options: string[] } {
  const questionLineCount = question.split('\n').length;
  const lines = correctUtcClockTimes([question, ...options].join('\n'), events, timezone).split('\n');
  let next = questionLineCount;
  return {
    question: lines.slice(0, questionLineCount).join('\n'),
    options: options.map((option) => {
      const start = next;
      next += option.split('\n').length;
      return lines.slice(start, next).join('\n');
    }),
  };
}

/**
 * Events this run could have described: every event a tool result showed the model,
 * plus the preloaded schedule window. A tool result is fresher than the window snapshot
 * (an update in this run moved the event), so a surfaced id replaces its window rows.
 */
export function eventClocksForRun(
  ctx: Pick<AgentContext, 'surfacedEvents' | 'recentEventsWindow' | 'user'>,
): EventClock[] {
  const clocks: EventClock[] = [];
  const surfacedIds = new Set<number>();
  for (const summary of ctx.surfacedEvents ?? []) {
    if (summary.all_day || !summary.time) continue;
    const [year, month, day] = summary.date.split('-').map(Number);
    const [hour, minute] = summary.time.split(':').map(Number);
    // The summary keeps the local wall clock; on a DST fold this picks the first instant.
    const start = TZDate.tz(ctx.user.timezone, year!, month! - 1, day!, hour!, minute!);
    // A malformed row must degrade to "no correction", never crash the reply after the run.
    if (Number.isNaN(start.getTime()) || (summary.end_at && Number.isNaN(Date.parse(summary.end_at)))) continue;
    surfacedIds.add(summary.id);
    clocks.push({
      id: summary.id,
      title: summary.title,
      startUtc: new Date(start.getTime()).toISOString(),
      endUtc: summary.end_at ?? null,
      fromTool: true,
    });
  }
  for (const occurrence of ctx.recentEventsWindow ?? []) {
    if (occurrence.event.all_day || surfacedIds.has(occurrence.event.id)) continue;
    if (Number.isNaN(Date.parse(occurrence.occurrence_start))) continue;
    if (occurrence.occurrence_end && Number.isNaN(Date.parse(occurrence.occurrence_end))) continue;
    clocks.push({
      id: occurrence.event.id,
      title: occurrence.event.title,
      startUtc: occurrence.occurrence_start,
      endUtc: occurrence.occurrence_end ?? null,
      fromTool: false,
    });
  }
  return clocks;
}
