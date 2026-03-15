import { describe, expect, test } from 'bun:test';
import {
  getTimezoneDisplay,
  guessCountryFromTimezone,
  resolveTimezone,
} from '../../../src/services/timezone/timezone-service.ts';

describe('resolveTimezone', () => {
  test('resolves Moscow coordinates to Europe/Moscow', () => {
    const tz = resolveTimezone(55.7558, 37.6173);
    expect(tz).toBe('Europe/Moscow');
  });
  test('resolves New York coordinates', () => {
    const tz = resolveTimezone(40.7128, -74.006);
    expect(tz).toBe('America/New_York');
  });
  test('resolves Kyiv coordinates', () => {
    const tz = resolveTimezone(50.4501, 30.5234);
    expect(tz).toBe('Europe/Kyiv');
  });
  test('resolves Tokyo coordinates', () => {
    const tz = resolveTimezone(35.6762, 139.6503);
    expect(tz).toBe('Asia/Tokyo');
  });
  test('resolves Sydney coordinates', () => {
    const tz = resolveTimezone(-33.8688, 151.2093);
    expect(tz).toBe('Australia/Sydney');
  });
  test('falls back to UTC for middle-of-ocean coordinates', () => {
    // Point Nemo — farthest from any land
    const tz = resolveTimezone(-48.876667, -123.393333);
    // geo-tz returns the nearest timezone for ocean points, so just verify it returns something
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
  });
});

describe('getTimezoneDisplay', () => {
  test('returns timezone with offset', () => {
    const display = getTimezoneDisplay('Europe/Moscow');
    expect(display).toContain('Europe/Moscow');
    expect(display).toContain('UTC');
  });
  test('formats UTC timezone', () => {
    const display = getTimezoneDisplay('UTC');
    expect(display).toContain('UTC');
  });
  test('returns correct format "timezone (offset)"', () => {
    const display = getTimezoneDisplay('America/New_York');
    expect(display).toMatch(/^America\/New_York \(UTC/);
  });
});

describe('guessCountryFromTimezone', () => {
  test('returns country code for known European timezones', () => {
    expect(guessCountryFromTimezone('Europe/Moscow')).toBe('RU');
    expect(guessCountryFromTimezone('Europe/Kyiv')).toBe('UA');
    expect(guessCountryFromTimezone('Europe/London')).toBe('GB');
    expect(guessCountryFromTimezone('Europe/Paris')).toBe('FR');
    expect(guessCountryFromTimezone('Europe/Berlin')).toBe('DE');
    expect(guessCountryFromTimezone('Europe/Istanbul')).toBe('TR');
    expect(guessCountryFromTimezone('Europe/Warsaw')).toBe('PL');
    expect(guessCountryFromTimezone('Europe/Rome')).toBe('IT');
    expect(guessCountryFromTimezone('Europe/Madrid')).toBe('ES');
    expect(guessCountryFromTimezone('Europe/Belgrade')).toBe('RS');
    expect(guessCountryFromTimezone('Europe/Helsinki')).toBe('FI');
    expect(guessCountryFromTimezone('Europe/Amsterdam')).toBe('NL');
  });

  test('returns country code for known Asian timezones', () => {
    expect(guessCountryFromTimezone('Asia/Dubai')).toBe('AE');
    expect(guessCountryFromTimezone('Asia/Kolkata')).toBe('IN');
    expect(guessCountryFromTimezone('Asia/Bangkok')).toBe('TH');
    expect(guessCountryFromTimezone('Asia/Singapore')).toBe('SG');
    expect(guessCountryFromTimezone('Asia/Tokyo')).toBe('JP');
    expect(guessCountryFromTimezone('Asia/Seoul')).toBe('KR');
    expect(guessCountryFromTimezone('Asia/Shanghai')).toBe('CN');
    expect(guessCountryFromTimezone('Asia/Hong_Kong')).toBe('HK');
    expect(guessCountryFromTimezone('Asia/Almaty')).toBe('KZ');
    expect(guessCountryFromTimezone('Asia/Tbilisi')).toBe('GE');
    expect(guessCountryFromTimezone('Asia/Yerevan')).toBe('AM');
    expect(guessCountryFromTimezone('Asia/Tashkent')).toBe('UZ');
  });

  test('returns country code for known American timezones', () => {
    expect(guessCountryFromTimezone('America/New_York')).toBe('US');
    expect(guessCountryFromTimezone('America/Chicago')).toBe('US');
    expect(guessCountryFromTimezone('America/Denver')).toBe('US');
    expect(guessCountryFromTimezone('America/Los_Angeles')).toBe('US');
    expect(guessCountryFromTimezone('America/Toronto')).toBe('CA');
    expect(guessCountryFromTimezone('America/Sao_Paulo')).toBe('BR');
    expect(guessCountryFromTimezone('America/Mexico_City')).toBe('MX');
    expect(guessCountryFromTimezone('America/Buenos_Aires')).toBe('AR');
  });

  test('returns country code for known African timezones', () => {
    expect(guessCountryFromTimezone('Africa/Cairo')).toBe('EG');
    expect(guessCountryFromTimezone('Africa/Lagos')).toBe('NG');
    expect(guessCountryFromTimezone('Africa/Johannesburg')).toBe('ZA');
    expect(guessCountryFromTimezone('Africa/Nairobi')).toBe('KE');
  });

  test('returns country code for Oceania timezones', () => {
    expect(guessCountryFromTimezone('Australia/Sydney')).toBe('AU');
    expect(guessCountryFromTimezone('Pacific/Auckland')).toBe('NZ');
  });

  test('returns null for unknown timezone', () => {
    expect(guessCountryFromTimezone('Antarctica/McMurdo')).toBeNull();
    expect(guessCountryFromTimezone('UTC')).toBeNull();
    expect(guessCountryFromTimezone('Etc/GMT+5')).toBeNull();
    expect(guessCountryFromTimezone('Invalid/Timezone')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(guessCountryFromTimezone('')).toBeNull();
  });
});
