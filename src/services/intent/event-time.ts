import { z } from 'zod';
import { formatLocalInstant, localParts, uniqueInstant } from './wall-clock.ts';
import { WorkflowInputError } from './workflow-input.ts';

/**
 * Bounded arithmetic on an event that a workflow has already re-read with get_event. It
 * computes new times only; the workflow still confirms and writes through a real tool.
 *
 * - `day` / `at`: move to another day and/or clock time. The wall-clock time is kept, so
 *   "tomorrow" after a clock change is still 10:00, and the duration is kept in elapsed time.
 * - `shift`: move start and end by elapsed minutes ("an hour later").
 * - `resize`: change only the end ("30 minutes longer"). An event without an end
 *   is measured from the user's default duration, which the confirmation states explicitly.
 */

/** The workflow-only step name; the executor handles it and it never reaches the tool dispatcher. */
export const EVENT_TIME_STEP = 'event_time';

const Minutes = z.number().int().min(1).max(10080);
const HourMinute = /^([01]\d|2[0-3]):[0-5]\d$/;

export const EventTimeInputSchema = z
  .object({
    event: z
      .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        time: z.string().regex(HourMinute).optional(),
        all_day: z.boolean(),
        end_at: z.string().optional(),
      })
      .passthrough(),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    /** An empty clock time keeps the event's own time. */
    at: z.union([z.string().regex(HourMinute), z.literal('')]).optional(),
    shift: z
      .object({ minutes: Minutes, direction: z.enum(['earlier', 'later']) })
      .strict()
      .optional(),
    resize: z
      .object({ minutes: Minutes, direction: z.enum(['longer', 'shorter']) })
      .strict()
      .optional(),
    default_minutes: z.number().int().min(1).max(1440).optional(),
  })
  .strict()
  .refine(
    (input) =>
      [input.day !== undefined || input.at !== undefined, input.shift !== undefined, input.resize !== undefined].filter(
        Boolean,
      ).length === 1,
    'Exactly one operation',
  );
type EventTimeInput = z.infer<typeof EventTimeInputSchema>;

type EventTimeResult = {
  start_at: string;
  end_at: string | null;
  date: string;
  time: string;
  end_date: string | null;
  end_time: string | null;
  /** Resulting duration in minutes; null when the event keeps having no end. */
  minutes: number | null;
  /** True when a missing end was measured from the default duration. */
  assumed_default: boolean;
  /** The default duration that was assumed, so the confirmation can state it; null otherwise. */
  default_minutes: number | null;
};

const fail = (): never => {
  throw new WorkflowInputError('INVALID_INPUT');
};

function instantOf(date: string, time: string, timezone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return uniqueInstant({ y: y!, m: m!, d: d! }, hh!, mm!, timezone) ?? fail();
}

function newBounds(input: EventTimeInput, start: number, end: number | null, timezone: string) {
  if (input.shift !== undefined) {
    const delta = input.shift.minutes * 60_000 * (input.shift.direction === 'earlier' ? -1 : 1);
    return { start: start + delta, end: end === null ? null : end + delta, assumed: false };
  }
  if (input.resize !== undefined) {
    const base = end ?? (input.default_minutes === undefined ? fail() : start + input.default_minutes * 60_000);
    const resized = base + input.resize.minutes * 60_000 * (input.resize.direction === 'shorter' ? -1 : 1);
    return resized <= start ? fail() : { start, end: resized, assumed: end === null };
  }
  const moved = instantOf(input.day ?? input.event.date, input.at || input.event.time!, timezone);
  return { start: moved, end: end === null ? null : moved + (end - start), assumed: false };
}

export function computeEventTime(input: EventTimeInput, timezone: string, now: Date = new Date()): EventTimeResult {
  if (input.event.all_day || input.event.time === undefined) return fail();
  const start = instantOf(input.event.date, input.event.time, timezone);
  const endParsed = input.event.end_at === undefined ? null : Date.parse(input.event.end_at);
  if (endParsed !== null && (!Number.isFinite(endParsed) || endParsed < start)) return fail();
  const next = newBounds(input, start, endParsed, timezone);
  // A move must land in the future; a resize only needs its new end to still be ahead.
  if ((next.end ?? next.start) <= now.getTime() || (input.resize === undefined && next.start <= now.getTime()))
    return fail();
  const startLocal = localParts(next.start, timezone);
  const endLocal = next.end === null ? null : localParts(next.end, timezone);
  return {
    start_at: formatLocalInstant(next.start, timezone),
    end_at: next.end === null ? null : formatLocalInstant(next.end, timezone),
    date: startLocal.date,
    time: startLocal.time,
    end_date: endLocal?.date ?? null,
    end_time: endLocal?.time ?? null,
    minutes: next.end === null ? null : Math.round((next.end - next.start) / 60_000),
    assumed_default: next.assumed,
    default_minutes: next.assumed ? (input.default_minutes ?? null) : null,
  };
}
