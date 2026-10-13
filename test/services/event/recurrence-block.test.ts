import { describe, expect, test } from 'bun:test';
import {
  normalizeRecurrenceLines,
  parseRecurrenceBlock,
  RecurrenceUnsupportedError,
} from '../../../src/services/event/recurrence-block.ts';

describe('normalizeRecurrenceLines', () => {
  test('wraps a bare legacy rule body (no RRULE: prefix) as a single RRULE line', () => {
    expect(normalizeRecurrenceLines('FREQ=WEEKLY;INTERVAL=1;COUNT=6')).toEqual([
      'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6',
    ]);
  });

  test('splits an already-prefixed multi-line block as-is', () => {
    const raw = 'RRULE:FREQ=WEEKLY;COUNT=6\nEXDATE:20260113T100000Z\nRDATE:20260301T100000Z';
    expect(normalizeRecurrenceLines(raw)).toEqual([
      'RRULE:FREQ=WEEKLY;COUNT=6',
      'EXDATE:20260113T100000Z',
      'RDATE:20260301T100000Z',
    ]);
  });

  test('trims blank lines', () => {
    expect(normalizeRecurrenceLines('RRULE:FREQ=DAILY\n\n\nEXDATE:20260101T100000Z\n')).toEqual([
      'RRULE:FREQ=DAILY',
      'EXDATE:20260101T100000Z',
    ]);
  });

  test('empty input returns no lines', () => {
    expect(normalizeRecurrenceLines('')).toEqual([]);
    expect(normalizeRecurrenceLines('   \n  ')).toEqual([]);
  });
});

describe('parseRecurrenceBlock — supported cases', () => {
  test('bare legacy rule is normalized to a canonical RRULE line', () => {
    const parsed = parseRecurrenceBlock('FREQ=WEEKLY;INTERVAL=2', 'date-time');
    expect(parsed.rruleLine).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2');
    expect(parsed.lines).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2']);
    expect(parsed.hasExceptionLines).toBe(false);
  });

  test('single EXDATE line is kept and reported', () => {
    const parsed = parseRecurrenceBlock('RRULE:FREQ=WEEKLY;COUNT=6\nEXDATE:20260113T100000Z', 'date-time');
    expect(parsed.exdateLines).toEqual(['EXDATE:20260113T100000Z']);
    expect(parsed.rdateLines).toEqual([]);
    expect(parsed.hasExceptionLines).toBe(true);
  });

  test('multiple EXDATE lines all apply', () => {
    const parsed = parseRecurrenceBlock(
      'RRULE:FREQ=WEEKLY;COUNT=6\nEXDATE:20260113T100000Z\nEXDATE:20260127T100000Z',
      'date-time',
    );
    expect(parsed.exdateLines).toEqual(['EXDATE:20260113T100000Z', 'EXDATE:20260127T100000Z']);
  });

  test('multiple RDATE lines and comma-separated RDATE lists all apply', () => {
    const parsed = parseRecurrenceBlock(
      'RRULE:FREQ=WEEKLY;COUNT=6\nRDATE:20260301T100000Z,20260308T100000Z\nRDATE:20260315T100000Z',
      'date-time',
    );
    expect(parsed.rdateLines).toEqual(['RDATE:20260301T100000Z,20260308T100000Z', 'RDATE:20260315T100000Z']);
  });

  test('all-day series accepts DATE-typed EXDATE/RDATE', () => {
    const parsed = parseRecurrenceBlock('RRULE:FREQ=MONTHLY;COUNT=6\nEXDATE:20260301\nRDATE:20260601', 'date');
    expect(parsed.exdateLines).toEqual(['EXDATE:20260301']);
    expect(parsed.rdateLines).toEqual(['RDATE:20260601']);
  });

  test('EXDATE;VALUE=DATE param is honored even with a date-time-shaped value', () => {
    const parsed = parseRecurrenceBlock('RRULE:FREQ=MONTHLY;COUNT=6\nEXDATE;VALUE=DATE:20260301', 'date');
    expect(parsed.exdateLines).toEqual(['EXDATE;VALUE=DATE:20260301']);
  });

  test('EXDATE;VALUE=DATE-TIME param on a date-time series is accepted, not misread as DATE by a `DATE\\b` regex', () => {
    // #657 blocker: ;VALUE=DATE\b also matches ";VALUE=DATE-TIME" because "-" is a word
    // boundary right after "DATE" — value kind must be read from the structured param list,
    // not a regex over the raw header text.
    const parsed = parseRecurrenceBlock(
      'RRULE:FREQ=WEEKLY;COUNT=6\nEXDATE;VALUE=DATE-TIME:20260113T100000Z',
      'date-time',
    );
    expect(parsed.exdateLines).toEqual(['EXDATE;VALUE=DATE-TIME:20260113T100000Z']);
  });

  test('EXDATE;VALUE=DATE-TIME param on an all-day series is rejected as a real value-type mismatch', () => {
    // Same misdetection, the dangerous direction: an all-day series must not silently accept a
    // date-time-typed EXDATE just because the buggy regex reported it as `date`.
    try {
      parseRecurrenceBlock('RRULE:FREQ=MONTHLY;COUNT=6\nEXDATE;VALUE=DATE-TIME:20260113T100000Z', 'date');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RecurrenceUnsupportedError);
      expect((err as RecurrenceUnsupportedError).reason).toBe('value_type_mismatch');
    }
  });

  test('EXDATE;TZID=... param does not change the inferred value kind', () => {
    const parsed = parseRecurrenceBlock(
      'RRULE:FREQ=WEEKLY;COUNT=6\nEXDATE;TZID=Europe/Belgrade:20260113T120000',
      'date-time',
    );
    expect(parsed.exdateLines).toEqual(['EXDATE;TZID=Europe/Belgrade:20260113T120000']);
  });

  test('COUNT alone (no UNTIL) is fine', () => {
    expect(() => parseRecurrenceBlock('RRULE:FREQ=DAILY;COUNT=5', 'date-time')).not.toThrow();
  });

  test('UNTIL alone (no COUNT) is fine', () => {
    expect(() => parseRecurrenceBlock('RRULE:FREQ=DAILY;UNTIL=20261231T000000Z', 'date-time')).not.toThrow();
  });
});

