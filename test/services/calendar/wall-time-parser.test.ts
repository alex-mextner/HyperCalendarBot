// test/services/calendar/wall-time-parser.test.ts
//
// Reproduces, as executable tests, the relevant families of the declarative corpus
// authored for #554 (`unified-dialogue-contract-cases.jsonl`: time-ambiguous,
// time-bare-unambiguous, time-explicit, time-invalid, time-words, all-day, dst,
// unknown-time — see docs/specs/2026-09-28-shared-wall-time-parser-650.md for exactly
// where that corpus lives; it is not checked into this repo). The corpus rows are
// `design_contract` status only — reading the JSONL is not a substitute for these
// assertions; each case below is re-derived and independently checked, not copied
// verbatim, per the corpus README's "не вычислять expected production-парсером" rule.
//
// Fixture matches the task brief: selected date 2026-09-29, Europe/Belgrade (UTC+2 / CEST
// in September, before the 2026-10-25 fall-back).

import { describe, expect, setSystemTime, test } from 'bun:test';
import { parseWallTimeInput, type WallTimeContext } from '../../../src/services/calendar/wall-time-parser.ts';

const ctx = (overrides: Partial<WallTimeContext> = {}): WallTimeContext => ({
  selectedDate: '2026-09-29',
  timezone: 'Europe/Belgrade',
  pendingField: 'time',
  ...overrides,
});

describe('bare hour 1-12 is ambiguous, never guessed (time-ambiguous family)', () => {
  test.each([
    ['1', '01:00', '13:00'],
    ['01', '01:00', '13:00'],
    ['в 1', '01:00', '13:00'],
    ['2', '02:00', '14:00'],
    ['02', '02:00', '14:00'],
    ['в 2', '02:00', '14:00'],
    ['12', '00:00', '12:00'],
  ])('%s → ambiguous between %s and %s', (raw, low, high) => {
    const outcome = parseWallTimeInput(raw, ctx());
    expect(outcome.decision).toBe('ambiguous');
    if (outcome.decision !== 'ambiguous') throw new Error('unreachable');
    expect(outcome.reason).toBe('bare_hour');
    expect(outcome.candidates).toEqual([low, high]);
  });
});

describe('bare hour 13-23 is unambiguous (time-bare-unambiguous family)', () => {
  test.each([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23])('%s → accepted as literal 24h value', (hour) => {
    const outcome = parseWallTimeInput(String(hour), ctx());
    expect(outcome.decision).toBe('accepted');
    if (outcome.decision !== 'accepted') throw new Error('unreachable');
    // 2026-09-29 in Belgrade is UTC+2 (CEST); hour:00 local → (hour-2):00 UTC.
    expect(outcome.schedule).toEqual({
      kind: 'timed',
      startAt: `2026-09-29T${String(hour - 2).padStart(2, '0')}:00:00.000Z`,
    });
  });

  test('bare 0 is unambiguous midnight, not part of the 1-12 ambiguity window', () => {
    const outcome = parseWallTimeInput('0', ctx());
    expect(outcome.decision).toBe('accepted');
    if (outcome.decision !== 'accepted') throw new Error('unreachable');
    expect(outcome.schedule).toEqual({ kind: 'timed', startAt: '2026-09-28T22:00:00.000Z' });
  });
});

describe('explicit time retains its stated meaning (time-explicit / time-words families)', () => {
  test.each([
    ['00:00', '2026-09-28T22:00:00.000Z'],
    ['0:00', '2026-09-28T22:00:00.000Z'],
    ['00:15', '2026-09-28T22:15:00.000Z'],
    ['0:15', '2026-09-28T22:15:00.000Z'],
    ['14:00', '2026-09-29T12:00:00.000Z'],
    ['2:30', '2026-09-29T00:30:00.000Z'], // colon makes 2 explicit 02:30, never the 1-12 ambiguity
  ])('%s is explicit, colon means 24h', (raw, startAt) => {
    const outcome = parseWallTimeInput(raw, ctx());
    expect(outcome.decision).toBe('accepted');
    if (outcome.decision !== 'accepted') throw new Error('unreachable');
    expect(outcome.schedule).toEqual({ kind: 'timed', startAt });
  });

  test('am/pm and Russian day-part suffixes resolve without ambiguity', () => {
    expect(schedule('2pm')).toEqual(schedule('14:00'));
    expect(schedule('2 pm')).toEqual(schedule('14:00'));
    expect(schedule('2 дня')).toEqual(schedule('14:00'));
    expect(schedule('2 ночи')).toEqual(schedule('02:00'));
    expect(schedule('7 вечера')).toEqual(schedule('19:00'));
    expect(schedule('полдень')).toEqual(schedule('12:00'));
    expect(schedule('noon')).toEqual(schedule('12:00'));
    expect(schedule('полночь')).toEqual(schedule('00:00'));
    expect(schedule('midnight')).toEqual(schedule('00:00'));
  });

  function schedule(raw: string) {
    const outcome = parseWallTimeInput(raw, ctx());
    if (outcome.decision !== 'accepted') throw new Error(`expected accepted for ${raw}, got ${outcome.decision}`);
    return outcome.schedule;
  }
});

