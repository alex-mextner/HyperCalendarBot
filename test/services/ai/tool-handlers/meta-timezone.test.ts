// timezone tool handlers: offset validation, suggestions, info and conversion.
import { describe, expect, test } from 'bun:test';
import { handleCalculate } from '../../../../src/services/ai/tool-handlers/calculate.ts';
import {
  getTimezoneSuggestions,
  handleConvertToTimezone,
  handleGetTimezoneInfo,
  validateAndGetOffset,
} from '../../../../src/services/ai/tool-handlers/timezone.ts';

describe('validateAndGetOffset', () => {
  test('returns offset for valid timezone', async () => {
    const dt = new Date('2026-01-15T12:00:00Z'); // January — unambiguously winter (UTC+2)
    const result = validateAndGetOffset('Europe/Kyiv', dt);
    expect(result.offsetStr).toBe('+02:00');
    expect(result.offsetMinutes).toBe(120);
  });

  test('returns offset for UTC', async () => {
    const dt = new Date('2026-03-20T12:00:00Z');
    const result = validateAndGetOffset('UTC', dt);
    expect(result.offsetStr).toBe('+00:00');
    expect(result.offsetMinutes).toBe(0);
  });

  test('throws RangeError for invalid timezone', async () => {
    const dt = new Date('2026-03-20T12:00:00Z');
    expect(() => {
      validateAndGetOffset('Garbage/Fake', dt);
    }).toThrow(RangeError);
  });

  test('throws RangeError for invalid timezone with specific message', async () => {
    const dt = new Date('2026-03-20T12:00:00Z');
    expect(() => {
      validateAndGetOffset('Invalid/Timezone', dt);
    }).toThrow(/invalid time zone/i);
  });
});

describe('getTimezoneSuggestions', () => {
  test('returns up to 30 suggestions for valid region prefix', async () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(30);
    expect(suggestions.every((s: string) => s.startsWith('America/'))).toBe(true);
  });

  test('returns globally sorted suggestions when no slash', async () => {
    const suggestions = getTimezoneSuggestions('Moscow');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(30);
  });

  test('deduplicates by timezone', async () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    const tzNames = suggestions.map((s: string) => s.split(' ')[0]);
    const unique = new Set(tzNames);
    expect(unique.size).toBe(tzNames.length);
  });

  test('format includes timezone and city name', async () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    expect(suggestions[0]).toMatch(/^[\w/]+ \(.+\)$/);
  });
});

