import { z } from 'zod';
import { t, toLang } from '../../config/constants.ts';
import type { CalendarEvent, ChatHistoryMessage } from '../../database/types.ts';
import { describeCalendarDay, storedInstantMs } from '../../utils/date.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import {
  type DayReferenceSet,
  describeDay,
  describeReferences,
  describeWeekdayDateMismatches,
  findWeekdayDateMismatches,
  localDayOf,
  readDayContent,
  shiftDay,
  type WeekdayDateMismatch,
  timeOnlyToday,
  weekdayOf,
} from './day-references.ts';
import { checkSecretaryAccess } from './tool-handlers/secretary-access.ts';
import { resolveScope } from './tool-handlers/shared.ts';
import type { AgentContext, ToolResult } from './types.ts';

/**
 * Pre-dispatch guard: the event writes and reads in targetOf must target a day the user
 * named in this turn. When the user said "в среду" the model may only create, move,
 * delete or read on that Wednesday; a call for any other day is rejected before anything
 * is written, with an error that names the right date so the model can redo it. Other
 * date-bearing tools are not checked yet (#616).
 *
 * Incidents (Europe/Belgrade, 2026-09-25 and 2026-09-27): a Monday-and-Wednesday request was
 * created on the Sunday and Tuesday before; a Wednesday plan request read Monday; and a
 * "cancel on Tuesday" request deleted two past Tuesdays besides the misplaced ones.
 */

const AssistantToolCallsCodec = jsonCodec(
  z.object({
    tool_calls: z
      .array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) }))
      .optional()
      .nullable(),
    content: z.string().nullable().optional(),
  }),
);
const AskUserArgsCodec = jsonCodec(
  z.object({ question: z.string().optional(), options: z.array(z.string()).optional() }),
);
const ActivityCodec = jsonCodec(z.object({ kind: z.string() }));
/** A bot message sent outside the model (a scene, a rule's response), as the logger saves it. */
const BotMessageCodec = jsonCodec(z.object({ kind: z.enum(['bot', 'bot_edit']), text: z.string() }));

/**
 * The ask_user question the current message answers, with the user message that led to
 * it and when the question was asked — or null when the turn before this message did not
 * end in ask_user, or when the newest saved user message is not this one (a live-call
 * transcript is never saved).
 */
function pendingQuestion(
  messageText: string,
  history: ChatHistoryMessage[],
): { origin: ChatHistoryMessage; question: string; options: string[]; askedAt: string } | null {
  let index = history.length - 1;
  // The current message is the newest user row; bot edits of the question may follow it.
  while (index >= 0 && history[index]!.role !== 'user') index--;
  if (index < 0 || history[index]!.content.trim() !== messageText.trim()) return null;
  index--;
  let question: { text: string; options: string[]; askedAt: string } | null = null;
  for (; index >= 0; index--) {
    const row = history[index]!;
    if (row.role === 'tool') continue;
    if (row.role === 'user') {
      if (question === null || ActivityCodec.safeParse(row.content).success) return null;
      return { origin: row, question: question.text, options: question.options, askedAt: question.askedAt };
    }
    if (ActivityCodec.safeParse(row.content).success) continue;
    const turn = AssistantToolCallsCodec.safeParse(row.content);
    if (!turn.success) return null;
    const ask = turn.data.tool_calls?.find((call) => call.function.name === 'ask_user');
    if (question === null) {
      if (!ask) return null;
      const args = AskUserArgsCodec.safeParse(ask.function.arguments);
      const options = args.success ? (args.data.options ?? []) : [];
      const text = args.success ? [args.data.question ?? '', ...options].join('\n') : '';
      question = { text, options, askedAt: row.created_at };
    }
  }
  return null;
}

/** Words that only confirm the question ("Да", "да, давай", "Ок!") without asking for anything new. */
const CONFIRMATIONS: Record<string, true> = {
  да: true,
  ага: true,
  угу: true,
  ок: true,
  окей: true,
  давай: true,
  конечно: true,
  хорошо: true,
  yes: true,
  yep: true,
  ok: true,
  okay: true,
  sure: true,
};

/**
 * Whether the message answers the open question rather than skipping it for a new request:
 * one of the question's options (a tapped button sends its text) or a bare confirmation. Any
 * other reply may be a new request, and tying that to the question's day would reject the call
 * the user asked for; not inheriting only switches the guard off for the turn.
 */