describe('invalid clock values are rejected, never normalized (time-invalid family)', () => {
  test.each([
    '24:00',
    '24:15',
    '24:30',
    '24:60',
    '25:00',
    '25:15',
    '14:75',
    '13pm',
    '99',
  ])('%s is rejected outright', (raw) => {
    const outcome = parseWallTimeInput(raw, ctx());
    expect(outcome.decision).toBe('invalid');
    if (outcome.decision !== 'invalid') throw new Error('unreachable');
    expect(outcome.reason).toBe('explicit_date_or_time_repair');
  });

  test('24:00 is rejected outright, not silently rolled to the next day', () => {
    const outcome = parseWallTimeInput('24:00', ctx());
    expect(outcome.decision).toBe('invalid');
  });

  test('garbage text abstains rather than guessing', () => {
    const outcome = parseWallTimeInput('вечером', ctx());
    expect(outcome.decision).toBe('invalid');
    if (outcome.decision !== 'invalid') throw new Error('unreachable');
    expect(outcome.reason).toBe('unparseable');
  });
});

describe('all-day is its own Schedule kind, not a 00:00-24h Timed event (all-day family)', () => {
  test.each(['весь день', 'на весь день', 'all day'])('%s → all_day with exclusive end', (raw) => {
    const outcome = parseWallTimeInput(raw, ctx());
    expect(outcome.decision).toBe('accepted');
    if (outcome.decision !== 'accepted') throw new Error('unreachable');
    expect(outcome.schedule).toEqual({ kind: 'all_day', startDate: '2026-09-29', endDateExclusive: '2026-09-30' });
  });
});

describe('"time unknown" is not all-day (unknown-time family)', () => {
  test.each(['время пока не знаю', 'пока без времени', 'time not decided'])('%s → clarify, not all_day', (raw) => {
    const outcome = parseWallTimeInput(raw, ctx());
    expect(outcome.decision).toBe('clarify');
    if (outcome.decision !== 'clarify') throw new Error('unreachable');
    expect(outcome.reason).toBe('unknown_time_is_not_all_day');
  });
});

describe('day-part suffix ranges cover the whole stated period, not just its typical hours (GH-650 follow-up)', () => {
  test.each([
    ['в 1 утра', '01:00'],
    ['в 2 утра', '02:00'],
    ['в 3 утра', '03:00'],
    ['1 утра', '01:00'],
    ['2 утра', '02:00'],
  ])('%s is explicit early morning, never rejected', (raw, expectedLocal) => {
    const outcome = parseWallTimeInput(raw, ctx());
    expect(outcome.decision).toBe('accepted');
    if (outcome.decision !== 'accepted')
      throw new Error(`expected accepted for ${raw}, got ${JSON.stringify(outcome)}`);
    const [hh, mm] = expectedLocal.split(':').map(Number) as [number, number];
    const utcHour = (hh - 2 + 24) % 24;
    const utcDay = hh - 2 < 0 ? '2026-09-28' : '2026-09-29';
    expect(outcome.schedule).toEqual({
      kind: 'timed',
      startAt: `${utcDay}T${String(utcHour).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`,
    });
  });
});

