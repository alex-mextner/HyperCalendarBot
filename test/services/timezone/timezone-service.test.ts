import { describe, test, expect } from 'bun:test';
import { resolveTimezone, getTimezoneDisplay } from '../../../src/services/timezone/timezone-service.ts';

describe('resolveTimezone', () => {
  test('resolves Moscow coordinates to Europe/Moscow', () => {
    const tz = resolveTimezone(55.7558, 37.6173);
    expect(tz).toBe('Europe/Moscow');
  });
  test('resolves New York coordinates', () => {
    const tz = resolveTimezone(40.7128, -74.006);
    expect(tz).toBe('America/New_York');
  });
});

describe('getTimezoneDisplay', () => {
  test('returns timezone with offset', () => {
    const display = getTimezoneDisplay('Europe/Moscow');
    expect(display).toContain('Europe/Moscow');
    expect(display).toContain('UTC');
  });
});
