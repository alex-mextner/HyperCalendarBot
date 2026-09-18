import { z } from 'zod';

// Keep existing date-only/all-day storage and explicit-offset instants. Local
// datetime prose is not an instant: never let Date silently guess its meaning.
const isoEventTime = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const TIMESTAMP_CONTRACT =
  'Expected a real ISO date (YYYY-MM-DD) or datetime with Z/offset, e.g. 2030-01-01T12:00:00+02:00. ' +
  'Resolve timezone arithmetic first; do not pass prose or an offset-free datetime.';

export const eventTimestampSchema = z
  .string()
  .refine((value) => isoEventTime.safeParse(value).success && Number.isFinite(Date.parse(value)), {
    message: TIMESTAMP_CONTRACT,
  });

interface EventTimestampFields {
  start_at?: string;
  end_at?: string | null;
  recurrence_end_at?: string | null;
}

/** Validates only supplied fields; null removes optional end bounds. */
export function eventTimestampError(input: EventTimestampFields): string | null {
  for (const field of ['start_at', 'end_at', 'recurrence_end_at'] as const) {
    const value = input[field];
    if (value === undefined || (value === null && field !== 'start_at')) continue;
    if (!eventTimestampSchema.safeParse(value).success) {
      return `INVALID_EVENT_DATETIME: ${field}. ${TIMESTAMP_CONTRACT}`;
    }
  }
  return null;
}

/** Storage barrier: fail before SQL, including callers outside the AI executor. */
export function assertValidEventTimestamps(input: EventTimestampFields): void {
  const error = eventTimestampError(input);
  if (error) throw new RangeError(error);
}
