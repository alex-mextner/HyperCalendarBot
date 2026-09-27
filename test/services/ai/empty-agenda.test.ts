import { describe, expect, test } from 'bun:test';
import { type AgendaScope, formatEmptyAgenda } from '../../../src/services/ai/empty-agenda.ts';
import { getDayRangeUtc, localCalendarDate } from '../../../src/utils/date.ts';

const BELGRADE = 'Europe/Belgrade';
// Evening of 2026-09-19 in Belgrade.
const NOW = new Date('2026-09-19T19:30:00Z');

function interval(start: string, end: string) {
  return { start: new Date(start), end: new Date(end) };
}

function ru(start: string, end: string, scope: AgendaScope = 'personal', now = NOW, timezone = BELGRADE) {
  return formatEmptyAgenda({ interval: interval(start, end), timezone, language: 'ru', scope, now });
}

function en(start: string, end: string, scope: AgendaScope = 'personal', now = NOW, timezone = BELGRADE) {
  return formatEmptyAgenda({ interval: interval(start, end), timezone, language: 'en', scope, now });
}

/** The same whole-day interval the handler builds for a date-only query. */
function localDay(date: string, timezone = BELGRADE): [string, string] {
  const { start, end } = getDayRangeUtc(localCalendarDate(date, timezone), timezone);
  return [start, end];
}

describe('formatEmptyAgenda — whole days', () => {
  test('relative days around the frozen now', () => {
    expect(ru(...localDay('2026-09-19'))).toBe(
      'На сегодня, 19 сентября, в твоём календаре пока нет событий, которые начинаются в этот день.',
    );
    expect(ru(...localDay('2026-09-21'))).toBe(
      'На послезавтра, 21 сентября, в твоём календаре пока нет событий, которые начинаются в этот день.',
    );
    expect(ru(...localDay('2026-09-18'))).toBe(
      'Вчера, 18 сентября, в твоём календаре не было событий, которые начинались в этот день.',
    );
    expect(ru(...localDay('2026-09-25'))).toBe(
      'На 25 сентября в твоём календаре пока нет событий, которые начинаются в этот день.',
    );
    expect(ru(...localDay('2026-09-10'))).toBe(
      '10 сентября в твоём календаре не было событий, которые начинались в этот день.',
    );
    expect(en(...localDay('2026-09-21'))).toBe(
      'No events in your calendar start the day after tomorrow, September 21.',
    );
    expect(en(...localDay('2026-09-18'))).toBe('No events in your calendar started yesterday, September 18.');
  });

  test('"tomorrow" follows the user timezone at local midnight, not UTC', () => {
    // 22:30 UTC on the 19th is already 00:30 on the 20th in Belgrade: tomorrow is the 21st.
    const justAfterMidnight = new Date('2026-09-19T22:30:00Z');
    expect(ru(...localDay('2026-09-21'), 'personal', justAfterMidnight)).toBe(
      'На завтра, 21 сентября, в твоём календаре пока нет событий, которые начинаются в этот день.',
    );
    expect(ru(...localDay('2026-09-20'), 'personal', justAfterMidnight)).toContain('На сегодня, 20 сентября');
  });

  test('every calendar scope is named, in both languages', () => {
    const day = localDay('2026-09-20');
    expect(ru(...day, 'group')).toContain('в календаре этой группы');
    expect(ru(...day, 'delegated')).toContain('в выбранном календаре');
    expect(en(...day, 'group')).toBe("No events in this group's calendar start tomorrow, September 20.");
    expect(en(...day, 'delegated')).toContain('in the selected calendar');
  });

  test.each([
    ['2026-03-29', 23],
    ['2026-10-25', 25],
  ])('a %s daylight-saving day (%d hours) is still one calendar day', (date, hours) => {
    const [start, end] = localDay(date);
    expect(Math.round((Date.parse(end) - Date.parse(start)) / 3_600_000)).toBe(hours);
    const text = ru(start, end, 'personal', new Date(`${date}T08:00:00Z`));
    expect(text).toBe(
      `На сегодня, ${date === '2026-03-29' ? '29 марта' : '25 октября'}, в твоём календаре пока нет событий, которые начинаются в этот день.`,
    );
  });

  test('an end at the next local midnight is exclusive, so it is still one day', () => {
    expect(ru('2026-09-20T00:00:00+02:00', '2026-09-21T00:00:00+02:00')).toBe(
      'На завтра, 20 сентября, в твоём календаре пока нет событий, которые начинаются в этот день.',
    );
  });

  test('a month boundary names both dates', () => {
    expect(ru('2026-09-30T00:00:00+02:00', '2026-10-02T23:59:59.999+02:00')).toBe(
      'С 30 сентября по 2 октября в твоём календаре пока нет событий, которые начинаются в эти дни.',
    );
  });

  test('a year boundary adds the year to both dates', () => {
    expect(ru('2026-12-31T00:00:00+01:00', '2027-01-02T23:59:59.999+01:00')).toBe(
      'С 31 декабря 2026 по 2 января 2027 в твоём календаре пока нет событий, которые начинаются в эти дни.',
    );
    expect(en('2026-12-31T00:00:00+01:00', '2027-01-02T23:59:59.999+01:00')).toBe(
      'No events in your calendar start between December 31, 2026 and January 2, 2027.',
    );
  });

  test('a single day in another year carries its year', () => {
    const newYearsEve = new Date('2026-12-31T20:00:00Z');
    expect(ru(...localDay('2027-01-01'), 'personal', newYearsEve)).toBe(
      'На завтра, 1 января 2027, в твоём календаре пока нет событий, которые начинаются в этот день.',
    );
  });

  test('English absolute days and ranges in every tense', () => {
    expect(en(...localDay('2026-09-25'))).toBe('No events in your calendar start on September 25.');
    expect(en('2026-09-01T00:00:00+02:00', '2026-09-05T23:59:59.999+02:00')).toBe(
      'No events in your calendar started between September 1 and September 5.',
    );
    expect(en('2026-09-15T00:00:00+02:00', '2026-09-25T23:59:59.999+02:00')).toBe(
      'No events in your calendar start between September 15 and September 25.',
    );
  });

  test('past and current ranges use matching tense', () => {
    expect(ru('2026-09-01T00:00:00+02:00', '2026-09-05T23:59:59.999+02:00')).toBe(
      'С 1 сентября по 5 сентября в твоём календаре не было событий, которые начинались в эти дни.',
    );
    expect(ru('2026-09-15T00:00:00+02:00', '2026-09-25T23:59:59.999+02:00')).toBe(
      'С 15 сентября по 25 сентября в твоём календаре нет событий, которые начинаются в эти дни.',
    );
  });
});

