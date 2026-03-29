import { describe, expect, test } from 'bun:test';
import { detectClockChange, formatClockChangeNotice } from '../../../src/services/notification/clock-change.ts';

describe('detectClockChange', () => {
  test('returns null when no clock change (mid-summer)', () => {
    // July 15 — no DST transitions anywhere near this date
    const result = detectClockChange('Europe/Berlin', '2026-07-15');
    expect(result).toBeNull();
  });

  test('returns null for timezone without DST (Asia/Tokyo)', () => {
    // Japan doesn't observe DST
    const result = detectClockChange('Asia/Tokyo', '2026-03-29');
    expect(result).toBeNull();
  });

  test('returns null for UTC', () => {
    const result = detectClockChange('UTC', '2026-03-29');
    expect(result).toBeNull();
  });

  test('detects spring forward in Europe/Berlin (last Sunday of March)', () => {
    // In 2026, Europe switches to summer time on March 29
    // Clocks go forward 1 hour (CET → CEST, UTC+1 → UTC+2)
    const result = detectClockChange('Europe/Berlin', '2026-03-29');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('forward');
    expect(result!.minutes).toBe(60);
  });

  test('detects fall back in Europe/Berlin (last Sunday of October)', () => {
    // In 2026, Europe switches back on October 25
    // Clocks go back 1 hour (CEST → CET, UTC+2 → UTC+1)
    const result = detectClockChange('Europe/Berlin', '2026-10-25');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('back');
    expect(result!.minutes).toBe(60);
  });

  test('detects spring forward in America/New_York (second Sunday of March)', () => {
    // In 2026, US springs forward on March 8
    const result = detectClockChange('America/New_York', '2026-03-08');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('forward');
    expect(result!.minutes).toBe(60);
  });

  test('detects fall back in America/New_York (first Sunday of November)', () => {
    // In 2026, US falls back on November 1
    const result = detectClockChange('America/New_York', '2026-11-01');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('back');
    expect(result!.minutes).toBe(60);
  });

  test('returns null the day before DST transition', () => {
    // March 28, 2026 — the day BEFORE Europe springs forward
    const result = detectClockChange('Europe/Berlin', '2026-03-28');
    expect(result).toBeNull();
  });

  test('returns null the day after DST transition', () => {
    // March 30, 2026 — the day AFTER Europe springs forward
    const result = detectClockChange('Europe/Berlin', '2026-03-30');
    expect(result).toBeNull();
  });
});

describe('formatClockChangeNotice', () => {
  test('formats spring forward in Russian', () => {
    const text = formatClockChangeNotice('ru', { direction: 'forward', minutes: 60 });
    expect(text).toContain('🕐');
    expect(text).toContain('вперёд');
    expect(text).toContain('1');
  });

  test('formats fall back in Russian', () => {
    const text = formatClockChangeNotice('ru', { direction: 'back', minutes: 60 });
    expect(text).toContain('🕐');
    expect(text).toContain('назад');
  });

  test('formats spring forward in English', () => {
    const text = formatClockChangeNotice('en', { direction: 'forward', minutes: 60 });
    expect(text).toContain('🕐');
    expect(text).toContain('forward');
    expect(text).toContain('1h');
  });

  test('formats fall back in English', () => {
    const text = formatClockChangeNotice('en', { direction: 'back', minutes: 60 });
    expect(text).toContain('🕐');
    expect(text).toContain('back');
  });
});
