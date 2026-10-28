// The answer key. Given an annotated conversation and the frozen clock, decide what a correct system does, then judge
// what the system under test actually did. Written against the tool/DB contract (what ends up in the calendar, which
// reads were made, which facts the reply states), never against the intent rules, so a seed change cannot move it.
import { TZDate } from '@date-fns/tz';
import { type Anchor, localInstant, weekdayIndex } from './anchor.ts';
import {
  type AiReason,
  type Conversation,
  type FamilyId,
  isoOf,
  type LocalDay,
  localDayOf,
  shiftDay,
  WEEKDAYS,
} from './history.ts';
import type { BotMessage, EventRow, Snapshot, ToolRecord, TurnObservation } from './world.ts';

export type Expected =
  | { kind: 'ai'; reason: AiReason; intentLike: boolean; relabelledFrom?: FamilyId }
  | { kind: 'rule'; family: FamilyId; slots: Slots; confirm: 'yes' | 'no' };

export type Slots = { [slot: string]: unknown };

export interface WorldEventView {
  id: number;
  title: string;
  startMs: number;
  durationMin: number;
}

export interface Observation {
  turns: TurnObservation[];
  before: Snapshot;
  afterFirstTurn: Snapshot;
  after: Snapshot;
  worldEvents: readonly WorldEventView[];
}

export type Outcome = 'correct' | 'wrong' | 'missed' | 'false_match' | 'ai_correct';

export interface Verdict {
  outcome: Outcome;
  problems: string[];
  /** A write reached the database before the user confirmed it, or after the user declined. */
  unconfirmedWrite: boolean;
  /** The layer or a tool threw instead of answering. */
  exception: boolean;
  /** A rule intercepted a message that should go to the AI and a write followed. */
  harmfulFalseMatch: boolean;
}

const fold = (text: string): string =>
  text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,!?;:]+$/, '');