describe('parseRecurrenceBlock — explicit rejects (spec §9)', () => {
  test('multiple RRULE lines are rejected, not first-line-wins', () => {
    expect(() => parseRecurrenceBlock('RRULE:FREQ=WEEKLY;COUNT=6\nRRULE:FREQ=DAILY;COUNT=3', 'date-time')).toThrow(
      RecurrenceUnsupportedError,
    );
    try {
      parseRecurrenceBlock('RRULE:FREQ=WEEKLY;COUNT=6\nRRULE:FREQ=DAILY;COUNT=3', 'date-time');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RecurrenceUnsupportedError);
      expect((err as RecurrenceUnsupportedError).reason).toBe('multi_rrule_unsupported');
    }
  });

  test('EXRULE is rejected, not applied', () => {
    try {
      parseRecurrenceBlock('RRULE:FREQ=WEEKLY;COUNT=6\nEXRULE:FREQ=WEEKLY;COUNT=2', 'date-time');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RecurrenceUnsupportedError);
      expect((err as RecurrenceUnsupportedError).reason).toBe('exrule_unsupported');
    }
  });

  test('EXRULE is rejected even alongside valid EXDATE/RDATE lines', () => {
    expect(() =>
      parseRecurrenceBlock(
        'RRULE:FREQ=WEEKLY;COUNT=6\nEXDATE:20260113T100000Z\nEXRULE:FREQ=WEEKLY;COUNT=2',
        'date-time',
      ),
    ).toThrow(RecurrenceUnsupportedError);
  });

  test('RDATE value type mismatched with a date-time DTSTART is rejected, not coerced', () => {
    try {
      parseRecurrenceBlock('RRULE:FREQ=WEEKLY;COUNT=6\nRDATE:20260301', 'date-time');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RecurrenceUnsupportedError);
      expect((err as RecurrenceUnsupportedError).reason).toBe('value_type_mismatch');
    }
  });

  test('EXDATE value type mismatched with an all-day (date) DTSTART is rejected', () => {
    try {
      parseRecurrenceBlock('RRULE:FREQ=MONTHLY;COUNT=6\nEXDATE:20260301T100000Z', 'date');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RecurrenceUnsupportedError);
      expect((err as RecurrenceUnsupportedError).reason).toBe('value_type_mismatch');
    }
  });

  test('COUNT and UNTIL together are rejected', () => {
    try {
      parseRecurrenceBlock('RRULE:FREQ=DAILY;COUNT=5;UNTIL=20261231T000000Z', 'date-time');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RecurrenceUnsupportedError);
      expect((err as RecurrenceUnsupportedError).reason).toBe('count_and_until_conflict');
    }
  });

  test('COUNT above the wizard-consistent cap (999) is rejected, not iterated unbounded', () => {
    // security review finding: a validated-in-one-place COUNT bound stops an untrusted
    // recurrence_rule (ICS import, AI tool, Google sync — none of which run through the
    // /add wizard's own 1-999 check) from making expandRecurrence's COUNT-generation loop
    // iterate an attacker-controlled number of times.
    try {
      parseRecurrenceBlock('RRULE:FREQ=SECONDLY;COUNT=50000000', 'date-time');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RecurrenceUnsupportedError);
      expect((err as RecurrenceUnsupportedError).reason).toBe('count_out_of_range');
    }
  });

  test('a COUNT digit string so long it overflows to Infinity is rejected, not treated as unbounded', () => {
    try {
      parseRecurrenceBlock(`RRULE:FREQ=DAILY;COUNT=${'9'.repeat(400)}`, 'date-time');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RecurrenceUnsupportedError);
      expect((err as RecurrenceUnsupportedError).reason).toBe('count_out_of_range');
    }
  });

  test('COUNT=0 is rejected', () => {
    try {
      parseRecurrenceBlock('RRULE:FREQ=DAILY;COUNT=0', 'date-time');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RecurrenceUnsupportedError);
      expect((err as RecurrenceUnsupportedError).reason).toBe('count_out_of_range');
    }
  });

  test('COUNT within the cap (999) is fine', () => {
    expect(() => parseRecurrenceBlock('RRULE:FREQ=DAILY;COUNT=999', 'date-time')).not.toThrow();
  });
});
