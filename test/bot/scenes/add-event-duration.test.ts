import { expect, test } from 'bun:test';
import { addMinutes } from 'date-fns';
import { applyDefaultDuration } from '../../../src/bot/scenes/add-event.scene.ts';

test('applyDefaultDuration computes end from start + default', () => {
  const start = '2026-03-20T10:00:00.000Z';
  const result = applyDefaultDuration(start, 45);
  const expected = addMinutes(new Date(start), 45).toISOString();
  expect(result).toBe(expected);
});