const hhmm = (ms: number, tz: string): string => {
  const local = new TZDate(ms, tz);
  return `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
};

/** A wall time that exists exactly once in the zone, or null (skipped or repeated by a clock change). */
function uniqueWallTime(tz: string, day: LocalDay, at: string): number | null {
  const [hour, minute] = at.split(':').map(Number) as [number, number];
  const wall = Date.UTC(day.y, day.m - 1, day.d, hour, minute);
  const hits = new Set<number>();
  for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) {
    const offset = -new TZDate(probe, tz).getTimezoneOffset();
    const instant = wall - offset * 60_000;
    if (-new TZDate(instant, tz).getTimezoneOffset() === offset) hits.add(instant);
  }
  return hits.size === 1 ? ([...hits][0] ?? null) : null;
}

interface DaySlot {
  rel?: number;
  weekday?: (typeof WEEKDAYS)[number];
}

/** null: the day is ambiguous (a weekday that is today's weekday). */
function resolveDay(slot: DaySlot, anchor: Anchor): LocalDay | null {
  if (slot.rel !== undefined) return shiftDay(anchor.date, slot.rel);
  if (slot.weekday) {
    const target = WEEKDAYS.indexOf(slot.weekday);
    const today = weekdayIndex(anchor.date);
    return target === today ? null : shiftDay(anchor.date, (target - today + 7) % 7);
  }
  return null;
}

function periodRange(period: string, anchor: Anchor): { start: LocalDay; end: LocalDay } {
  const today = anchor.date;
  const monday = shiftDay(today, -weekdayIndex(today));
  switch (period) {
    case 'today':
      return { start: today, end: today };
    case 'tomorrow':
      return { start: shiftDay(today, 1), end: shiftDay(today, 1) };
    case 'week':
      return { start: today, end: shiftDay(today, 6) };
    case 'next_week':
      return { start: shiftDay(monday, 7), end: shiftDay(monday, 13) };
    case 'weekend':
      return { start: shiftDay(monday, 5), end: shiftDay(monday, 6) };
    default: {
      const shift = period === 'month' ? 0 : 1;
      const first = new Date(Date.UTC(today.y, today.m - 1 + shift, 1));
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
      return {
        start: { y: first.getUTCFullYear(), m: first.getUTCMonth() + 1, d: 1 },
        end: { y: last.getUTCFullYear(), m: last.getUTCMonth() + 1, d: last.getUTCDate() },
      };
    }
  }
}

const isoRange = (range: { start: LocalDay; end: LocalDay }) => ({ start: isoOf(range.start), end: isoOf(range.end) });

const FAMILIES_WITH_START: ReadonlySet<FamilyId> = new Set<FamilyId>([
  'event.create',
  'event.create_range',
  'event.create_invite',
]);

/** Edit distance with adjacent transposition, cut off at 2 (the oracle never borrows code from the engine it judges). */
function nearDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = rows[i] as number[];
      const above = rows[i - 1] as number[];
      let best = Math.min((above[j] as number) + 1, (row[j - 1] as number) + 1, (above[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, ((rows[i - 2] as number[])[j - 2] as number) + 1);
      row[j] = best;
    }
  return (rows[a.length] as number[])[b.length] as number;
}

type RuleExpectation = Extract<Expected, { kind: 'rule' }>;

/** A new event whose start (or end) is not one real future instant: skipped, repeated or already gone. */
function startsPastOrInvalid(day: DaySlot, slots: Slots, time: string, anchor: Anchor): boolean {
  const resolved = resolveDay(day, anchor) as LocalDay;
  const start = uniqueWallTime(anchor.tz, resolved, time);
  if (start === null || start <= anchor.instantMs) return true;
  if (typeof slots.endTime !== 'string') return false;
  const end = uniqueWallTime(anchor.tz, resolved, slots.endTime);
  return end === null || end <= start;
}

/** Why a reschedule cannot be judged as a rule answer, or null when it can. */
function rescheduleRelabel(
  slots: Slots,
  day: DaySlot | undefined,
  anchor: Anchor,
  world: readonly WorldEventView[],
): AiReason | null {
  const target = referencedEvent(slots.ref, world);
  let startDay: LocalDay | null = null;
  if (day) startDay = resolveDay(day, anchor) as LocalDay;
  else if (target) startDay = localDayOf(target.startMs, anchor.tz);
  const at = typeof slots.time === 'string' ? slots.time : target ? hhmm(target.startMs, anchor.tz) : null;
  if (!startDay || !at) return 'missing_slot';
  const start = uniqueWallTime(anchor.tz, startDay, at);
  return start === null || start <= anchor.instantMs ? 'past_or_invalid' : null;
}

/** What a correct system does with this conversation at this clock. A label the clock contradicts becomes AI-correct. */
export function expectedFor(conversation: Conversation, anchor: Anchor, world: readonly WorldEventView[]): Expected {
  const { expect } = conversation;
  if (expect.route === 'ai') return { kind: 'ai', reason: expect.why, intentLike: expect.intentLike };
  const relabel = (reason: AiReason): Expected => ({
    kind: 'ai',
    reason,
    intentLike: true,
    relabelledFrom: expect.family,
  });
  const slots = expect.slots;
  const day = slots.day as DaySlot | undefined;
  if (day && resolveDay(day, anchor) === null) return relabel('ambiguous_day');
  if (
    FAMILIES_WITH_START.has(expect.family) &&
    day &&
    typeof slots.time === 'string' &&
    startsPastOrInvalid(day, slots, slots.time, anchor)
  )
    return relabel('past_or_invalid');
  if (expect.family === 'event.reschedule') {
    const reason = rescheduleRelabel(slots, day, anchor, world);
    if (reason) return relabel(reason);
  }
  return { kind: 'rule', family: expect.family, slots, confirm: expect.confirm ?? 'yes' };
}

function referencedEvent(ref: unknown, world: readonly WorldEventView[]): WorldEventView | undefined {
  const spec = ref as { id?: number; title?: string } | undefined;
  if (spec?.id !== undefined) return world.find((event) => event.id === spec.id);
  if (spec?.title) return world.find((event) => fold(event.title).includes(fold(spec.title as string)));
  return undefined;
}

// ─── judging ─────────────────────────────────────────────────────────────────

/** A leading generic noun ("встреча с юристом" vs "с юристом") is not part of what the event is called. */
const LEADING_NOUN = /^(?:новое |новую )?(?:событие|встреч[ауи]|задач[ауи]|event|meeting|task) /;
const canonicalTitle = (title: string): string => fold(title).replace(LEADING_NOUN, '');

const sameTitle = (observed: string | undefined, wanted: string, alternatives: unknown): boolean => {
  if (observed === undefined) return false;
  const alts = Array.isArray(alternatives)
    ? alternatives.filter((item): item is string => typeof item === 'string')
    : [];
  const seen = canonicalTitle(observed);
  // A one-letter slip in the user's own spelling is not a different title: the benchmark judges meaning, not typos.
  return [wanted, ...alts].some((candidate) => {
    const want = canonicalTitle(candidate);
    return want === seen || (want.length >= 5 && nearDistance(want, seen) <= 1);
  });
};

const startOf = (row: EventRow): number => Date.parse(row.start_at);

interface EventDiff {
  created: EventRow[];
  changed: Array<[EventRow, EventRow]>;
  deleted: EventRow[];
}

function changedEvents(before: Snapshot, after: Snapshot): EventDiff {
  const known = new Map(before.events.map((row) => [row.id, row]));
  const created = after.events.filter((row) => !known.has(row.id) && row.is_deleted === 0);
  const changed: Array<[EventRow, EventRow]> = [];
  const deleted: EventRow[] = [];
  for (const row of after.events) {
    const old = known.get(row.id);
    if (!old) continue;
    if (row.is_deleted === 1 && old.is_deleted === 0) deleted.push(row);
    else if (JSON.stringify(row) !== JSON.stringify(old)) changed.push([old, row]);
  }
  return { created, changed, deleted };
}

const dbEquals = (a: Snapshot, b: Snapshot): boolean => JSON.stringify(a) === JSON.stringify(b);

interface WriteContext {
  family: FamilyId;
  slots: Slots;
  anchor: Anchor;
  obs: Observation;
  target: WorldEventView | undefined;
  diff: EventDiff;
}

const dayOf = (slot: unknown, anchor: Anchor): LocalDay => resolveDay(slot as DaySlot, anchor) as LocalDay;

/** One problem per kind of event change whose count differs from the allowed one. */
function countProblems(diff: EventDiff, allowed: { created?: number; changed?: number; deleted?: number }): string[] {
  const problems: string[] = [];
  const only = (what: string, count: number, list: unknown[]) => {
    if (list.length !== count) problems.push(`${what}: expected ${count}, got ${list.length}`);
  };
  only('created events', allowed.created ?? 0, diff.created);
  only('changed events', allowed.changed ?? 0, diff.changed);
  only('deleted events', allowed.deleted ?? 0, diff.deleted);
  return problems;
}

function invitationProblems({ slots, obs }: WriteContext, eventId: number | undefined): string[] {
  const invited = obs.after.invitations.filter((inv) => inv.event_id === eventId);
  const username = String(slots.invitee).replace(/^@/, '').toLowerCase();
  const addressedRight =
    invited.length === 1 && (invited[0]?.invitee_username ?? '').replace(/^@/, '').toLowerCase() === username;
  return addressedRight ? [] : ['invitation missing or addressed to someone else'];
}

function timingProblems(row: EventRow, slots: Slots, anchor: Anchor): string[] {
  const problems: string[] = [];
  const wanted = uniqueWallTime(anchor.tz, dayOf(slots.day, anchor), String(slots.time));
  if (startOf(row) !== wanted) problems.push(`start ${row.start_at} != wanted ${new Date(wanted ?? 0).toISOString()}`);
  if (typeof slots.endTime === 'string') {
    const end = uniqueWallTime(anchor.tz, dayOf(slots.day, anchor), slots.endTime);
    if (!row.end_at || Date.parse(row.end_at) !== end) problems.push('end time differs');
  }
  if (
    typeof slots.duration === 'number' &&
    row.end_at &&
    Date.parse(row.end_at) - startOf(row) !== slots.duration * 60_000
  )
    problems.push('duration differs');
  return problems;
}

function createProblems(ctx: WriteContext): string[] {
  const { family, slots, anchor, diff } = ctx;
  const problems = countProblems(diff, { created: 1 });
  const row = diff.created[0];
  if (!row) return problems;
  const isReminder = family === 'reminder.after';
  const wantedTitle = String(isReminder ? slots.text : slots.title);
  const alternatives = isReminder ? slots.textAlt : slots.titleAlt;
  if (!sameTitle(row.title, wantedTitle, alternatives)) problems.push(`title "${row.title}" != "${wantedTitle}"`);
  if (isReminder) {
    const wantedStart = anchor.instantMs + Number(slots.minutes) * 60_000;
    if (Math.abs(startOf(row) - wantedStart) > 90_000) problems.push('reminder start is not now + minutes');
  } else problems.push(...timingProblems(row, slots, anchor));
  if (family === 'event.create_invite') problems.push(...invitationProblems(ctx, row.id));
  return problems;
}

function deleteProblems({ diff, target }: WriteContext): string[] {
  const problems = countProblems(diff, { deleted: 1 });
  const [gone] = diff.deleted;
  if (gone && gone.id !== target?.id) problems.push(`deleted #${gone.id}, wanted #${target?.id}`);
  return problems;
}

