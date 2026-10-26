// The new start (and end) of an event moved to another day and/or clock time. It is a workflow step of its own because
// the event's current day, time and end are only known after the event has been read, while the user's day/time words
// are bound before any tool runs. Like the bindings it works in the user's IANA zone and refuses anything ambiguous:
// a wall time skipped or repeated by a clock change, a start in the past, a move that changes nothing, an all-day event.
import { z } from 'zod';
import type { CalendarDay } from './date-time-words.ts';
import { fail } from './date-time-words.ts';
import { humanWhen } from './human-time.ts';
import { formatLocalInstant, uniqueInstant } from './workflow-bindings.ts';
import type { WorkflowInputValue } from './workflow-input.ts';

/** Every field is a string so an absent value is the empty string: "no new day", "no end", "all-day event". */
export const MovePlanInput = z
  .object({
    /** The event's current local day (YYYY-MM-DD) and clock time (HH:MM). */
    date: z.string(),
    time: z.string(),
    /** The event's current end as an instant, or ''. */
    end_at: z.string(),
    /** The day / clock time the user asked for, or ''; at least one is present. */
    day: z.string(),
    at: z.string(),
  })
  .strict();

export interface MovePlanContext {
  now: Date;
  timezone: string;
  language: string;
}

function dayOf(iso: string): CalendarDay {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : fail();
}

function clockOf(hhmm: string): [number, number] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return match ? [Number(match[1]), Number(match[2])] : fail();
}

/** An instant of the given local day and clock time, unique in the zone. */
function instantOf(day: string, clock: string, timezone: string): number {
  const [hour, minute] = clockOf(clock);
  return uniqueInstant(dayOf(day), hour, minute, timezone);
}

/**
 * The event keeps its local time when only a day is given and its local day when only a time is given. An event with an
 * end keeps its duration: the end moves by the same distance as the start.
 */
export function planMove(raw: unknown, context: MovePlanContext): { [key: string]: WorkflowInputValue } {
  const parsed = MovePlanInput.safeParse(raw);
  if (!parsed.success) return fail();
  const { date, time, end_at: endAt, day, at } = parsed.data;
  if (day === '' && at === '') return fail();
  const oldStart = instantOf(date, time, context.timezone);
  const newStart = instantOf(day === '' ? date : day, at === '' ? time : at, context.timezone);
  if (newStart <= context.now.getTime() || newStart === oldStart) return fail();
  const plan: { [key: string]: WorkflowInputValue } = { has_end: endAt !== '' };
  plan.start = formatLocalInstant(newStart, context.timezone);
  if (endAt !== '') {
    const oldEnd = Date.parse(endAt);
    if (!Number.isFinite(oldEnd) || oldEnd <= oldStart) return fail();
    plan.end = formatLocalInstant(newStart + (oldEnd - oldStart), context.timezone);
  }
  plan.when_text = humanWhen(plan.start, context);
  return plan;
}