describe('formatEmptyAgenda — partial windows', () => {
  test('an hour-only window says nothing starts then and never claims a free day', () => {
    const text = en('2026-09-25T09:00:00+02:00', '2026-09-25T10:00:00+02:00');
    expect(text).toBe('No events in your calendar start on September 25 between 09:00 and 10:00.');
    expect(text).not.toMatch(/free|no events are scheduled/i);
    expect(ru('2026-09-25T09:00:00+02:00', '2026-09-25T10:00:00+02:00')).toBe(
      '25 сентября с 09:00 до 10:00 в твоём календаре нет событий, которые начинаются в это время.',
    );
  });

  test('a window crossing local midnight shows both dates with times', () => {
    expect(ru('2026-09-20T22:00:00+02:00', '2026-09-21T02:00:00+02:00')).toBe(
      'С 20 сентября 22:00 до 21 сентября 02:00 в твоём календаре нет событий, которые начинаются в это время.',
    );
  });

  test('a window that already ended is described in the past tense', () => {
    expect(en('2026-09-18T09:00:00+02:00', '2026-09-18T10:00:00+02:00')).toBe(
      'No events in your calendar started yesterday, September 18, between 09:00 and 10:00.',
    );
    expect(ru('2026-09-18T09:00:00+02:00', '2026-09-18T10:00:00+02:00')).toBe(
      'Вчера, 18 сентября, с 09:00 до 10:00 в твоём календаре не было событий, которые начинались в это время.',
    );
    expect(en('2026-09-17T22:00:00+02:00', '2026-09-18T02:00:00+02:00')).toBe(
      'No events in your calendar started between September 17, 22:00 and September 18, 02:00.',
    );
  });

  test('a cross-midnight window in English shows both dates with times', () => {
    expect(en('2026-09-20T22:00:00+02:00', '2026-09-21T02:00:00+02:00')).toBe(
      'No events in your calendar start between September 20, 22:00 and September 21, 02:00.',
    );
  });

  test('an end at 23:59:59.000 leaves the last sub-second unread, so it is a window, not a whole day', () => {
    expect(en('2026-09-25T00:00:00+02:00', '2026-09-25T23:59:59+02:00')).toBe(
      'No events in your calendar start on September 25 between 00:00 and 23:59:59.',
    );
  });

  test('bounds with seconds keep the seconds in the label', () => {
    expect(ru('2026-09-25T09:00:30+02:00', '2026-09-25T10:00:30+02:00')).toBe(
      '25 сентября с 09:00:30 до 10:00:30 в твоём календаре нет событий, которые начинаются в это время.',
    );
  });

  test('times are shown in the user timezone, not UTC', () => {
    expect(en('2026-09-20T07:00:00Z', '2026-09-20T08:00:00Z')).toBe(
      'No events in your calendar start tomorrow, September 20, between 09:00 and 10:00.',
    );
  });
});

describe('interval validation', () => {
  test.each([
    ['2026-09-20T09:00:00Z', '2026-09-20T09:00:00Z'],
    ['2026-09-21T00:00:00Z', '2026-09-20T00:00:00Z'],
    ['not-a-date', '2026-09-20T09:00:00Z'],
  ])('the formatter refuses %s .. %s instead of claiming an empty calendar', (start, end) => {
    expect(() =>
      formatEmptyAgenda({
        interval: interval(start, end),
        timezone: BELGRADE,
        language: 'ru',
        scope: 'personal',
        now: NOW,
      }),
    ).toThrow(RangeError);
  });
});