describe('handleGetTimezoneInfo', () => {
  // --- single timezone ---
  test('returns correct info for valid IANA timezone', async () => {
    const result = handleGetTimezoneInfo({ timezone: 'Europe/London' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezone).toBe('Europe/London');
    expect(data.utc_offset).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(typeof data.dst_active).toBe('boolean');
    expect(data.local_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('accepts at parameter and returns offset at that time', async () => {
    // New York in January is UTC-5 (EST, no DST)
    const result = handleGetTimezoneInfo({ timezone: 'America/New_York', at: '2026-01-15T12:00:00Z' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.utc_offset).toBe('-05:00');
    expect(data.dst_active).toBe(false);
  });

  test('detects DST active in summer', async () => {
    // New York in July is UTC-4 (EDT, DST active)
    const result = handleGetTimezoneInfo({ timezone: 'America/New_York', at: '2026-07-15T12:00:00Z' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.utc_offset).toBe('-04:00');
    expect(data.dst_active).toBe(true);
  });

  test('returns error and suggestions for invalid timezone', async () => {
    const result = handleGetTimezoneInfo({ timezone: 'America/Blah' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid timezone');
    expect(result.error).toContain('America/');
  });

  test('returns format error when no slash', async () => {
    const result = handleGetTimezoneInfo({ timezone: 'Moscow' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('IANA');
  });

  test('returns error for invalid at datetime', async () => {
    const result = handleGetTimezoneInfo({ timezone: 'Europe/London', at: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  // --- array of timezones ---
  test('compares two timezones and shows which is ahead', async () => {
    const result = handleGetTimezoneInfo({
      timezone: ['Europe/Moscow', 'America/New_York'],
      at: '2026-01-15T12:00:00Z', // winter: Moscow +03:00, NY -05:00
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezones).toHaveLength(2);
    expect(data.difference_minutes).toBe(480);
    expect(data.difference_hours).toBe(8);
    expect(data.ahead).toContain('Europe/Moscow');
    expect(data.ahead).toContain('ahead');
  });

  test('array: ranks N timezones west to east, no difference fields', async () => {
    const result = handleGetTimezoneInfo({
      timezone: ['Asia/Tokyo', 'America/New_York', 'Europe/London'],
      at: '2026-01-15T12:00:00Z',
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezones).toHaveLength(3);
    // ranked west→east: NY (-05:00), London (+00:00), Tokyo (+09:00)
    expect(data.ahead).toContain('Asia/Tokyo');
    expect(data.timezones[0].timezone).toBe('America/New_York');
    expect(data.timezones[2].timezone).toBe('Asia/Tokyo');
    // no difference fields for N>2
    expect(data.difference_minutes).toBeUndefined();
    expect(data.difference_hours).toBeUndefined();
  });

  test('array: returns error if any timezone is invalid', async () => {
    const result = handleGetTimezoneInfo({ timezone: ['Europe/Moscow', 'America/Blah'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('America/Blah');
  });
});

describe('handleConvertToTimezone', () => {
  test('converts UTC datetime to local time in target timezone', async () => {
    const result = handleConvertToTimezone({ datetime: '2026-07-15T14:00:00Z', timezone: 'America/New_York' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezone).toBe('America/New_York');
    expect(data.local_datetime).toBe('2026-07-15T10:00:00-04:00'); // EDT = UTC-4
    expect(data.utc_offset).toBe('-04:00');
  });

  test('converts datetime with offset to another timezone', async () => {
    const result = handleConvertToTimezone({ datetime: '2026-01-15T10:00:00+01:00', timezone: 'Asia/Tokyo' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.local_datetime).toBe('2026-01-15T18:00:00+09:00');
  });

  test('returns error for invalid timezone', async () => {
    const result = handleConvertToTimezone({ datetime: '2026-01-15T10:00:00Z', timezone: 'Europe/Blah' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid timezone');
  });

  test('returns error for invalid datetime', async () => {
    const result = handleConvertToTimezone({ datetime: 'not-a-date', timezone: 'Europe/London' });
    expect(result.success).toBe(false);
  });

  // 2026-07-10 incident (#516): an offset-free wall clock was read in the server's zone (UTC).
  test.each([
    ['2026-07-11T11:00:00', 'Africa/Cairo', '2026-07-11 11:00:00'],
    ['2026-07-11T11:00', 'Europe/Belgrade', '2026-07-11 11:00'],
    ['2026-07-11 11:00', 'Europe/Belgrade', '2026-07-11 11:00'],
    ['2026-07-11T11:00:30', 'Europe/Belgrade', '2026-07-11 11:00:30'],
  ])('refuses the offset-free datetime %s instead of guessing its zone', (datetime, timezone, wallClock) => {
    const result = handleConvertToTimezone({ datetime, timezone });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no Z or UTC offset');
    // The suggested call keeps every given digit and leaves the zone of that wall clock to the
    // caller; with a zone filled in, it runs.
    expect(result.error).toContain(`calculate("${wallClock} <IANA zone of that local time> to UTC")`);
    expect(handleCalculate({ expression: `${wallClock} Africa/Cairo to UTC` }).success).toBe(true);
  });

  test('never suggests reading an offset-free wall clock in the target zone', () => {
    // "11:00 my time (Belgrade) in New York": the target zone is not the zone the wall clock is in,
    // so calculate("… America/New_York to UTC") would silently answer for a different moment.
    const result = handleConvertToTimezone({ datetime: '2026-07-11T11:00:00', timezone: 'America/New_York' });
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('America/New_York');
  });

  test('refuses a bare date without a copyable call that needs filling in', () => {
    const result = handleConvertToTimezone({ datetime: '2026-07-11', timezone: 'Europe/Belgrade' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('no time of day');
    expect(result.error).not.toContain('calculate("');
  });

  test.each([
    ['2026-07-11T11:00:00+02', '2026-07-11T05:00:00-04:00'],
    ['2026-07-11 09:00:00Z', '2026-07-11T05:00:00-04:00'],
  ])('accepts the offset-bearing instant %s it accepted before', (datetime, local) => {
    const result = handleConvertToTimezone({ datetime, timezone: 'America/New_York' });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output!).local_datetime).toBe(local);
  });

  test.each([
    '2026-13-45T10:00:00Z',
    '2026-07-11T11:00:00+02:00 tomorrow',
  ])('rejects the invalid datetime %s', (datetime) => {
    const result = handleConvertToTimezone({ datetime, timezone: 'Europe/Belgrade' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid datetime');
  });

  test.each([
    ['2026-10-25T00:30:00Z', '2026-10-25T02:30:00+02:00'],
    ['2026-10-25T01:30:00Z', '2026-10-25T02:30:00+01:00'],
    ['2026-03-29T01:30:00.000Z', '2026-03-29T03:30:00+02:00'],
    ['2026-09-28T12:30:00+0200', '2026-09-28T12:30:00+02:00'],
  ])('keeps converting the instant %s across DST in Europe/Belgrade', (datetime, local) => {
    const result = handleConvertToTimezone({ datetime, timezone: 'Europe/Belgrade' });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output!).local_datetime).toBe(local);
  });

  test('the answer does not depend on the process timezone', () => {
    // A child process with its own TZ: several test files replace process.env with a plain
    // object, after which assigning process.env.TZ in this process no longer reaches Date.
    const handlerPath = Bun.fileURLToPath(
      new URL('../../../../src/services/ai/tool-handlers/timezone.ts', import.meta.url),
    );
    const script = `
      const { handleConvertToTimezone } = await import(${JSON.stringify(handlerPath)});
      const instant = handleConvertToTimezone({ datetime: '2026-07-11T09:00:00Z', timezone: 'Europe/Belgrade' });
      const wallClock = handleConvertToTimezone({ datetime: '2026-07-11T11:00:00', timezone: 'Europe/Belgrade' });
      process.stdout.write(JSON.stringify({
        processHour: new Date('2026-07-11T00:00:00Z').getHours(),
        local: JSON.parse(instant.output).local_datetime,
        wallClockAccepted: wallClock.success,
      }));`;
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
      env: { ...process.env, TZ: 'Asia/Tokyo' },
      timeout: 30_000,
    });
    expect({ exitCode: child.exitCode, stderr: child.exitCode === 0 ? '' : child.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: '',
    });
    // processHour 9 proves the child really runs in Asia/Tokyo, so the test exercises its premise.
    expect(JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
      processHour: 9,
      local: '2026-07-11T11:00:00+02:00',
      wallClockAccepted: false,
    });
  });
});
