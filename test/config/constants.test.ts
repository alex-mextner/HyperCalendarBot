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

  test('matches the primary subtag of an IETF tag', () => {
    expect(toLang('ru-RU')).toBe('ru');
    expect(toLang('en-US')).toBe('en');
    expect(toLang('ru-BY')).toBe('ru');
  });

  test('is case-insensitive on the primary subtag', () => {
    expect(toLang('RU')).toBe('ru');
    expect(toLang('EN-GB')).toBe('en');
  });

  test('defaults to "en" for an unknown IETF tag', () => {
    expect(toLang('de-DE')).toBe('en');
  });
});