function movedProblems({ slots, anchor }: WriteContext, target: WorldEventView, row: EventRow): string[] {
  const startDay = slots.day ? dayOf(slots.day, anchor) : localDayOf(target.startMs, anchor.tz);
  const at = typeof slots.time === 'string' ? slots.time : hhmm(target.startMs, anchor.tz);
  return startOf(row) !== uniqueWallTime(anchor.tz, startDay, at) ? [`moved to ${row.start_at}`] : [];
}

function changeDetailProblems(ctx: WriteContext, target: WorldEventView, old: EventRow, row: EventRow): string[] {
  const { family, slots } = ctx;
  if (family === 'event.reschedule') return movedProblems(ctx, target, row);
  if (family === 'event.rename')
    return sameTitle(row.title, String(slots.title), slots.titleAlt) ? [] : [`title "${row.title}"`];
  if (family === 'event.set_detail') {
    const field = slots.field === 'location' ? row.location : row.description;
    return fold(field ?? '') !== fold(String(slots.value)) ? [`${slots.field} is "${field}"`] : [];
  }
  return startOf(row) - startOf(old) !== Number(slots.minutes) * 60_000 ? ['snooze offset differs'] : [];
}

function changeProblems(ctx: WriteContext): string[] {
  const problems = countProblems(ctx.diff, { changed: 1 });
  const pair = ctx.diff.changed[0];
  const { target } = ctx;
  if (!pair || !target) return problems;
  const [old, row] = pair;
  if (old.id !== target.id) problems.push(`changed #${old.id}, wanted #${target.id}`);
  problems.push(...changeDetailProblems(ctx, target, old, row));
  return problems;
}

