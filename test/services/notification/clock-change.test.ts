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

  // --- Edge cases: "Falsehoods programmers believe about time" ---

  test('Lord Howe Island: 30-minute DST shift (not 60)', () => {
    // Australia/Lord_Howe springs forward 30 minutes on Oct 4, 2026
    // UTC+10:30 → UTC+11:00 (only 30 min, not 60!)
    const result = detectClockChange('Australia/Lord_Howe', '2026-10-04');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('forward');
    expect(result!.minutes).toBe(30);
  });

  test('Lord Howe Island: 30-minute fall back', () => {
    // Australia/Lord_Howe falls back 30 minutes on Apr 5, 2026
    // UTC+11:00 → UTC+10:30
    const result = detectClockChange('Australia/Lord_Howe', '2026-04-05');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('back');
    expect(result!.minutes).toBe(30);
  });

  test('Chatham Islands (UTC+12:45): 60-minute DST despite fractional base offset', () => {
    // Pacific/Chatham springs forward on Sep 27, 2026
    // UTC+12:45 → UTC+13:45 (still a 60-min shift, but from a 45-min base)
    const result = detectClockChange('Pacific/Chatham', '2026-09-27');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('forward');
    expect(result!.minutes).toBe(60);
  });

  test('Chatham Islands fall back', () => {
    // Pacific/Chatham falls back on Apr 5, 2026
    // UTC+13:45 → UTC+12:45
    const result = detectClockChange('Pacific/Chatham', '2026-04-05');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('back');
    expect(result!.minutes).toBe(60);
  });

  test('southern hemisphere: Australia/Sydney DST ends in April (fall back)', () => {
    // Sydney falls back on Apr 5, 2026 (southern hemisphere — opposite of Europe/US)
    const result = detectClockChange('Australia/Sydney', '2026-04-05');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('back');
    expect(result!.minutes).toBe(60);
  });

  test('southern hemisphere: Australia/Sydney DST starts in October (spring forward)', () => {
    // Sydney springs forward on Oct 4, 2026
    const result = detectClockChange('Australia/Sydney', '2026-10-04');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('forward');
    expect(result!.minutes).toBe(60);
  });

  test('Morocco: Ramadan fall-back (mid-year, not autumn)', () => {
    // Africa/Casablanca reverts UTC+1 → UTC+0 around Feb 15, 2026 for Ramadan
    // This is NOT a normal DST transition — it's a religious/political offset change
    const result = detectClockChange('Africa/Casablanca', '2026-02-15');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('back');
    expect(result!.minutes).toBe(60);
  });

  test('Morocco: spring-forward back from Ramadan time', () => {
    // Africa/Casablanca goes UTC+0 → UTC+1 around Mar 22, 2026 after Ramadan
    const result = detectClockChange('Africa/Casablanca', '2026-03-22');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('forward');
    expect(result!.minutes).toBe(60);
  });

  test('no DST timezone with fractional offset: Asia/Kathmandu (UTC+5:45)', () => {
    // Nepal uses UTC+5:45 year-round, never has DST
    const result = detectClockChange('Asia/Kathmandu', '2026-03-29');
    expect(result).toBeNull();
  });

  test('no DST timezone with half-hour offset: Asia/Kolkata (UTC+5:30)', () => {
    // India uses UTC+5:30 year-round, no DST
    const result = detectClockChange('Asia/Kolkata', '2026-03-29');
    expect(result).toBeNull();
  });

  test('Palestine (Asia/Gaza): spring forward with late-announced dates', () => {
    // Palestinian Authority sometimes announces DST dates with only days of notice
    // 2026 spring forward: March 28
    const result = detectClockChange('Asia/Gaza', '2026-03-28');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('forward');
    expect(result!.minutes).toBe(60);
  });

  test('Egypt (Africa/Cairo): reinstated DST after years of chaos', () => {
    // Egypt abolished DST in 2011, briefly reinstated in 2014, cancelled again,
    // then restored in 2023. Tests that IANA tzdata is current.
    // 2026 spring forward: April 24
    const result = detectClockChange('Africa/Cairo', '2026-04-24');
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('forward');
    expect(result!.minutes).toBe(60);
  });

  test('extreme timezone: Pacific/Kiritimati (UTC+14, no DST)', () => {
    // World's furthest-ahead timezone, no DST
    const result = detectClockChange('Pacific/Kiritimati', '2026-03-29');
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

  test('formats 30-minute shift as "30 min" not "0.5h" (Lord Howe Island case)', () => {
    // 30 min should display as "30 min" / "30 минут", not "0.5h" / "0.5 часов"
    const textEn = formatClockChangeNotice('en', { direction: 'forward', minutes: 30 });
    expect(textEn).toContain('30');
    expect(textEn).toContain('min');
    expect(textEn).not.toContain('0.5');

    const textRu = formatClockChangeNotice('ru', { direction: 'forward', minutes: 30 });
    expect(textRu).toContain('30');
    expect(textRu).toContain('минут');
    expect(textRu).not.toContain('0.5');
  });
});
