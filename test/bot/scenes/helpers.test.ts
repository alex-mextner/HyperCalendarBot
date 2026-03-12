import { describe, expect, test } from 'bun:test';
import { isCommandEscape } from '../../../src/bot/scenes/helpers.ts';

describe('isCommandEscape', () => {
  test('returns true for /cancel', () => {
    expect(isCommandEscape('/cancel')).toBe(true);
  });

  test('returns true for /cancel with extra text', () => {
    expect(isCommandEscape('/cancel something')).toBe(true);
  });

  test('returns true for other commands', () => {
    expect(isCommandEscape('/help')).toBe(true);
    expect(isCommandEscape('/add')).toBe(true);
  });

  test('returns false for regular text', () => {
    expect(isCommandEscape('hello')).toBe(false);
    expect(isCommandEscape('meeting tomorrow')).toBe(false);
  });

  test('returns false for empty/undefined', () => {
    expect(isCommandEscape(undefined)).toBe(false);
    expect(isCommandEscape('')).toBe(false);
  });
});