describe('a prefix before a word-time is stripped, not just before digits (GH-650 follow-up)', () => {
  test.each([
    ['в полдень', '12:00'],
    ['at noon', '12:00'],
    ['в полночь', '00:00'],
    ['at midnight', '00:00'],
  ])('%s resolves the same as the bare word', (raw, expectedLocal) => {
    const outcome = parseWallTimeInput(raw, ctx());
    expect(outcome.decision).toBe('accepted');
    if (outcome.decision !== 'accepted')
      throw new Error(`expected accepted for ${raw}, got ${JSON.stringify(outcome)}`);
    const bare = parseWallTimeInput(expectedLocal === '12:00' ? 'полдень' : 'полночь', ctx());
    if (bare.decision !== 'accepted') throw new Error(`expected accepted bare word, got ${JSON.stringify(bare)}`);
    expect(outcome.schedule).toEqual(bare.schedule);
  });
});

describe('WORD_TIMES only recognizes its own keys, never inherited Object.prototype members (GH-650 follow-up)', () => {
  test.each([
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'valueOf',
  ])('%s is unparseable, not a false DST-gap/prototype value', (raw) => {
    const outcome = parseWallTimeInput(raw, ctx());
    expect(outcome.decision).toBe('invalid');
    if (outcome.decision !== 'invalid') throw new Error('unreachable');
    expect(outcome.reason).toBe('unparseable');
  });
});

describe('Russian spelled-out hours 1-12 behave exactly like their digit form, a closed lexicon (GH-650 follow-up)', () => {
  test.each([
    ['один', '1'],
    ['два', '2'],
    ['три', '3'],
    ['четыре', '4'],
    ['пять', '5'],
    ['шесть', '6'],
    ['семь', '7'],
    ['восемь', '8'],
    ['девять', '9'],
    ['десять', '10'],
    ['одиннадцать', '11'],
    ['двенадцать', '12'],
  ])('bare "%s" is ambiguous exactly like bare "%s"', (word, digit) => {
    const wordOutcome = parseWallTimeInput(word, ctx());
    const digitOutcome = parseWallTimeInput(digit, ctx());
    expect(wordOutcome).toEqual(digitOutcome);
  });

  test.each([
    ['два ночи', '2 ночи'],
    ['в два дня', 'в 2 дня'],
    ['два утра', '2 утра'],
  ])('"%s" resolves exactly like "%s"', (wordForm, digitForm) => {
    const wordOutcome = parseWallTimeInput(wordForm, ctx());
    const digitOutcome = parseWallTimeInput(digitForm, ctx());
    expect(wordOutcome).toEqual(digitOutcome);
    expect(wordOutcome.decision).toBe('accepted');
  });

  test('"в два" is still ambiguous exactly like "в 2" — a prefix alone never disambiguates', () => {
    const wordOutcome = parseWallTimeInput('в два', ctx());
    const digitOutcome = parseWallTimeInput('в 2', ctx());
    expect(wordOutcome).toEqual(digitOutcome);
    expect(wordOutcome.decision).toBe('ambiguous');
  });

  test('a Russian number word above the closed 1-12 lexicon is unparseable, not guessed', () => {
    const outcome = parseWallTimeInput('тринадцать', ctx());
    expect(outcome.decision).toBe('invalid');
    if (outcome.decision !== 'invalid') throw new Error('unreachable');
    expect(outcome.reason).toBe('unparseable');
  });
});

describe('24:00 is already rejected outright with a repair-offering reason, not silently rolled over (regression pin, no change)', () => {
  test('24:00 stays invalid with explicit_date_or_time_repair, never accepted as next-day midnight', () => {
    const outcome = parseWallTimeInput('24:00', ctx());
    expect(outcome.decision).toBe('invalid');
    if (outcome.decision !== 'invalid') throw new Error('unreachable');
    expect(outcome.reason).toBe('explicit_date_or_time_repair');
  });
});

describe('no pending time means a bare number is not guessed as a time (number-context family)', () => {
  test('the same digit with pendingField null returns unhandled, not a time guess', () => {
    const outcome = parseWallTimeInput('2', ctx({ pendingField: null }));
    expect(outcome.decision).toBe('unhandled');
    if (outcome.decision !== 'unhandled') throw new Error('unreachable');
    expect(outcome.reason).toBe('not_pending_time');
  });

  test('the selected date stays anchored regardless of the caller-supplied pendingField', () => {
    // Different pendingField, same selectedDate: the engine never recomputes "today" itself.
    const timed = parseWallTimeInput('14:00', ctx({ pendingField: 'time' }));
    const unhandled = parseWallTimeInput('14:00', ctx({ pendingField: null }));
    expect(timed.decision).toBe('accepted');
    expect(unhandled.decision).toBe('unhandled');
  });
});