function answersQuestion(messageText: string, options: readonly string[]): boolean {
  const reply = messageText.trim().toLowerCase();
  if (options.some((option) => option.trim().toLowerCase() === reply)) return true;
  const words = reply.split(/[\s,.!?…]+/u).filter((word) => word.length > 0);
  return words.length > 0 && words.every((word) => CONFIRMATIONS[word] === true);
}

/** The text an assistant row showed the user; empty for a tool-call turn or another activity. */
function assistantText(content: string): string {
  const sent = BotMessageCodec.safeParse(content);
  if (sent.success) return sent.data.text;
  if (ActivityCodec.safeParse(content).success) return '';
  const turn = AssistantToolCallsCodec.safeParse(content);
  return turn.success ? (turn.data.content ?? '') : content;
}

/**
 * Whether the bot's last reply before this message asked something in plain text ("Во
 * сколько?"): the message then answers it, and the day may have been named before. Any
 * question counts, a closing "Что-то ещё?" too: the time-only rule then imposes nothing.
 */
function answersPlainQuestion(messageText: string, history: ChatHistoryMessage[]): boolean {
  let index = history.length - 1;
  while (index >= 0 && history[index]!.role !== 'user') index--;
  if (index < 0 || history[index]!.content.trim() !== messageText.trim()) return false;
  for (index--; index >= 0; index--) {
    const row = history[index]!;
    if (row.role === 'tool') continue;
    if (row.role === 'user') return false;
    const text = assistantText(row.content);
    if (text.trim() === '') continue;
    return text.includes('?');
  }
  return false;
}

/**
 * The days this turn is allowed to touch: the ones named in the message, or — for an
 * answer to ask_user that names no day itself ("Да") — the ones named in the message
 * that led to the question, together with any day the question itself offered.
 */
export function resolveTurnDayReferences(
  messageText: string,
  history: ChatHistoryMessage[],
  now: Date,
  timezone: string,
): DayReferenceSet | null {
  const own = readDayContent(messageText, now, timezone);
  if (own.kind === 'named') return own.set;
  if (own.kind === 'open') return null;
  const pending = pendingQuestion(messageText, history);
  // An answer to a question keeps the date context the question was asked in (for ask_user
  // the days named then); a fresh message that states only a clock time means today while
  // that time is still ahead.
  if (!pending) return answersPlainQuestion(messageText, history) ? null : timeOnlyToday(messageText, now, timezone);
  if (!answersQuestion(messageText, pending.options)) return null;
  // Each message is read as of when it was written: a "Да" given days later confirms the
  // Tuesday meant then, not the one coming now.
  const originAt = storedInstantMs(pending.origin.created_at);
  const askedAt = storedInstantMs(pending.askedAt);
  if (!Number.isFinite(originAt) || !Number.isFinite(askedAt)) return null;
  const origin = readDayContent(pending.origin.content, new Date(originAt), timezone);
  if (origin.kind !== 'named') return null;
  const offered = readDayContent(pending.question, new Date(askedAt), timezone);
  if (offered.kind === 'open') return null;
  if (offered.kind === 'none') return origin.set;
  return {
    references: [...origin.set.references, ...offered.set.references],
    allowedDates: new Set([...origin.set.allowedDates, ...offered.set.allowedDates]),
  };
}

const StartInput = z.object({ start_at: z.string().optional(), owner_id: z.number().optional() });
const RangeInput = z.object({ start_date: z.string(), end_date: z.string() });
const DayInput = z.object({ date: z.string() });
const EventRefInput = z.object({
  event_id: z.number(),
  owner_id: z.number().optional(),
  scope: z.string().optional(),
});
const WeekInput = z.object({ week_start: z.string() });
const MonthInput = z.object({ month: z.string() });

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

/** Local days a date argument can mean: its written date and, for an instant, its local date. */
function daysOfArgument(value: string, timezone: string): string[] {
  const written = DATE_PREFIX.exec(value)?.[1];
  const local = value.includes('T') ? localDayOf(value, timezone) : null;
  return [written, local].filter((day): day is string => typeof day === 'string');
}

/** The local day a start falls on: a date-only (all-day) start is the day written. */
function dayOfStart(startAt: string, timezone: string): string | null {
  return startAt.includes('T') ? localDayOf(startAt, timezone) : (DATE_PREFIX.exec(startAt)?.[1] ?? null);
}

