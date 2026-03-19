import { describe, expect, test } from 'bun:test';
import {
  getUserLocalTime,
  isLocalTimeInWindow,
  isQuietHours,
  isTimeMatch,
  localTimeToUtcHHMM,
} from '../../../src/services/notification/timezone.ts';

describe('timezone utilities', () => {
  describe('getUserLocalTime', () => {
    test('converts UTC to Moscow time (+3)', () => {
      const utc = new Date('2026-03-15T05:30:00Z');
      const local = getUserLocalTime(utc, 'Europe/Moscow');
      expect(local.hours).toBe(8);
      expect(local.minutes).toBe(30);
    });

    test('converts UTC to NY time (-4 in DST)', () => {
      const utc = new Date('2026-07-15T14:00:00Z');
      const local = getUserLocalTime(utc, 'America/New_York');
      expect(local.hours).toBe(10);
      expect(local.minutes).toBe(0);
    });
  });

  describe('isTimeMatch', () => {
    test('matches when local time equals target', () => {
      const utc = new Date('2026-03-15T05:00:00Z');
      expect(isTimeMatch(utc, 'Europe/Moscow', '08:00')).toBe(true);
    });

    test('does not match different time', () => {
      const utc = new Date('2026-03-15T05:00:00Z');
      expect(isTimeMatch(utc, 'Europe/Moscow', '09:00')).toBe(false);
    });
  });

  describe('localTimeToUtcHHMM', () => {
    test('converts Moscow 08:00 to UTC 05:00', () => {
      expect(localTimeToUtcHHMM('08:00', 'Europe/Moscow')).toBe('05:00');
    });

    test('handles UTC+0 timezone', () => {
      expect(localTimeToUtcHHMM('08:00', 'UTC')).toBe('08:00');
    });

    test('handles wrap-around past midnight', () => {
      expect(localTimeToUtcHHMM('02:00', 'Asia/Tokyo')).toBe('17:00');
    });

    test('round-trips correctly for DST-affected timezone (Europe/Belgrade)', () => {
      const localHHMM = '09:00';
      const utcHHMM = localTimeToUtcHHMM(localHHMM, 'Europe/Belgrade');

      // Reconstruct what UTC time the function produced and verify round-trip
      const [utcH, utcM] = utcHHMM.split(':').map(Number);
      const utcDate = new Date();
      utcDate.setUTCHours(utcH!, utcM!, 0, 0);

      const result = isTimeMatch(utcDate, 'Europe/Belgrade', localHHMM);
      expect(result).toBe(true);
    });
  });

  describe('isLocalTimeInWindow', () => {
    test('exact match (diff=0) returns true', () => {
      // UTC=08:00, timezone=UTC, target=08:00 → diff=0, window=5 → true
      const utc = new Date('2026-03-15T08:00:00Z');
      expect(isLocalTimeInWindow(utc, 'UTC', '08:00', 5)).toBe(true);
    });

    test('3 minutes late (diff=3) within window=5 returns true', () => {
      const utc = new Date('2026-03-15T08:03:00Z');
      expect(isLocalTimeInWindow(utc, 'UTC', '08:00', 5)).toBe(true);
    });

    test('5 minutes late (diff=5) equals window boundary, returns false', () => {
      const utc = new Date('2026-03-15T08:05:00Z');
      expect(isLocalTimeInWindow(utc, 'UTC', '08:00', 5)).toBe(false);
    });

    test('midnight wrap: target=23:59, local=00:01, diff=2, window=5 → true', () => {
      // UTC 00:01, timezone=UTC, target=23:59 → diff=(1-1439+1440)%1440=2 < 5
      const utc = new Date('2026-03-15T00:01:00Z');
      expect(isLocalTimeInWindow(utc, 'UTC', '23:59', 5)).toBe(true);
    });

    test('early tick (diff=1439) returns false', () => {
      // UTC 07:59, timezone=UTC, target=08:00 → diff=(479-480+1440)%1440=1439
      const utc = new Date('2026-03-15T07:59:00Z');
      expect(isLocalTimeInWindow(utc, 'UTC', '08:00', 5)).toBe(false);
    });
  });

  describe('isQuietHours', () => {
    test('returns false when quiet hours disabled', () => {
      const result = isQuietHours({ enabled: false, start: null, end: null }, new Date('2026-03-15T02:00:00Z'), 'UTC');
      expect(result).toBe(false);
    });

    test('detects quiet hours same-day range', () => {
      const result = isQuietHours(
        { enabled: true, start: '13:00', end: '15:00' },
        new Date('2026-03-15T14:00:00Z'),
        'UTC',
      );
      expect(result).toBe(true);
    });

    test('detects quiet hours midnight-spanning range', () => {
      const result = isQuietHours(
        { enabled: true, start: '23:00', end: '07:00' },
        new Date('2026-03-15T02:00:00Z'),
        'UTC',
      );
      expect(result).toBe(true);
    });

    test('returns false outside quiet hours', () => {
      const result = isQuietHours(
        { enabled: true, start: '23:00', end: '07:00' },
        new Date('2026-03-15T12:00:00Z'),
        'UTC',
      );
      expect(result).toBe(false);
    });
  });
});