function hideProblems({ diff, obs, target }: WriteContext): string[] {
  const problems = countProblems(diff, {});
  if (!obs.after.visibility.some((row) => row.event_id === target?.id && row.visibility === 'private'))
    problems.push('event was not made private');
  return problems;
}

function reminderSetProblems({ diff, obs, slots, target }: WriteContext): string[] {
  const problems = countProblems(diff, {});
  const stored = obs.after.reminders.filter(
    (row) => row.event_id === target?.id && row.interval_minutes === slots.minutes,
  );
  const override = obs.after.overrides.find((row) => row.id === target?.id)?.reminder_overrides ?? '';
  if (stored.length === 0 && !override.split(/\D+/).includes(String(slots.minutes)))
    problems.push('reminder not stored');
  return problems;
}

function reminderClearProblems({ obs, target }: WriteContext): string[] {
  return obs.after.reminders.some((row) => row.event_id === target?.id) ? ['reminders remain'] : [];
}

const WRITE_CHECKS: Partial<Record<FamilyId, (context: WriteContext) => string[]>> = {
  'event.create': createProblems,
  'event.create_range': createProblems,
  'event.create_invite': createProblems,
  'reminder.after': createProblems,
  'event.delete': deleteProblems,
  'event.reschedule': changeProblems,
  'event.rename': changeProblems,
  'event.set_detail': changeProblems,
  'event.snooze': changeProblems,
  'event.hide': hideProblems,
  'reminder.set': reminderSetProblems,
  'reminder.clear': reminderClearProblems,
  'invite.send': (ctx) => invitationProblems(ctx, ctx.target?.id),
};

/** What the calendar must look like after the user said yes. Problems are empty when it matches. */
function writeProblems(expected: RuleExpectation, anchor: Anchor, obs: Observation): string[] {
  const { family, slots } = expected;
  const context: WriteContext = {
    family,
    slots,
    anchor,
    obs,
    target: referencedEvent(slots.ref, obs.worldEvents),
    diff: changedEvents(obs.before, obs.after),
  };
  return WRITE_CHECKS[family]?.(context) ?? [];
}