interface Target {
  /** What the call touches, for the error text. */
  what: string;
  /** The local days it touches: for a range every day from the first to the last. */
  first: string;
  last: string;
  /** How the model should redo it for a named day. */
  redo: (day: string) => string;
}

function localClock(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(instant))
    .replace(/^24:/, '00:');
}

function startTarget(what: string, startAt: string, timezone: string): Target | null {
  const day = dayOfStart(startAt, timezone);
  if (!day) return null;
  if (!startAt.includes('T')) {
    return { what: `${what} (${describeDay(day)})`, first: day, last: day, redo: (named) => `start_at "${named}"` };
  }
  const clock = localClock(startAt, timezone);
  return {
    what: `${what} (${describeDay(day)} ${clock} local)`,
    first: day,
    last: day,
    redo: (named) => `start_at from calculate("${named} ${clock} ${timezone} to UTC")`,
  };
}

/** The event a delete or an edit refers to, looked up the way its handler will look it up. */
function referencedEvent(ctx: AgentContext, input: unknown, action: string): CalendarEvent | null {
  const parsed = EventRefInput.safeParse(input);
  if (!parsed.success) return null;
  const { event_id: eventId, owner_id: ownerId } = parsed.data;
  // Without write access to someone else's calendar the handler refuses; nothing is revealed here.
  const access = checkSecretaryAccess(ctx.user.telegram_id, ownerId, ctx.secretary?.secretaryRepo ?? null, 'write');
  if (!access.ok) return null;
  if (resolveScope(parsed.data, ctx) === 'group') {
    return ctx.groupChatId === undefined ? null : ctx.eventService.getEventForGroup(eventId, ctx.groupChatId);
  }
  const owned = ctx.eventService.getEvent(eventId, access.effectiveUserId);
  if (owned || action !== 'delete') return owned;
  // Deleting an event the user only attends declines it; that event's day is the one touched.
  const attends = ctx.participantRepo?.findByEventAndUser(eventId, access.effectiveUserId)?.status === 'accepted';
  const organizer = attends ? ctx.eventService.getEventOwnerId(eventId) : null;
  return organizer === null ? null : ctx.eventService.getEvent(eventId, organizer);
}

function eventTarget(ctx: AgentContext, input: unknown, action: string): Target | null {
  const event = referencedEvent(ctx, input, action);
  // A series spans many days; changing it is not a single-day action.
  if (!event || event.recurrence_rule) return null;
  const day = dayOfStart(event.start_at, ctx.user.timezone);
  if (!day) return null;
  return {
    what: `Event ${event.id} «${event.title}» is on ${describeDay(day)}`,
    first: day,
    last: day,
    redo: (named) => `${action} only events that fall on ${named}`,
  };
}

function rangeTarget(first: string, last: string, redo: (day: string) => string): Target {
  return { what: `This call reads ${first}..${last}`, first, last, redo };
}

