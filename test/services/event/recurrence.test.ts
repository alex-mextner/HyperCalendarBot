import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '../../../src/database/types.ts';
import { expandRecurrence, RecurrenceUnsupportedError } from '../../../src/services/event/recurrence.ts';

function makeTemplate(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    user_id: 123,
    title: 'Daily standup',
    description: null,
    category: null,
    start_at: '2026-03-01T09:00:00Z',
    end_at: '2026-03-01T09:30:00Z',
    all_day: 0,
    timezone: 'UTC',
    location: null,
    recurrence_rule: 'FREQ=DAILY',
    recurrence_end_at: null,
    parent_event_id: null,
    original_start_at: null,
    identity_status: null,
    is_cancelled: 0,
    is_deleted: 0,
    reminder_overrides: null,
    google_event_id: null,
    google_calendar_id: null,
    google_etag: null,
    sync_status: 'local_only' as const,
    sync_version: 0,
    owner_type: 'user' as const,
    group_id: null,
    created_by: null,
    resolved_address: null,
    latitude: null,
    longitude: null,
    google_maps_url: null,
    location_verified: 0,
    venue_name: null,
    last_synced_at: null,
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

function makeException(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return makeTemplate({ id: 2, parent_event_id: 1, recurrence_rule: null, ...overrides });
}

describe('expandRecurrence', () => {
  test('expands daily rule within range', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY' });
    const { occurrences } = expandRecurrence(template, [], '2026-03-10T00:00:00Z', '2026-03-12T23:59:59Z');
    expect(occurrences.length).toBe(3);
    expect(occurrences[0]!.occurrence_start).toContain('2026-03-10T09:00');
    expect(occurrences[0]!.is_exception).toBe(false);
  });

  test('expands weekly rule with BYDAY', () => {
    const template = makeTemplate({
      start_at: '2026-03-02T09:00:00Z',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    });
    const { occurrences } = expandRecurrence(template, [], '2026-03-09T00:00:00Z', '2026-03-15T23:59:59Z');
    expect(occurrences.length).toBe(3);
  });

  test('respects COUNT limit (COUNT includes DTSTART)', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY;COUNT=5' });
    const { occurrences } = expandRecurrence(template, [], '2026-03-01T00:00:00Z', '2026-12-31T23:59:59Z');
    expect(occurrences.length).toBe(5);
    expect(occurrences[0]!.occurrence_start).toContain('2026-03-01T09:00');
  });

  test('UNTIL is inclusive of the occurrence landing exactly on it', () => {
    const template = makeTemplate({
      start_at: '2026-03-01T09:00:00Z',
      recurrence_rule: 'FREQ=DAILY;UNTIL=20260303T090000Z',
    });
    const { occurrences } = expandRecurrence(template, [], '2026-03-01T00:00:00Z', '2026-03-10T23:59:59Z');
    expect(occurrences.length).toBe(3);
    expect(occurrences.at(-1)!.occurrence_start).toContain('2026-03-03T09:00');
  });

  test('applies exception (modified occurrence)', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY' });
    const exceptions: CalendarEvent[] = [
      makeException({
        title: 'Modified standup',
        original_start_at: '2026-03-11T09:00:00Z',
        start_at: '2026-03-11T10:00:00Z',
      }),
    ];
    const { occurrences } = expandRecurrence(template, exceptions, '2026-03-10T00:00:00Z', '2026-03-12T23:59:59Z');
    const mar11 = occurrences.find((o) => o.occurrence_start.includes('2026-03-11'));
    expect(mar11).toBeDefined();
    expect(mar11!.event.title).toBe('Modified standup');
    expect(mar11!.is_exception).toBe(true);
  });

  test('applies cancelled exception', () => {
    const template = makeTemplate({ recurrence_rule: 'FREQ=DAILY' });
    const exceptions: CalendarEvent[] = [makeException({ is_cancelled: 1, original_start_at: '2026-03-11T09:00:00Z' })];
    const { occurrences } = expandRecurrence(template, exceptions, '2026-03-10T00:00:00Z', '2026-03-12T23:59:59Z');
    expect(occurrences.length).toBe(2);
  });

  test('computes occurrence_end from template duration', () => {
    const template = makeTemplate({
      recurrence_rule: 'FREQ=DAILY',
      end_at: '2026-03-01T09:30:00Z',
    });
    const { occurrences } = expandRecurrence(template, [], '2026-03-10T00:00:00Z', '2026-03-10T23:59:59Z');
    expect(occurrences[0]!.occurrence_end).toContain('2026-03-10T09:30');
  });

  test('returns empty result for invalid start_at date instead of crashing', () => {
    const template = makeTemplate({
      start_at: '2027-00-00T00:00:00Z',
      recurrence_rule: 'FREQ=YEARLY',
    });
    const { occurrences } = expandRecurrence(template, [], '2026-03-01T00:00:00Z', '2027-12-31T23:59:59Z');
    expect(occurrences).toEqual([]);
  });

  test('a template with no recurrence_rule expands to nothing', () => {
    const template = makeTemplate({ recurrence_rule: null });
    const { occurrences } = expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z');
    expect(occurrences).toEqual([]);
  });

  describe('DST handling with TZID', () => {
    // Europe/Belgrade: UTC+1 winter, UTC+2 summer. DST switch 2026: last Sunday of March = March 29.
    // At 2:00 AM CET, clocks move forward to 3:00 AM CEST.

    test('weekly event preserves local time across DST transition', () => {
      const template = makeTemplate({
        start_at: '2026-01-05T11:30:00Z', // Monday, 12:30 Belgrade (CET, UTC+1)
        end_at: '2026-01-05T12:30:00Z',
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      });

      const beforeDst = expandRecurrence(template, [], '2026-03-23T00:00:00Z', '2026-03-23T23:59:59Z').occurrences;
      expect(beforeDst.length).toBe(1);
      expect(beforeDst[0]!.occurrence_start).toContain('2026-03-23T11:30');
      expect(beforeDst[0]!.occurrence_end).toContain('2026-03-23T12:30');

      const afterDst = expandRecurrence(template, [], '2026-03-30T00:00:00Z', '2026-03-30T23:59:59Z').occurrences;
      expect(afterDst.length).toBe(1);
      expect(afterDst[0]!.occurrence_start).toContain('2026-03-30T10:30');
      expect(afterDst[0]!.occurrence_end).toContain('2026-03-30T11:30');
    });

    test('daily event adjusts UTC time on DST boundary day', () => {
      const template = makeTemplate({
        start_at: '2026-03-01T08:00:00Z', // 09:00 Belgrade (CET)
        end_at: '2026-03-01T08:30:00Z',
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=DAILY',
      });

      const { occurrences: occs } = expandRecurrence(template, [], '2026-03-28T00:00:00Z', '2026-03-30T23:59:59Z');
      expect(occs.length).toBe(3);
      expect(occs[0]!.occurrence_start).toContain('2026-03-28T08:00');
      expect(occs[1]!.occurrence_start).toContain('2026-03-29T07:00');
      expect(occs[2]!.occurrence_start).toContain('2026-03-30T07:00');
    });

    test('all-day recurring events stay in UTC (no TZID)', () => {
      const template = makeTemplate({
        start_at: '2026-03-01T00:00:00Z',
        end_at: '2026-03-02T00:00:00Z',
        all_day: 1,
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=DAILY',
      });

      const { occurrences: occs } = expandRecurrence(template, [], '2026-03-28T00:00:00Z', '2026-03-30T23:59:59Z');
      expect(occs.length).toBe(3);
      expect(occs[0]!.occurrence_start).toContain('2026-03-28T00:00');
      expect(occs[1]!.occurrence_start).toContain('2026-03-29T00:00');
      expect(occs[2]!.occurrence_start).toContain('2026-03-30T00:00');
    });

    test('spring-forward gap: nonexistent local time is omitted, not silently shifted', () => {
      // daily_02_30_europe_belgrade — recurrence-dst-gap-001
      const template = makeTemplate({
        start_at: '2026-01-01T01:30:00Z', // 02:30 Belgrade in winter (CET, UTC+1)
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=DAILY;COUNT=120',
      });
      const result = expandRecurrence(template, [], '2026-03-29T00:00:00Z', '2026-03-30T00:00:00Z');
      expect(result.occurrences.length).toBe(0);
      expect(result.nonexistentLocalDates).toEqual(['2026-03-29']);
    });

    test('fall-back repeat: the wall clock denotes its first occurrence by default, not both', () => {
      // daily_02_30_europe_belgrade — recurrence-dst-repeat-001, refined by #657's acceptance
      // criteria: "a repeated wall time denotes its first occurrence unless an explicit
      // additional date selects the other instant."
      const template = makeTemplate({
        start_at: '2026-01-01T01:30:00Z',
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=DAILY;COUNT=400',
      });
      const result = expandRecurrence(template, [], '2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z');
      expect(result.occurrences.length).toBe(1);
      expect(result.ambiguousLocalDates).toEqual(['2026-10-25']);
      // CEST (first instant, UTC+2), not the later CET (second) instant.
      expect(result.occurrences[0]!.occurrence_start).toBe('2026-10-25T00:30:00.000Z');
    });

    test('#657 acceptance: Belgrade daily 02:30 COUNT=3 from 2026-03-28 skips the gap without consuming a repetition', () => {
      const template = makeTemplate({
        start_at: '2026-03-28T01:30:00Z', // 02:30 Belgrade (CET, winter, still before the transition)
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=DAILY;COUNT=3',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-03-01T00:00:00Z', '2026-04-30T00:00:00Z');
      const localDates = occurrences.map((o) => o.occurrence_start.slice(0, 10));
      // March 28, 30, 31 — March 29 (the nonexistent 02:30) is skipped and does NOT reduce the
      // series to 2 occurrences; a 4th raw step (March 31) fills in for it.
      expect(occurrences.length).toBe(3);
      expect(localDates).not.toContain('2026-03-29');
      // Verify the exact local dates via each occurrence's own zone-correct offset.
      const offsets = occurrences.map((o) => new Date(o.occurrence_start).getUTCHours());
      expect(offsets).toEqual([1, 0, 0]); // 02:30 CET=01:30Z (Mar28), 02:30 CEST=00:30Z (Mar30, Mar31)
    });

    test('COUNT detection is not sensitive to RRULE parameter order (RFC 5545 imposes none)', () => {
      // review finding: COUNT was only detected when preceded by ";" — a rule with COUNT as
      // the FIRST parameter (immediately after the "RRULE:" prefix, e.g. from ICS import or
      // the AI tool, which don't enforce a canonical order) silently fell through to the
      // windowed rrule path, which lets rrule's own COUNT cutoff consume the DST gap.
      const template = makeTemplate({
        start_at: '2026-03-28T01:30:00Z',
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'RRULE:COUNT=3;FREQ=DAILY',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-03-01T00:00:00Z', '2026-04-30T00:00:00Z');
      const localDates = occurrences.map((o) => o.occurrence_start.slice(0, 10));
      expect(occurrences.length).toBe(3);
      expect(localDates).not.toContain('2026-03-29');
    });

    test('#657 acceptance: Belgrade daily 02:30 COUNT=3 from 2026-10-24 returns exactly three, not four', () => {
      const template = makeTemplate({
        start_at: '2026-10-24T00:30:00Z', // 02:30 Belgrade (CEST, summer, still before the transition)
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=DAILY;COUNT=3',
      });
      const { occurrences, ambiguousLocalDates } = expandRecurrence(
        template,
        [],
        '2026-10-01T00:00:00Z',
        '2026-11-30T00:00:00Z',
      );
      expect(occurrences.length).toBe(3);
      expect(ambiguousLocalDates).toEqual(['2026-10-25']);
      const localDates = occurrences.map((o) => o.occurrence_start.slice(0, 10));
      expect(localDates).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
      // Oct 25 resolves to its first (earlier) candidate instant, not both.
      expect(occurrences[1]!.occurrence_start).toBe('2026-10-25T00:30:00.000Z');
    });
  });

  describe('BYHOUR multi-value (spec §1.7 — two distinct times of day, not a collapsed duplicate)', () => {
    test('BYHOUR=10,14 produces two distinct occurrences, not "10:00 twice"', () => {
      const template = makeTemplate({
        start_at: '2026-10-01T10:00:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=DAILY;COUNT=2;BYHOUR=10,14',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-09-30T00:00:00Z', '2026-10-05T00:00:00Z');
      expect(occurrences.map((o) => o.occurrence_start)).toEqual([
        '2026-10-01T10:00:00.000Z',
        '2026-10-01T14:00:00.000Z',
      ]);
    });

    test('BYHOUR=10,14 stays distinct through DST-aware timezone expansion too', () => {
      const template = makeTemplate({
        start_at: '2026-01-01T09:00:00Z', // 10:00 Belgrade winter
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'FREQ=DAILY;COUNT=2;BYHOUR=10,14',
      });
      const { occurrences } = expandRecurrence(template, [], '2025-12-31T00:00:00Z', '2026-01-03T00:00:00Z');
      expect(occurrences.map((o) => o.occurrence_start)).toEqual([
        '2026-01-01T09:00:00.000Z', // 10:00 CET
        '2026-01-01T13:00:00.000Z', // 14:00 CET
      ]);
    });
  });

  describe('EXDATE (spec §1.2/§2 — honored, not silently dropped)', () => {
    test('a single EXDATE excludes exactly that occurrence', () => {
      // weekly_dtstart_2026-01-06T10:00Z_count6, recurrence-exdate-001
      const template = makeTemplate({
        start_at: '2026-01-06T10:00:00Z',
        recurrence_rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6\nEXDATE:20260113T100000Z',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z');
      const dates = occurrences.map((o) => o.occurrence_start.slice(0, 10));
      expect(dates).toEqual(['2026-01-06', '2026-01-20', '2026-01-27', '2026-02-03', '2026-02-10']);
      expect(dates).not.toContain('2026-01-13');
    });

    test('multiple EXDATE lines all apply', () => {
      // recurrence-exdate-002
      const template = makeTemplate({
        start_at: '2026-01-06T10:00:00Z',
        recurrence_rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6\nEXDATE:20260113T100000Z\nEXDATE:20260127T100000Z',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z');
      const dates = occurrences.map((o) => o.occurrence_start.slice(0, 10));
      expect(dates).not.toContain('2026-01-13');
      expect(dates).not.toContain('2026-01-27');
      expect(dates.length).toBe(4);
    });

    test('all-day EXDATE uses calendar-date exclusion, not a UTC-instant match', () => {
      // recurrence-allday-exdate-001
      const template = makeTemplate({
        start_at: '2026-01-01T00:00:00Z',
        all_day: 1,
        recurrence_rule: 'RRULE:FREQ=MONTHLY;COUNT=6\nEXDATE:20260301',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z');
      const dates = occurrences.map((o) => o.occurrence_start.slice(0, 10));
      expect(dates).not.toContain('2026-03-01');
      expect(dates.length).toBe(5);
    });

    test('EXDATE;TZID on a summer occurrence removes it across the DST switch (RFC 5545 §3.8.5.1)', () => {
      // Template 12:30 Belgrade in winter (CET); EXDATE given as local 12:30 on a CEST Monday.
      const template = makeTemplate({
        start_at: '2026-03-23T11:30:00Z',
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'RRULE:FREQ=WEEKLY;COUNT=4\nEXDATE;TZID=Europe/Belgrade:20260406T123000',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-03-01T00:00:00Z', '2026-05-01T00:00:00Z');
      expect(occurrences.map((o) => o.occurrence_start)).toEqual([
        '2026-03-23T11:30:00.000Z',
        '2026-03-30T10:30:00.000Z',
        '2026-04-13T10:30:00.000Z',
      ]);
    });

    test('all-day series across DST keeps calendar dates; EXDATE/RDATE;VALUE=DATE apply by date', () => {
      const template = makeTemplate({
        start_at: '2026-03-23T00:00:00Z',
        all_day: 1,
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'RRULE:FREQ=WEEKLY;COUNT=3\nEXDATE;VALUE=DATE:20260330\nRDATE;VALUE=DATE:20260402',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-03-01T00:00:00Z', '2026-05-01T00:00:00Z');
      expect(occurrences.map((o) => o.occurrence_start.slice(0, 10))).toEqual([
        '2026-03-23',
        '2026-04-02',
        '2026-04-06',
      ]);
    });
  });

  describe('RDATE (spec §1.2/§2 — honored, not silently dropped)', () => {
    test('a single RDATE adds exactly one extra occurrence', () => {
      // recurrence-rdate-001
      const template = makeTemplate({
        start_at: '2026-01-06T10:00:00Z',
        recurrence_rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6\nRDATE:20260301T100000Z',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-05T00:00:00Z');
      expect(occurrences.length).toBe(7);
      expect(occurrences.map((o) => o.occurrence_start.slice(0, 10))).toContain('2026-03-01');
    });

    test('a comma-separated RDATE list adds every listed date', () => {
      // recurrence-rdate-002
      const template = makeTemplate({
        start_at: '2026-01-06T10:00:00Z',
        recurrence_rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6\nRDATE:20260301T100000Z,20260308T100000Z',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-10T00:00:00Z');
      const dates = occurrences.map((o) => o.occurrence_start.slice(0, 10));
      expect(dates).toContain('2026-03-01');
      expect(dates).toContain('2026-03-08');
      expect(occurrences.length).toBe(8);
    });

    test('RDATE value type mismatched with DTSTART is rejected, not coerced', () => {
      // recurrence-rdate-003
      const template = makeTemplate({
        start_at: '2026-01-06T10:00:00Z',
        recurrence_rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6\nRDATE:20260301',
      });
      expect(() => expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-05T00:00:00Z')).toThrow(
        RecurrenceUnsupportedError,
      );
    });
  });

  describe('explicit unsupported rejects (spec §9)', () => {
    test('multiple RRULE lines throw, not silently first-wins', () => {
      const template = makeTemplate({
        recurrence_rule: 'RRULE:FREQ=WEEKLY;COUNT=6\nRRULE:FREQ=DAILY;COUNT=3',
      });
      try {
        expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z');
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RecurrenceUnsupportedError);
        expect((err as RecurrenceUnsupportedError).reason).toBe('multi_rrule_unsupported');
      }
    });

    test('EXRULE throws, not applied', () => {
      const template = makeTemplate({
        recurrence_rule: 'RRULE:FREQ=WEEKLY;COUNT=6\nEXRULE:FREQ=WEEKLY;COUNT=2',
      });
      expect(() => expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z')).toThrow(
        RecurrenceUnsupportedError,
      );
    });
  });

  describe('exception identity (spec §5 — exact original instant, not a calendar day)', () => {
    test('exact-instant match applies the exception; a second same-day occurrence is untouched', () => {
      // recurrence-exception-identity-001: same local date, two distinct instants (BYHOUR),
      // only the one with a matching original_start_at gets the exception.
      const template = makeTemplate({
        start_at: '2026-01-06T10:00:00Z',
        recurrence_rule: 'FREQ=DAILY;COUNT=2;BYHOUR=10,14',
      });
      const exceptions = [
        makeException({
          title: 'Moved 14:00',
          original_start_at: '2026-01-06T14:00:00Z',
          start_at: '2026-01-06T15:00:00Z',
        }),
      ];
      const { occurrences } = expandRecurrence(template, exceptions, '2026-01-06T00:00:00Z', '2026-01-07T00:00:00Z');
      expect(occurrences.length).toBe(2);
      const at10 = occurrences.find((o) => o.occurrence_start === '2026-01-06T10:00:00.000Z');
      const moved = occurrences.find((o) => o.is_exception);
      expect(at10?.is_exception).toBe(false);
      expect(moved?.event.title).toBe('Moved 14:00');
      expect(moved?.occurrence_start).toBe('2026-01-06T15:00:00Z');
    });

    test('an exception whose original_start_at does not exactly match any generated instant is not silently attached', () => {
      const template = makeTemplate({ start_at: '2026-01-06T10:00:00Z', recurrence_rule: 'FREQ=WEEKLY' });
      // Off by one second from the real occurrence instant — a genuinely resolved exception
      // never has this (the identity migration writes the exact instant), but the expander
      // must not fuzzy-match by calendar day.
      const exceptions = [makeException({ title: 'Should not attach', original_start_at: '2026-01-06T10:00:01Z' })];
      const { occurrences } = expandRecurrence(template, exceptions, '2026-01-06T00:00:00Z', '2026-01-06T23:59:59Z');
      expect(occurrences.length).toBe(1);
      expect(occurrences[0]!.is_exception).toBe(false);
    });

    test('identity_status "unresolved" exceptions are never attached to a guessed occurrence', () => {
      // recurrence-exception-identity-004
      const template = makeTemplate({ start_at: '2026-01-06T10:00:00Z', recurrence_rule: 'FREQ=WEEKLY' });
      const exceptions = [
        makeException({
          title: 'Ambiguous legacy row',
          original_start_at: '2026-01-06T10:00:00Z', // even if it happens to match exactly
          identity_status: 'unresolved',
        }),
      ];
      const { occurrences, unresolvedExceptionIds } = expandRecurrence(
        template,
        exceptions,
        '2026-01-06T00:00:00Z',
        '2026-01-06T23:59:59Z',
      );
      // The template occurrence is untouched...
      expect(occurrences.find((o) => o.occurrence_start === '2026-01-06T10:00:00.000Z')?.is_exception).toBe(false);
      // ...but the unresolved row's own current start_at is still shown (its own start_at is
      // 2026-01-06T10:00:00Z inherited from makeException/makeTemplate defaults, so it appears
      // via the "own start_at" pass) and reported as unresolved for diagnostics.
      expect(unresolvedExceptionIds).toEqual([2]);
    });
  });

  describe('moved exceptions in/out of the query range (spec §5)', () => {
    test('an occurrence moved INTO the requested range appears under its new start_at', () => {
      // recurrence-move-into-range-001/002
      const template = makeTemplate({ start_at: '2026-01-06T10:00:00Z', recurrence_rule: 'FREQ=WEEKLY' });
      const exceptions = [
        makeException({
          title: 'Moved earlier',
          original_start_at: '2026-05-05T10:00:00Z', // template occurrence on that date, outside query window
          start_at: '2026-02-01T10:00:00Z', // moved into the query window
        }),
      ];

      const inNewRange = expandRecurrence(template, exceptions, '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z');
      expect(inNewRange.occurrences.some((o) => o.is_exception && o.event.title === 'Moved earlier')).toBe(true);

      const atOldTemplateDate = expandRecurrence(template, exceptions, '2026-05-05T00:00:00Z', '2026-05-06T00:00:00Z');
      // The template date is not shown once the exception moved elsewhere — this requires the
      // template to actually generate an occurrence there, which a plain weekly rule anchored
      // at 2026-01-06 does on 2026-05-05 (18 weeks later); the exact match then suppresses it.
      expect(atOldTemplateDate.occurrences.some((o) => o.event.title === 'Moved earlier')).toBe(false);
    });

    test('an occurrence moved OUT of the requested range disappears, not shown at both places', () => {
      // recurrence-move-out-of-range-001/002
      const template = makeTemplate({ start_at: '2026-01-06T10:00:00Z', recurrence_rule: 'FREQ=WEEKLY' });
      const exceptions = [
        makeException({
          title: 'Moved later',
          original_start_at: '2026-01-13T10:00:00Z', // inside the query window below
          start_at: '2026-06-02T10:00:00Z', // moved far outside it
        }),
      ];

      const originalRange = expandRecurrence(template, exceptions, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
      expect(originalRange.occurrences.some((o) => o.event.title === 'Moved later')).toBe(false);
      // The template's Jan 13 slot is also not double-shown as an unmodified occurrence.
      expect(originalRange.occurrences.filter((o) => o.occurrence_start.startsWith('2026-01-13')).length).toBe(0);

      const newRange = expandRecurrence(template, exceptions, '2026-06-02T00:00:00Z', '2026-06-03T00:00:00Z');
      expect(newRange.occurrences.some((o) => o.event.title === 'Moved later')).toBe(true);
    });
  });

  describe('cross-midnight occurrences (spec §4)', () => {
    test('an occurrence spanning midnight is visible when the queried range covers its start', () => {
      const template = makeTemplate({
        start_at: '2026-01-06T23:00:00Z',
        end_at: '2026-01-07T01:30:00Z',
        recurrence_rule: 'FREQ=DAILY;COUNT=1',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-01-06T00:00:00Z', '2026-01-07T00:00:00Z');
      expect(occurrences.length).toBe(1);
      expect(occurrences[0]!.occurrence_start).toBe('2026-01-06T23:00:00.000Z');
      expect(occurrences[0]!.occurrence_end).toBe('2026-01-07T01:30:00.000Z');
    });
  });

  describe('capability-gated rollback (spec §10)', () => {
    test('flag off + no EXDATE/RDATE behaves identically to current production (no regression)', () => {
      // recurrence-rollback-001
      const template = makeTemplate({
        start_at: '2026-01-06T10:00:00Z',
        recurrence_rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z', {
        legacyEngine: true,
      });
      expect(occurrences.map((o) => o.occurrence_start.slice(0, 10))).toEqual([
        '2026-01-06',
        '2026-01-13',
        '2026-01-20',
        '2026-01-27',
        '2026-02-03',
        '2026-02-10',
      ]);
    });

    test('flag off + EXDATE/RDATE-bearing series keeps production behavior instead of vanishing', () => {
      // recurrence-rollback-002: Google-synced series already store EXDATE lines; with the new
      // engine off they must still display (EXDATE/RDATE ignored, as on main), not be dropped.
      const template = makeTemplate({
        start_at: '2026-01-06T10:00:00Z',
        recurrence_rule: 'RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=6\nEXDATE:20260113T100000Z\nRDATE:20260301T100000Z',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-05T00:00:00Z', {
        legacyEngine: true,
      });
      expect(occurrences.map((o) => o.occurrence_start.slice(0, 10))).toEqual([
        '2026-01-06',
        '2026-01-13',
        '2026-01-20',
        '2026-01-27',
        '2026-02-03',
        '2026-02-10',
      ]);
    });

    test('flag off keeps the template local wall-clock across DST (same as main)', () => {
      // 12:30 Belgrade: 11:30Z in CET, 10:30Z in CEST — the legacy engine must not anchor on
      // the UTC hour (which would shift every occurrence by the zone offset).
      const template = makeTemplate({
        start_at: '2026-03-16T11:30:00Z',
        timezone: 'Europe/Belgrade',
        recurrence_rule: 'RRULE:FREQ=WEEKLY;COUNT=4',
      });
      const { occurrences } = expandRecurrence(template, [], '2026-03-01T00:00:00Z', '2026-05-01T00:00:00Z', {
        legacyEngine: true,
      });
      expect(occurrences.map((o) => o.occurrence_start)).toEqual([
        '2026-03-16T11:30:00.000Z',
        '2026-03-23T11:30:00.000Z',
        '2026-03-30T10:30:00.000Z',
        '2026-04-06T10:30:00.000Z',
      ]);
    });
  });
});
