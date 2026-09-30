import { describe, expect, test } from 'bun:test';
import { readDayContent, resolveDayReferences } from '../../../src/services/ai/day-references.ts';

// Sunday 2026-09-27, 23:00 in Belgrade (UTC+2) — the evening of the incident.
const SUNDAY_NIGHT = new Date('2026-09-27T21:00:00Z');
// Friday 2026-09-25, 13:49 in Belgrade — when "понедельник … среда …" was misdated.
const FRIDAY = new Date('2026-09-25T11:49:00Z');
const TZ = 'Europe/Belgrade';

function allowed(text: string, now = SUNDAY_NIGHT, timezone = TZ): string[] | null {
  const set = resolveDayReferences(text, now, timezone);
  return set ? [...set.allowedDates].sort() : null;
}

describe('weekday names resolve to the nearest coming date', () => {
  test('the incident messages', () => {
    expect(
      allowed(
        'понедельник Алекс Английский пригласи Алекса 12-30\nсреда Алекс Английский пригласи Алекса 12-30 среда Английский 13-30',
        FRIDAY,
      ),
    ).toEqual(['2026-09-28', '2026-09-30']);
    expect(allowed('Среда английский у Алекса 12:30')).toEqual(['2026-09-30']);
    expect(allowed('Планы на среду')).toEqual(['2026-09-30']);
    expect(allowed('Во вторник отмени весь английский')).toEqual(['2026-09-29']);
    expect(allowed('Вторник 13:00 Булку к ветеринару')).toEqual(['2026-09-29']);
  });

  test('every case form and the short forms', () => {
    expect(allowed('до среды')).toEqual(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
    expect(allowed('в пятницу')).toEqual(['2026-10-02']);
    expect(allowed('Чт Английский 12-30 Пт Алекс')).toEqual(['2026-10-01', '2026-10-02']);
    expect(allowed('в субботу и в четверг')).toEqual(['2026-10-01', '2026-10-03']);
    expect(allowed('on Wednesday')).toEqual(['2026-09-30']);
  });

  test('the named day being today allows today and the same day next week', () => {
    expect(allowed('в воскресенье')).toEqual(['2026-09-27', '2026-10-04']);
  });

  test('"next" allows the week after, "last"/past tense the week before', () => {
    expect(allowed('в следующую среду')).toEqual(['2026-09-30', '2026-10-07']);
    expect(allowed('next friday')).toEqual(['2026-10-02', '2026-10-09']);
    expect(allowed('что было во вторник')).toEqual(['2026-09-22', '2026-09-29']);
    expect(allowed('в прошлый понедельник')).toEqual(['2026-09-21', '2026-09-28']);
  });

  test('a "from … to" pair covers the days between', () => {
    expect(allowed('с понедельника по среду отпуск')).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
  });

  test('a week word only qualifies a weekday; next to a relative day it names a day of its own', () => {
    expect(allowed('в среду на следующей неделе')).toEqual(['2026-09-30', '2026-10-07']);
    expect(readDayContent('сегодня не успею, перенеси на следующую неделю', SUNDAY_NIGHT, TZ).kind).toBe('open');
  });
});

describe('relative days', () => {
  test('follow the local calendar day, not UTC', () => {
    expect(allowed('Завтра в 20.30 отвезти клетку.')).toEqual(['2026-09-28']);
    expect(allowed('сегодня')).toEqual(['2026-09-27']);
    expect(allowed('послезавтра')).toEqual(['2026-09-29']);
    expect(allowed('the day after tomorrow')).toEqual(['2026-09-29']);
    expect(allowed('завтрашнюю встречу перенеси')).toEqual(['2026-09-28']);
  });

  test('just after midnight "завтра" may still mean the day that has begun', () => {
    // 01:30 on Monday 2026-09-28 in Belgrade.
    expect(allowed('завтра', new Date('2026-09-27T23:30:00Z'))).toEqual(['2026-09-28', '2026-09-29']);
    // 05:30 is morning: only the calendar tomorrow.
    expect(allowed('завтра', new Date('2026-09-28T03:30:00Z'))).toEqual(['2026-09-29']);
  });

  test('a day named in another time zone may be the neighbouring day in the user’s zone', () => {
    // 03:00 in Tokyo on Monday is Sunday 20:00 in Belgrade.
    expect(allowed('завтра в 3 по Токио')).toEqual(['2026-09-27', '2026-09-28', '2026-09-29']);
    expect(allowed('Завтра 15:00 мск созвон')).toEqual(['2026-09-27', '2026-09-28', '2026-09-29']);
    // Lower-case "по" before a common noun is not a zone.
    expect(allowed('завтра по работе')).toEqual(['2026-09-28']);
  });
});

describe('explicit dates widen the allowed days', () => {
  test('a date written next to a weekday is allowed as well', () => {
    expect(allowed('в среду 5 октября')).toEqual(['2026-09-30', '2026-10-05', '2027-10-05']);
    expect(allowed('в среду, 01.10')).toEqual(['2026-09-30', '2026-10-01', '2027-10-01']);
  });

  test('a clock time is not read as a date', () => {
    expect(allowed('Завтра в 20.30')).toEqual(['2026-09-28']);
  });
});

describe('what cannot be pinned imposes no constraint', () => {
  test.each([
    'по средам английский',
    'каждую среду в 12',
    'every monday',
    'через неделю в среду',
    'после среды',
    'второй вторник октября',
    'ко второму вторнику подготовить отчёт',
    'к пятому четвергу месяца',
    'в октябре во вторник',
  ])('%s', (text) => {
    expect(readDayContent(text, SUNDAY_NIGHT, TZ).kind).toBe('open');
    expect(resolveDayReferences(text, SUNDAY_NIGHT, TZ)).toBeNull();
  });

  test('an explicit date alone or a period word opens; a bare time names nothing', () => {
    expect(readDayContent('5 октября встреча', SUNDAY_NIGHT, TZ).kind).toBe('open');
    expect(readDayContent('на следующей неделе созвон', SUNDAY_NIGHT, TZ).kind).toBe('open');
    expect(readDayContent('Встреча в 15:00', SUNDAY_NIGHT, TZ).kind).toBe('none');
    expect(readDayContent('Да', SUNDAY_NIGHT, TZ).kind).toBe('none');
  });

  test('a date alone opens with datesOnly; a period word beside it drops the flag', () => {
    expect(readDayContent('с 10 августа отпуск', SUNDAY_NIGHT, TZ)).toEqual({ kind: 'open', datesOnly: true });
    expect(readDayContent('на следующей неделе созвон', SUNDAY_NIGHT, TZ)).toEqual({ kind: 'open' });
    expect(readDayContent('10 августа на следующей неделе', SUNDAY_NIGHT, TZ)).toEqual({ kind: 'open' });
  });
});