function targetOf(ctx: AgentContext, toolName: string, input: unknown): Target | null {
  const timezone = ctx.user.timezone;
  switch (toolName) {
    case 'create_event': {
      const parsed = StartInput.safeParse(input);
      if (!parsed.success || parsed.data.start_at === undefined) return null;
      return startTarget('This event starts', parsed.data.start_at, timezone);
    }
    case 'update_event': {
      // A move must land on a named day (it may leave any day); any other edit must be of an
      // event on a named day.
      const parsed = StartInput.safeParse(input);
      if (parsed.success && parsed.data.start_at !== undefined) {
        return startTarget('The new start', parsed.data.start_at, timezone);
      }
      return eventTarget(ctx, input, 'edit');
    }
    case 'delete_event':
      return eventTarget(ctx, input, 'delete');
    case 'get_events': {
      const parsed = RangeInput.safeParse(input);
      if (!parsed.success) return null;
      const days = [
        ...daysOfArgument(parsed.data.start_date, timezone),
        ...daysOfArgument(parsed.data.end_date, timezone),
      ].sort();
      if (days.length === 0) return null;
      return rangeTarget(
        days[0]!,
        days.at(-1)!,
        (named) => `get_events with start_date "${named}" and end_date "${named}"`,
      );
    }
    case 'get_free_slots':
    case 'render_day_image': {
      const parsed = DayInput.safeParse(input);
      if (!parsed.success) return null;
      const days = daysOfArgument(parsed.data.date, timezone).sort();
      if (days.length === 0) return null;
      return {
        what: `This call is for ${describeDay(days[0]!)}`,
        first: days[0]!,
        last: days.at(-1)!,
        redo: (named) => `${toolName} with date "${named}"`,
      };
    }
    case 'render_week_image': {
      // The picture is the Monday–Sunday week that contains week_start.
      const parsed = WeekInput.safeParse(input);
      const day = parsed.success ? /^\d{4}-\d{2}-\d{2}$/.exec(parsed.data.week_start)?.[0] : undefined;
      if (!day) return null;
      const monday = shiftDay(day, -weekdayOf(day));
      return rangeTarget(monday, shiftDay(monday, 6), (named) => `render_week_image with week_start "${named}"`);
    }
    case 'render_month_image': {
      const parsed = MonthInput.safeParse(input);
      const match = parsed.success ? /^(\d{4})-(\d{2})/.exec(parsed.data.month) : null;
      if (!match) return null;
      const [year, month] = [Number(match[1]), Number(match[2])];
      const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      return rangeTarget(
        `${match[1]}-${match[2]}-01`,
        last,
        (named) => `render_month_image with month "${named.slice(0, 7)}"`,
      );
    }
    default:
      return null;
  }
}

/**
 * Rejects a date-bearing call whose day the user did not name in this turn. Returns
 * undefined when the call may run (no named days, a tool without a date, or a match).
 */
export function checkDayReferences(ctx: AgentContext, toolName: string, input: unknown): ToolResult | undefined {
  const named = ctx.dayReferences;
  if (!named) return undefined;
  if (named.timeOnly && (toolName !== 'create_event' || ctx.isGroup)) return undefined;
  const target = targetOf(ctx, toolName, input);
  if (!target) return undefined;
  for (const day of named.allowedDates) if (day >= target.first && day <= target.last) return undefined;
  // A named set always holds at least one reference with at least one date.
  const suggested = named.references[0]!.dates[0]!;
  return {
    success: false,
    mutationState: 'not_applied',
    error:
      `WRONG_DAY: nothing was done. The user named ${describeReferences(named)}. ` +
      `${target.what}, which the user did not name. ` +
      `Redo it for the day the user named, e.g. ${target.redo(suggested)}. ` +
      'If the user really meant another day, ask them instead of guessing.',
  };
}

const AskUserInput = z.object({ question: z.string(), options: z.array(z.string()).optional() });

/**
 * Rejects an ask_user question that pairs a weekday with a date on another weekday
 * ("Понедельник 27 сентября" when the 27th is a Sunday) before it reaches the user, who
 * would approve it on the strength of the weekday name.
 */
export function checkQuestionWeekdays(ctx: AgentContext, toolName: string, input: unknown): ToolResult | undefined {
  if (toolName !== 'ask_user') return undefined;
  const parsed = AskUserInput.safeParse(input);
  if (!parsed.success) return undefined;
  // Each button is its own line of text: a weekday option above a date option is no pair.
  const mismatches = [parsed.data.question, ...(parsed.data.options ?? [])].flatMap((part) =>
    findWeekdayDateMismatches(part, new Date(), ctx.user.timezone),
  );
  if (mismatches.length === 0) return undefined;
  return {
    success: false,
    mutationState: 'not_applied',
    error:
      `WEEKDAY_DATE_MISMATCH: the question was not sent. ${describeWeekdayDateMismatches(mismatches)}. ` +
      'Use the date of the day the user named, make every weekday match its date, then call ask_user again.',
  };
}

/**
 * What the user reads instead of a reply whose weekdays still contradict its dates after
 * the corrective round: the real weekdays, and a request to name the day.
 */
export function weekdayMismatchNotice(language: string, mismatches: readonly WeekdayDateMismatch[]): string {
  const lang = toLang(language);
  const messages = t(lang).weekdayDateMismatch;
  return messages.notice(
    mismatches.map(({ date, nearest }) => {
      const written = describeCalendarDay(date, lang);
      const named = describeCalendarDay(nearest, lang);
      return messages.fact(written.day, written.weekday, named.weekday, named.day);
    }),
  );
}
