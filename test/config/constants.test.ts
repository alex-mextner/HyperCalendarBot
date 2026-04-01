import { describe, expect, test } from 'bun:test';
import { toLang } from '../../src/config/constants.ts';

describe('toLang', () => {
  test('returns "ru" for "ru"', () => {
    expect(toLang('ru')).toBe('ru');
  });

  test('returns "en" for "en"', () => {
    expect(toLang('en')).toBe('en');
  });

  test('defaults to "en" for null', () => {
    expect(toLang(null)).toBe('en');
  });

  test('defaults to "en" for undefined', () => {
    expect(toLang(undefined)).toBe('en');
  });

  test('defaults to "en" for unknown language', () => {
    expect(toLang('de')).toBe('en');
  });
});
