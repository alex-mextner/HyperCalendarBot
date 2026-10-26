import { describe, expect, test } from 'bun:test';
import { planMove } from '../../../src/services/intent/move-plan.ts';
import { WorkflowInputError } from '../../../src/services/intent/workflow-input.ts';

// Saturday 2026-09-19 10:00 in Belgrade (UTC+2); the clocks go back on 2026-10-25 and forward on 2027-03-28.
const context = { now: new Date('2026-09-19T08:00:00Z'), timezone: 'Europe/Belgrade', language: 'ru' };
const event = { date: '2026-09-21', time: '10:00', end_at: '2026-09-21T08:30:00.000Z', day: '', at: '' };

describe('planMove', () => {
  test('a day alone keeps the local time and the length of the event', () => {
    expect(planMove({ ...event, day: '2026-09-25' }, context)).toEqual({
      has_end: true,
      start: '2026-09-25T10:00:00+02:00',
      end: '2026-09-25T10:30:00+02:00',
      when_text: 'пт 25 сентября в 10:00',
    });
  });

  test('a time alone keeps the local day, and an event without an end gets none', () => {
    const plan = planMove({ ...event, end_at: '', at: '15:30' }, context);
    expect(plan).toMatchObject({ has_end: false, start: '2026-09-21T15:30:00+02:00' });
    expect(plan).not.toHaveProperty('end');
  });

  test('the length is kept across a clock change, so the wall end moves with the offset', () => {
    // 10:00–11:00 local on the last summer-time day, moved to the first winter-time day.
    const plan = planMove(
      { date: '2026-10-24', time: '10:00', end_at: '2026-10-24T09:00:00.000Z', day: '2026-10-26', at: '' },
      context,
    );
    expect(plan).toMatchObject({ start: '2026-10-26T10:00:00+01:00', end: '2026-10-26T11:00:00+01:00' });
  });

  test.each([
    ['no new day or time', { ...event }],
    ['the same moment', { ...event, day: '2026-09-21' }],
    ['a start in the past', { ...event, day: '2026-09-18' }],
    ['an all-day event', { ...event, time: '', at: '15:00' }],
    ['a time that does not exist', { ...event, day: '2027-03-28', at: '02:30' }],
    ['a time that happens twice', { ...event, day: '2026-10-25', at: '02:30' }],
    ['an end before the start', { ...event, end_at: '2026-09-21T07:00:00.000Z', day: '2026-09-25' }],
    ['garbage', { ...event, day: 'friday' }],
  ])('refuses %s', (_name, input) => {
    expect(() => planMove(input, context)).toThrow(WorkflowInputError);
  });
});