describe('negation and unsupported grammar abstain rather than stripping a prefix (negative-entry family)', () => {
  test.each(['не 2', 'не в 2', 'not 2', 'не создавай в 2', "don't at 2"])('%s never resolves to time 2', (raw) => {
    const outcome = parseWallTimeInput(raw, ctx());
    expect(outcome.decision).not.toBe('accepted');
    expect(outcome.decision).not.toBe('ambiguous');
  });
});

describe('DST gap — spring forward (dst family)', () => {
  const dstGapCtx = ctx({ selectedDate: '2026-03-29' });
  test.each(['02:00', '02:15', '02:30', '02:45'])('%s does not exist that day', (raw) => {
    const outcome = parseWallTimeInput(raw, dstGapCtx);
    expect(outcome.decision).toBe('invalid');
    if (outcome.decision !== 'invalid') throw new Error('unreachable');
    expect(outcome.reason).toBe('nonexistent_local_time');
  });
});

describe('DST fold — fall back (dst family)', () => {
  const dstFoldCtx = ctx({ selectedDate: '2026-10-25' });
  test.each([
    ['02:00', '2026-10-25T02:00:00+02:00', '2026-10-25T02:00:00+01:00'],
    ['02:15', '2026-10-25T02:15:00+02:00', '2026-10-25T02:15:00+01:00'],
  ] as const)('%s happens twice and is reported explicitly with offsets', (raw, earlier, later) => {
    const outcome = parseWallTimeInput(raw, dstFoldCtx);
    expect(outcome.decision).toBe('ambiguous');
    if (outcome.decision !== 'ambiguous') throw new Error('unreachable');
    expect(outcome.reason).toBe('repeated_local_time');
    expect(outcome.candidates).toEqual([earlier, later]);
  });

  test('a bare-hour ambiguity candidate landing inside a DST gap is only a label — GH-652 must re-resolve it', () => {
    // Documents a deliberate, narrow scope boundary (flagged in independent review): the
    // spring-forward gap day's bare "2" still offers 02:00 as a candidate label even
    // though 02:00 doesn't exist that day. Re-resolving the user's chosen label through
    // this same parser (as an explicit "02:00") correctly rejects it — the label is never
    // silently accepted as a real instant.
    const bareHour = parseWallTimeInput('2', ctx({ selectedDate: '2026-03-29' }));
    expect(bareHour).toEqual({ decision: 'ambiguous', reason: 'bare_hour', candidates: ['02:00', '14:00'] });
    const chosenLabel = parseWallTimeInput('02:00', ctx({ selectedDate: '2026-03-29' }));
    expect(chosenLabel.decision).toBe('invalid');
  });
});

describe('calendar-date validity is rejected rather than silently normalized', () => {
  test('a selectedDate that does not exist is rejected up front', () => {
    const outcome = parseWallTimeInput('14:00', ctx({ selectedDate: '2026-02-30' }));
    expect(outcome.decision).toBe('invalid');
    if (outcome.decision !== 'invalid') throw new Error('unreachable');
    expect(outcome.reason).toBe('calendar_date_does_not_exist');
  });

  test('a malformed selectedDate shape is rejected, not partially parsed', () => {
    const outcome = parseWallTimeInput('14:00', ctx({ selectedDate: 'tomorrow' }));
    expect(outcome.decision).toBe('invalid');
    if (outcome.decision !== 'invalid') throw new Error('unreachable');
    expect(outcome.reason).toBe('calendar_date_does_not_exist');
  });
});

describe('timezone validity is rejected rather than throwing', () => {
  test('an unresolvable IANA zone is invalid, not an uncaught exception', () => {
    const outcome = parseWallTimeInput('14:00', ctx({ timezone: 'Not/AZone' }));
    expect(outcome.decision).toBe('invalid');
    if (outcome.decision !== 'invalid') throw new Error('unreachable');
    expect(outcome.reason).toBe('invalid_timezone');
  });
});

describe('purity — never reads the system clock', () => {
  test('identical input/context give identical output regardless of the current instant', () => {
    setSystemTime(new Date('2026-09-28T10:00:00Z'));
    const before = parseWallTimeInput('14:00', ctx());
    setSystemTime(new Date('2099-01-01T00:00:00Z'));
    try {
      const after = parseWallTimeInput('14:00', ctx());
      expect(after).toEqual(before);
    } finally {
      setSystemTime();
    }
  });
});
