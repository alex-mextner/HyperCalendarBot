import { describe, expect, test } from 'bun:test';
import { actionLogCutoff } from '../../src/bootstrap/bot-tasks.ts';

describe('actionLogCutoff', () => {
  test('is 90 days before now, in the SQLite timestamp format the action log stores', () => {
    const now = Date.UTC(2026, 9, 26, 12, 30, 45);
    expect(actionLogCutoff(now)).toBe('2026-07-28 12:30:45');
  });
});
