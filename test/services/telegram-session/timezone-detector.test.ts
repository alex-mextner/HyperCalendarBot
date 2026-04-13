// test/services/telegram-session/timezone-detector.test.ts
import { describe, expect, test } from 'bun:test';
import type { Authorization } from '../../../src/services/telegram-session/session-bridge.ts';
import {
  detectTimezoneFromAuthorizations,
  getLoadedCountryCount,
} from '../../../src/services/telegram-session/timezone-detector.ts';

function makeAuth(overrides: Partial<Authorization>): Authorization {
  return {
    hash: 1,
    device_model: 'iPhone 14',
    platform: 'iOS',
    system_version: '17.0',
    app_name: 'Telegram',
    country: 'US',
    region: 'California',
    ip: '1.2.3.4',
    date_active: Math.floor(Date.now() / 1000),
    current: false,
    ...overrides,
  };
}

describe('detectTimezoneFromAuthorizations', () => {
  test('single-tz country resolves by country code (JP → Asia/Tokyo)', () => {
    const auths: Authorization[] = [makeAuth({ country: 'JP', region: 'Tokyo', platform: 'iOS' })];
    const result = detectTimezoneFromAuthorizations(auths, 'UTC');
    expect(result).not.toBeNull();
    expect(result?.detectedTimezone).toBe('Asia/Tokyo');
    expect(result?.country).toBe('JP');
  });

  test('multi-tz country resolves by region (US/California → America/Los_Angeles)', () => {
    const auths: Authorization[] = [makeAuth({ country: 'US', region: 'California', platform: 'Android' })];
    const result = detectTimezoneFromAuthorizations(auths, 'UTC');
    expect(result).not.toBeNull();
    expect(result?.detectedTimezone).toBe('America/Los_Angeles');
  });

  test('returns null when detected equals current timezone', () => {
    const auths: Authorization[] = [makeAuth({ country: 'JP', region: 'Tokyo', platform: 'iOS' })];
    const result = detectTimezoneFromAuthorizations(auths, 'Asia/Tokyo');
    expect(result).toBeNull();
  });

  test('returns null for unknown country', () => {
    const auths: Authorization[] = [makeAuth({ country: 'ZZ', region: 'Nowhere', platform: 'iOS' })];
    const result = detectTimezoneFromAuthorizations(auths, 'UTC');
    expect(result).toBeNull();
  });

  test('picks most recent mobile session when multiple present', () => {
    const older = makeAuth({ country: 'DE', region: 'Berlin', platform: 'iOS', date_active: 1_000_000 });
    const newer = makeAuth({ country: 'FR', region: 'Paris', platform: 'Android', date_active: 2_000_000 });
    const result = detectTimezoneFromAuthorizations([older, newer], 'UTC');
    expect(result).not.toBeNull();
    expect(result?.detectedTimezone).toBe('Europe/Paris');
    expect(result?.country).toBe('FR');
  });

  test('ignores desktop sessions', () => {
    const auths: Authorization[] = [
      makeAuth({ country: 'JP', region: 'Tokyo', platform: 'Windows' }),
      makeAuth({ country: 'JP', region: 'Tokyo', platform: 'macOS' }),
    ];
    const result = detectTimezoneFromAuthorizations(auths, 'UTC');
    expect(result).toBeNull();
  });

  test('returns null when no mobile sessions', () => {
    const result = detectTimezoneFromAuthorizations([], 'UTC');
    expect(result).toBeNull();
  });

  test('RS resolves to Europe/Belgrade', () => {
    const auths: Authorization[] = [makeAuth({ country: 'RS', region: 'Belgrade', platform: 'iOS' })];
    const result = detectTimezoneFromAuthorizations(auths, 'UTC');
    expect(result).not.toBeNull();
    expect(result?.detectedTimezone).toBe('Europe/Belgrade');
  });

  test('RU/Moscow resolves to Europe/Moscow', () => {
    const auths: Authorization[] = [makeAuth({ country: 'RU', region: 'Moscow', platform: 'Android' })];
    const result = detectTimezoneFromAuthorizations(auths, 'UTC');
    expect(result).not.toBeNull();
    expect(result?.detectedTimezone).toBe('Europe/Moscow');
  });

  test('US/New York resolves to America/New_York', () => {
    const auths: Authorization[] = [makeAuth({ country: 'US', region: 'New York', platform: 'iOS' })];
    const result = detectTimezoneFromAuthorizations(auths, 'UTC');
    expect(result).not.toBeNull();
    expect(result?.detectedTimezone).toBe('America/New_York');
  });

  test('multi-tz country with unknown region falls back to country default', () => {
    const auths: Authorization[] = [makeAuth({ country: 'US', region: 'UnknownRegion', platform: 'iOS' })];
    const result = detectTimezoneFromAuthorizations(auths, 'UTC');
    expect(result).not.toBeNull();
    expect(result?.detectedTimezone).toBe('America/New_York');
  });

  test('zone.tab loaded with 200+ countries', () => {
    expect(getLoadedCountryCount()).toBeGreaterThan(200);
  });
});
