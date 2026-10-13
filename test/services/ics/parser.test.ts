// test/services/ics/parser.test.ts
import { describe, expect, test } from 'bun:test';
import { parseIcs } from '../../../src/services/ics/parser.ts';

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260312T150000Z
DTEND:20260312T160000Z
SUMMARY:Dentist
DESCRIPTION:Annual checkup
LOCATION:Clinic
END:VEVENT
BEGIN:VEVENT
DTSTART:20260315T090000Z
SUMMARY:Meeting
END:VEVENT
END:VCALENDAR`;

describe('parseIcs', () => {
  test('parses events from ICS string', () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events.length).toBe(2);
  });

  test('extracts event fields correctly', () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events[0]!.title).toBe('Dentist');
    expect(events[0]!.start_at).toContain('2026-03-12T15:00:00');
    expect(events[0]!.end_at).toContain('2026-03-12T16:00:00');
    expect(events[0]!.description).toBe('Annual checkup');
    expect(events[0]!.location).toBe('Clinic');
  });

  test('handles events without end time', () => {
    const events = parseIcs(SAMPLE_ICS);
    expect(events[1]!.title).toBe('Meeting');
    expect(events[1]!.end_at).toBeUndefined();
  });

  test('returns empty array for invalid ICS', () => {
    expect(parseIcs('not an ics file')).toEqual([]);
  });

  test('converts TZID timestamps to UTC', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20260312T150000
DTEND;TZID=Europe/Berlin:20260312T160000
SUMMARY:Berlin Meeting
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events.length).toBe(1);
    // Berlin is UTC+1 in March → 15:00 Berlin = 14:00 UTC
    expect(events[0]!.start_at).toContain('2026-03-12T14:00:00');
    expect(events[0]!.end_at).toContain('2026-03-12T15:00:00');
  });

  test('handles non-Z timestamps without TZID as UTC', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260312T150000
SUMMARY:Floating time
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events[0]!.start_at).toBe('2026-03-12T15:00:00Z');
  });
});

describe('recurrence lines (spec §8 — EXDATE/RDATE honored, unsupported explicitly rejected)', () => {
  test('reads EXDATE and RDATE lines into the canonical recurrence_rule block', () => {
    // recurrence-ics-roundtrip-002
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260106T100000Z
SUMMARY:Weekly sync
RRULE:FREQ=WEEKLY;COUNT=6
EXDATE:20260113T100000Z
RDATE:20260301T100000Z
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events.length).toBe(1);
    expect(events[0]!.recurrence_rule).toBe(
      'RRULE:FREQ=WEEKLY;COUNT=6\nEXDATE:20260113T100000Z\nRDATE:20260301T100000Z',
    );
    expect(events[0]!.recurrenceUnsupportedReason).toBeUndefined();
  });

  test('rejects multiple RRULE lines instead of silently keeping the first one', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260101T100000Z
SUMMARY:Bad series
RRULE:FREQ=WEEKLY;COUNT=6
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events.length).toBe(1);
    expect(events[0]!.recurrence_rule).toBeUndefined();
    expect(events[0]!.recurrenceUnsupportedReason).toBe('multi_rrule_unsupported');
  });

  test('rejects EXRULE instead of applying it', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260101T100000Z
SUMMARY:Legacy series
RRULE:FREQ=WEEKLY;COUNT=6
EXRULE:FREQ=WEEKLY;COUNT=2
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events.length).toBe(1);
    expect(events[0]!.recurrence_rule).toBeUndefined();
    expect(events[0]!.recurrenceUnsupportedReason).toBe('exrule_unsupported');
  });

  test('rejects an EXDATE value type mismatched with a date-time DTSTART', () => {
    // recurrence-ics-roundtrip-003
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260101T100000Z
SUMMARY:Mismatched series
RRULE:FREQ=WEEKLY;COUNT=6
EXDATE:20260108
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events.length).toBe(1);
    expect(events[0]!.recurrence_rule).toBeUndefined();
    expect(events[0]!.recurrenceUnsupportedReason).toBe('value_type_mismatch');
  });

  test('a locally-created bare rule still round-trips (single RRULE line, no exceptions)', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260101T100000Z
SUMMARY:Simple series
RRULE:FREQ=DAILY
END:VEVENT
END:VCALENDAR`;
    const events = parseIcs(ics);
    expect(events[0]!.recurrence_rule).toBe('RRULE:FREQ=DAILY');
  });
});