const READ_TOOLS: Partial<Record<FamilyId, readonly string[]>> = {
  'calendar.upcoming': ['get_upcoming'],
  'holidays.upcoming': ['get_holidays'],
  'contacts.list': ['get_contacts'],
  'contacts.find': ['find_contact'],
  'settings.view': ['manage_settings'],
  'time.now': ['get_timezone_info'],
  'calc.evaluate': ['calculate'],
  'bot.info': ['get_bot_info'],
  'google.status': ['get_google_calendar_status'],
  'calendar.image': ['render_day_image', 'render_week_image', 'render_month_image'],
  'slots.day': ['get_free_slots'],
  'slots.check_time': ['get_free_slots'],
};

const text = (messages: BotMessage[]): string => fold(messages.map((m) => m.text).join('\n'));

function dateArg(tools: ToolRecord[], name: string, key: string, wanted: string): boolean {
  return tools.some(
    (call) => call.name === name && call.ok && (call.input as { [k: string]: unknown })[key] === wanted,
  );
}

function eventsInRange(world: readonly WorldEventView[], tz: string, range: { start: LocalDay; end: LocalDay }) {
  const [from, to] = [isoOf(range.start), isoOf(range.end)];
  return world.filter((event) => {
    const day = isoOf(localDayOf(event.startMs, tz));
    return day >= from && day <= to;
  });
}

interface ReadContext {
  family: FamilyId;
  slots: Slots;
  anchor: Anchor;
  obs: Observation;
  tools: ToolRecord[];
  reply: string;
}

const omittedFacts = (reply: string, events: readonly WorldEventView[]): string[] =>
  events.filter((event) => !reply.includes(fold(event.title))).map((event) => `reply omits "${event.title}"`);

function calendarDayProblems({ slots, anchor, obs, tools, reply }: ReadContext): string[] {
  const day = dayOf(slots.day, anchor);
  const problems = dateArg(tools, 'get_events', 'start_date', isoOf(day)) ? [] : [`no get_events for ${isoOf(day)}`];
  return [...problems, ...omittedFacts(reply, eventsInRange(obs.worldEvents, anchor.tz, { start: day, end: day }))];
}

function calendarRangeProblems({ family, slots, anchor, obs, tools, reply }: ReadContext): string[] {
  const range = periodRange(String(slots.period), anchor);
  const wanted = isoRange(range);
  const asked = tools.some(
    (call) =>
      call.name === 'get_events' &&
      call.ok &&
      JSON.stringify([
        (call.input as { start_date?: string }).start_date,
        (call.input as { end_date?: string }).end_date,
      ]) === JSON.stringify([wanted.start, wanted.end]),
  );
  const problems = asked ? [] : [`no get_events for ${wanted.start}..${wanted.end}`];
  const inRange = eventsInRange(obs.worldEvents, anchor.tz, range);
  if (family === 'calendar.period') problems.push(...omittedFacts(reply, inRange));
  else if (!reply.includes(String(inRange.length))) problems.push(`count ${inRange.length} not stated`);
  return problems;
}

function calendarSearchProblems({ slots, obs, tools, reply }: ReadContext): string[] {
  const query = fold(String(slots.query));
  const searched = tools.some(
    (call) =>
      call.name === 'search_events' &&
      call.ok &&
      fold(String((call.input as { query?: string }).query ?? '')).length > 0,
  );
  const loaded = tools.some((call) => call.name === 'get_event' && call.ok);
  const problems = searched || loaded ? [] : ['no search_events/get_event call'];
  const matching = obs.worldEvents.filter(
    (event) => fold(event.title).includes(query) || query.includes(fold(event.title).slice(0, 4)),
  );
  return [...problems, ...omittedFacts(reply, matching.slice(0, 1))];
}

function calendarUpcomingProblems({ anchor, obs, reply }: ReadContext): string[] {
  const next = [...obs.worldEvents]
    .filter((event) => event.startMs > anchor.instantMs)
    .sort((a, b) => a.startMs - b.startMs)[0];
  return next && !reply.includes(fold(next.title)) ? [`reply omits next event "${next.title}"`] : [];
}

function freeSlotsProblems({ slots, anchor, tools }: ReadContext): string[] {
  const day = dayOf(slots.day, anchor);
  return dateArg(tools, 'get_free_slots', 'date', isoOf(day)) ? [] : [`no get_free_slots for ${isoOf(day)}`];
}

function eventReadProblems({ slots, obs, tools }: ReadContext): string[] {
  const target = referencedEvent(slots.ref, obs.worldEvents);
  const ids = tools.filter((call) => call.ok).map((call) => (call.input as { event_id?: number }).event_id);
  return !target || !ids.includes(target.id) ? [`no read of event #${target?.id}`] : [];
}

