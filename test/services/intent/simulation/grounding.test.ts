// A simulated reply is grounded when every date and time it states comes from a tool result of
// the same run, read in the case's own zone, from the calendar after the run, or from the clock.
import { expect, test } from 'bun:test';
import { checkGrounding } from '../../../../src/services/intent/simulation/grounding.ts';

const zone = 'Europe/Berlin';
const now = '2026-09-10T07:00:00.000Z';

test('a time converted from a UTC tool result into the case zone is grounded', () => {
  const result = checkGrounding('11:00–12:00 Planning sync', {
    toolTexts: ['id: 1, title: Planning sync, start: 2026-09-10T09:00:00Z, end: 2026-09-10T10:00:00Z'],
    instants: [],
    timezone: zone,
    now,
  });
  expect(result).toEqual({ grounded: true, ungrounded: [] });
});

test('a time no tool reported is not grounded', () => {
  const result = checkGrounding('Planning sync at 15:30', {
    toolTexts: ['start: 2026-09-10T09:00:00Z'],
    instants: [],
    timezone: zone,
    now,
  });
  expect(result).toEqual({ grounded: false, ungrounded: ['15:30'] });
});

test('dates in several shapes are grounded by the same instant', () => {
  const result = checkGrounding('Created on 2026-09-11 (11.09) at 9:05', {
    toolTexts: [],
    instants: ['2026-09-11T07:05:00.000Z'],
    timezone: zone,
    now,
  });
  expect(result).toEqual({ grounded: true, ungrounded: [] });
});

test('the current time of the case is grounded', () => {
  expect(checkGrounding('Now it is 09:00', { toolTexts: [], instants: [], timezone: zone, now }).grounded).toBe(true);
});

test('local wall-clock values a tool printed verbatim are grounded', () => {
  const result = checkGrounding('Free from 14:00', {
    toolTexts: ['Free slots on 2026-09-10: 14:00-18:00'],
    instants: [],
    timezone: zone,
    now,
  });
  expect(result.grounded).toBe(true);
});

test('a decimal amount or version is not read as a date', () => {
  const result = checkGrounding('Напомню через 1.5 часа, версия 3.12', {
    toolTexts: [],
    instants: [],
    timezone: zone,
    now,
  });
  expect(result).toEqual({ grounded: true, ungrounded: [] });
});
