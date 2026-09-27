import { z } from 'zod';
import type { ChatHistoryMessage } from '../../database/types.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { type DayReferenceSet, describeDay, describeReferences, localDayOf, readDayContent } from './day-references.ts';
import type { AgentContext, ToolResult } from './types.ts';

/**
 * Pre-dispatch guard: a date-bearing tool call must target a day the user named in this
 * turn. When the user said "в среду" the model may only create, move, delete or read on
 * that Wednesday; a call for any other day is rejected before anything is written, with
 * an error that names the right date so the model can redo it.
 *
 * Incidents (user 716928723, Europe/Belgrade): on Friday 2026-09-25 "понедельник …
 * среда …" was created on Sunday 27 and Tuesday 29; on Sunday 2026-09-27 "Планы на
 * среду" read Monday 28, and "Во вторник отмени весь английский" deleted the Tuesdays
 * 1 and 8 September besides the misplaced lessons on the 29th.
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

/**
 * The ask_user question the current message answers, with the user message that led to
 * it — or null when the turn before this message did not end in ask_user.
 */
function pendingQuestion(history: ChatHistoryMessage[]): { origin: string; question: string } | null {
  let index = history.length - 1;
  // The current message is the newest user row; bot edits of the question may follow it.
  while (index >= 0 && history[index]!.role !== 'user') index--;
  index--;
  let question: string | null = null;
  for (; index >= 0; index--) {
    const row = history[index]!;
    if (row.role === 'tool') continue;
    if (row.role === 'user') {
      if (question === null || ActivityCodec.safeParse(row.content).success) return null;
      return { origin: row.content, question };
    }
    if (ActivityCodec.safeParse(row.content).success) continue;
    const turn = AssistantToolCallsCodec.safeParse(row.content);
    if (!turn.success) return null;
    const ask = turn.data.tool_calls?.find((call) => call.function.name === 'ask_user');
    if (question === null) {
      if (!ask) return null;
      const args = AskUserArgsCodec.safeParse(ask.function.arguments);
      question = args.success ? [args.data.question ?? '', ...(args.data.options ?? [])].join('\n') : '';
    }
  }
  return null;
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
  const pending = pendingQuestion(history);
  if (!pending) return null;
  const origin = readDayContent(pending.origin, now, timezone);
  if (origin.kind !== 'named') return null;
  const offered = readDayContent(pending.question, now, timezone);
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

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

/** Local days a date argument can mean: its written date and, for an instant, its local date. */
function daysOfArgument(value: string, timezone: string): string[] {
  const written = DATE_PREFIX.exec(value)?.[1];
  const local = value.includes('T') ? localDayOf(value, timezone) : null;
  return [written, local].filter((day): day is string => typeof day === 'string');
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
  const day = localDayOf(startAt, timezone);
  if (!day) return null;
  const clock = localClock(startAt, timezone);
  return {
    what: `${what} (${describeDay(day)} ${clock} local)`,
    first: day,
    last: day,
    redo: (named) => `start_at from calculate("${named} ${clock} ${timezone} to UTC")`,
  };
}

function targetOf(ctx: AgentContext, toolName: string, input: unknown): Target | null {
  const timezone = ctx.user.timezone;
  switch (toolName) {
    case 'create_event':
    case 'update_event': {
      const parsed = StartInput.safeParse(input);
      if (!parsed.success || parsed.data.start_at === undefined) return null;
      return startTarget(
        toolName === 'create_event' ? 'This event starts' : 'The new start',
        parsed.data.start_at,
        timezone,
      );
    }
    case 'delete_event': {
      const parsed = EventRefInput.safeParse(input);
      if (!parsed.success) return null;
      const { event_id: eventId, owner_id: ownerId, scope } = parsed.data;
      // Someone else's calendar is checked for access by the handler; never reveal its dates here.
      if (ownerId !== undefined && ownerId !== ctx.user.telegram_id) return null;
      const event =
        scope === 'group' && ctx.groupChatId !== undefined
          ? ctx.eventService.getEventForGroup(eventId, ctx.groupChatId)
          : ctx.eventService.getEvent(eventId, ctx.user.telegram_id);
      // A series spans many days; deleting it is not a single-day action.
      if (!event || event.recurrence_rule) return null;
      const day = localDayOf(event.start_at, timezone);
      if (!day) return null;
      return {
        what: `Event ${eventId} «${event.title}» is on ${describeDay(day)}`,
        first: day,
        last: day,
        redo: (named) => `delete only events that fall on ${named}`,
      };
    }
    case 'get_events': {
      const parsed = RangeInput.safeParse(input);
      if (!parsed.success) return null;
      const days = [
        ...daysOfArgument(parsed.data.start_date, timezone),
        ...daysOfArgument(parsed.data.end_date, timezone),
      ].sort();
      if (days.length === 0) return null;
      return {
        what: `This call reads ${days[0]}..${days.at(-1)}`,
        first: days[0]!,
        last: days.at(-1)!,
        redo: (named) => `get_events with start_date "${named}" and end_date "${named}"`,
      };
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
  const target = targetOf(ctx, toolName, input);
  if (!target) return undefined;
  for (const day of named.allowedDates) if (day >= target.first && day <= target.last) return undefined;
  const suggested = named.references[0]?.dates[0] ?? [...named.allowedDates].sort()[0]!;
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