const READ_CHECKS: Partial<Record<FamilyId, (context: ReadContext) => string[]>> = {
  'calendar.day': calendarDayProblems,
  'calendar.period': calendarRangeProblems,
  'calendar.count': calendarRangeProblems,
  'calendar.search': calendarSearchProblems,
  'calendar.when': calendarSearchProblems,
  'calendar.upcoming': calendarUpcomingProblems,
  'slots.day': freeSlotsProblems,
  'slots.check_time': freeSlotsProblems,
  'event.show': eventReadProblems,
  'reminder.list': eventReadProblems,
  'invite.status': eventReadProblems,
};

/** The reads made and the facts stated by an answer to a read request. */
function readProblems(expected: RuleExpectation, anchor: Anchor, obs: Observation): string[] {
  const { family, slots } = expected;
  const first = obs.turns[0];
  if (!first) return ['no turn'];
  const tools = first.tools;
  const named = READ_TOOLS[family];
  const missingRead = named && !tools.some((call) => named.includes(call.name) && call.ok);
  const problems = missingRead ? [`no ${named.join('|')} call`] : [];
  const context: ReadContext = { family, slots, anchor, obs, tools, reply: text(first.messages) };
  return [...problems, ...(READ_CHECKS[family]?.(context) ?? [])];
}

function judgeAiExpectation(
  base: Verdict,
  expected: Extract<Expected, { kind: 'ai' }>,
  first: TurnObservation,
  wrote: boolean,
): Verdict {
  if (first.handled !== true) return { ...base, outcome: 'ai_correct' };
  return {
    ...base,
    outcome: 'false_match',
    problems: [`a rule answered an AI-correct message (${expected.reason})`],
    harmfulFalseMatch: wrote,
  };
}

/** A write family must ask first, change nothing before the yes, and change nothing at all after a no. */
function judgeWrite(
  expected: RuleExpectation,
  anchor: Anchor,
  obs: Observation,
  first: TurnObservation,
  wrote: boolean,
): { problems: string[]; unconfirmedWrite: boolean } {
  const problems: string[] = [];
  let unconfirmedWrite = !dbEquals(obs.before, obs.afterFirstTurn);
  if (unconfirmedWrite) problems.push('a write happened before the user confirmed');
  if (!first.messages.some((message) => message.keyboard.length > 0)) problems.push('no confirmation question');
  if (expected.confirm !== 'no') {
    problems.push(...writeProblems(expected, anchor, obs));
    return { problems, unconfirmedWrite };
  }
  if (wrote) {
    problems.push('a write happened although the user declined');
    unconfirmedWrite = true;
  }
  return { problems, unconfirmedWrite };
}

export function judge(anchor: Anchor, expected: Expected, obs: Observation): Verdict {
  const first = obs.turns[0];
  const threw = obs.turns.some((turn) => turn.threw !== undefined);
  const base: Verdict = {
    outcome: 'wrong',
    problems: [],
    unconfirmedWrite: false,
    exception: threw,
    harmfulFalseMatch: false,
  };
  if (!first) return { ...base, problems: ['no turn'] };
  const wrote = !dbEquals(obs.before, obs.after);
  if (expected.kind === 'ai') return judgeAiExpectation(base, expected, first, wrote);
  if (first.handled !== true) return { ...base, outcome: 'missed', exception: threw };
  const problems: string[] = [];
  if (threw) problems.push('exception while answering');
  let unconfirmedWrite = false;
  if (isWriteFamily(expected.family)) {
    const written = judgeWrite(expected, anchor, obs, first, wrote);
    problems.push(...written.problems);
    unconfirmedWrite = written.unconfirmedWrite;
  } else problems.push(...readProblems(expected, anchor, obs));
  return {
    outcome: problems.length === 0 ? 'correct' : 'wrong',
    problems,
    unconfirmedWrite,
    exception: threw,
    harmfulFalseMatch: false,
  };
}

const WRITE_FAMILIES: ReadonlySet<FamilyId> = new Set<FamilyId>([
  'reminder.after',
  'event.delete',
  'event.reschedule',
  'event.rename',
  'event.set_detail',
  'event.snooze',
  'event.hide',
  'reminder.set',
  'reminder.clear',
  'invite.send',
]);

export const isWriteFamily = (family: FamilyId): boolean =>
  family.startsWith('event.create') || WRITE_FAMILIES.has(family);

export { localInstant };
