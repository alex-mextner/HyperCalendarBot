import { describe, expect, test } from 'bun:test';
import { computeEventTime, EventTimeInputSchema } from '../../../src/services/intent/event-time.ts';
import { WorkflowInputError } from '../../../src/services/intent/workflow-input.ts';

const TZ = 'Europe/Belgrade';
const NOW = new Date('2026-09-19T08:00:00Z');
const event = (date: string, time: string, end_at?: string) => ({
  date,
  time,
  all_day: false,
  ...(end_at ? { end_at } : {}),
});
const run = (input: unknown, now = NOW) => computeEventTime(EventTimeInputSchema.parse(input), TZ, now);
const rejects = (input: unknown, now = NOW) => {
  expect(() => run(input, now)).toThrow(WorkflowInputError);
};

describe('computeEventTime', () => {
  test('a day move keeps 10:00 across the clock change and keeps the elapsed duration', () => {
    const moved = run(
      { event: event('2026-10-24', '10:00', '2026-10-24T08:45:00Z'), day: '2026-10-25', at: '' },
      new Date('2026-10-24T05:00:00Z'),
    );
    expect(moved.start_at).toBe('2026-10-25T10:00:00+01:00');
    expect(moved.end_at).toBe('2026-10-25T10:45:00+01:00');
    expect(moved.minutes).toBe(45);
  });

  test('a new clock time on the same day; an event without an end keeps having none', () => {
    const moved = run({ event: event('2026-10-05', '10:00'), at: '15:30' });
    expect(moved.start_at).toBe('2026-10-05T15:30:00+02:00');
    expect(moved.end_at).toBeNull();
    expect(moved.minutes).toBeNull();
  });

  test('earlier and later shift start and end by elapsed minutes', () => {
    const later = run({
      event: event('2026-10-05', '09:00', '2026-10-05T07:30:00Z'),
      shift: { minutes: 60, direction: 'later' },
    });
    expect([later.time, later.end_time]).toEqual(['10:00', '10:30']);
    const earlier = run({ event: event('2026-10-05', '09:00'), shift: { minutes: 30, direction: 'earlier' } });
    expect(earlier.time).toBe('08:30');
  });

  test('resizing moves only the end; a missing end uses and reports the default duration', () => {
    const longer = run({
      event: event('2026-10-05', '10:00', '2026-10-05T08:30:00Z'),
      resize: { minutes: 30, direction: 'longer' },
    });
    expect([longer.time, longer.end_time, longer.minutes, longer.assumed_default]).toEqual([
      '10:00',
      '11:00',
      60,
      false,
    ]);
    const open = run({
      event: event('2026-10-05', '10:00'),
      resize: { minutes: 30, direction: 'longer' },
      default_minutes: 60,
    });
    expect([open.end_time, open.minutes, open.assumed_default, open.default_minutes]).toEqual(['11:30', 90, true, 60]);
  });

  test('refuses instead of guessing', () => {
    // no end and no default duration
    rejects({ event: event('2026-10-05', '10:00'), resize: { minutes: 30, direction: 'longer' } });
    // shortening to zero or below
    rejects({
      event: event('2026-10-05', '10:00', '2026-10-05T08:30:00Z'),
      resize: { minutes: 30, direction: 'shorter' },
    });
    // a skipped wall-clock time and a repeated one
    rejects({ event: event('2027-03-27', '02:30'), day: '2027-03-28' }, new Date('2027-03-20T00:00:00Z'));
    rejects({ event: event('2026-10-24', '02:30'), day: '2026-10-25' }, new Date('2026-10-20T00:00:00Z'));
    // landing in the past
    rejects({ event: event('2026-09-19', '11:00'), shift: { minutes: 180, direction: 'earlier' } });
    // an all-day event
    rejects({ event: { date: '2026-10-05', all_day: true }, day: '2026-10-06' });
  });

  test('the input schema allows exactly one bounded operation', () => {
    const base = { event: event('2026-10-05', '10:00') };
    expect(EventTimeInputSchema.safeParse({ ...base }).success).toBe(false);
    expect(
      EventTimeInputSchema.safeParse({ ...base, day: '2026-10-06', shift: { minutes: 5, direction: 'later' } }).success,
    ).toBe(false);
    expect(EventTimeInputSchema.safeParse({ ...base, shift: { minutes: 0, direction: 'later' } }).success).toBe(false);
    expect(EventTimeInputSchema.safeParse({ ...base, shift: { minutes: 10081, direction: 'later' } }).success).toBe(
      false,
    );
    expect(EventTimeInputSchema.safeParse({ ...base, shift: { minutes: -5, direction: 'later' } }).success).toBe(false);
    expect(EventTimeInputSchema.safeParse({ ...base, day: '2026-10-06', extra: 1 }).success).toBe(false);
  });
});
