import { describe, expect, test } from 'bun:test';
import {
  getUserLocalTime,
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
