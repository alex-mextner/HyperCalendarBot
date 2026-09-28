// Structured, parameterized recurrence cases. Expected values are computed independently of
// the implementation under test:
//   - the DST gap/ambiguous matrix uses publicly documented IANA transition dates for 2026,
//     not anything derived from resolveWallClock/expandRecurrence;
//   - the daily/weekly arithmetic matrix uses a small local Date.UTC-based oracle (day-count
//     addition), never rrule or recurrence.ts;
//   - the EXDATE/RDATE position matrix and value-mismatch matrix assert against hand-picked
//     expected sets derived from the RRULE text itself.
import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '../../../src/database/types.ts';
import { expandRecurrence, RecurrenceUnsupportedError } from '../../../src/services/event/recurrence.ts';
import { resolveWallClock } from '../../../src/services/event/wall-clock.ts';

function makeTemplate(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    user_id: 123,
    title: 'Event',
    description: null,
    category: null,
    start_at: '2026-01-01T09:00:00Z',
    end_at: null,
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
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── DST gap/ambiguous matrix: publicly documented 2026 IANA transitions ──────────────────────
// (source: tz database rules — EU last-Sunday-of-March/October; US second-Sun-March/first-Sun-
// November; Southern Hemisphere zones transition on their own documented dates; fixed-offset
// zones never transition.)
interface DstCase {
  zone: string;
  springForwardGapDate: string | null; // YYYY-MM-DD, local date where the gap hour does not exist
  fallBackRepeatDate: string | null; // YYYY-MM-DD, local date where the repeat hour happens twice
  /** The hour (local) that does not exist on spring-forward. Most zones transition forward at
   * local 02:00 (gap = 02:00-02:59); the UK transitions at local 01:00 GMT (gap = 01:00-01:59)
   * even though the underlying UTC instant is the same moment as the rest of the EU. */
  gapHour: number;
  /** The hour (local) that repeats on fall-back. EU-convention zones transition at local 03:00
   * DST → 02:00 standard, so 02:00-02:59 repeats; US-convention (and the UK) zones transition
   * one hour earlier, so 01:00-01:59 repeats instead. */
  fallBackHour: number;
}

const DST_CASES: DstCase[] = [
  {
    zone: 'Europe/Belgrade',
    springForwardGapDate: '2026-03-29',
    fallBackRepeatDate: '2026-10-25',
    gapHour: 2,
    fallBackHour: 2,
  },
  {
    zone: 'Europe/Berlin',
    springForwardGapDate: '2026-03-29',
    fallBackRepeatDate: '2026-10-25',
    gapHour: 2,
    fallBackHour: 2,
  },
  {
    zone: 'Europe/London',
    springForwardGapDate: '2026-03-29',
    fallBackRepeatDate: '2026-10-25',
    gapHour: 1,
    fallBackHour: 1,
  },
  {
    zone: 'Europe/Madrid',
    springForwardGapDate: '2026-03-29',
    fallBackRepeatDate: '2026-10-25',
    gapHour: 2,
    fallBackHour: 2,
  },
  {
    zone: 'America/New_York',
    springForwardGapDate: '2026-03-08',
    fallBackRepeatDate: '2026-11-01',
    gapHour: 2,
    fallBackHour: 1,
  },
  {
    zone: 'America/Chicago',
    springForwardGapDate: '2026-03-08',
    fallBackRepeatDate: '2026-11-01',
    gapHour: 2,
    fallBackHour: 1,
  },
  {
    zone: 'America/Los_Angeles',
    springForwardGapDate: '2026-03-08',
    fallBackRepeatDate: '2026-11-01',
    gapHour: 2,
    fallBackHour: 1,
  },
  {
    zone: 'Australia/Sydney',
    springForwardGapDate: '2026-10-04',
    fallBackRepeatDate: '2026-04-05',
    gapHour: 2,
    fallBackHour: 2,
  },
  {
    zone: 'Pacific/Auckland',
    springForwardGapDate: '2026-09-27',
    fallBackRepeatDate: '2026-04-05',
    gapHour: 2,
    fallBackHour: 2,
  },
  // No DST — every reading is unique year-round.
  { zone: 'Asia/Tokyo', springForwardGapDate: null, fallBackRepeatDate: null, gapHour: 2, fallBackHour: 2 },
  { zone: 'Asia/Kolkata', springForwardGapDate: null, fallBackRepeatDate: null, gapHour: 2, fallBackHour: 2 },
  { zone: 'America/Sao_Paulo', springForwardGapDate: null, fallBackRepeatDate: null, gapHour: 2, fallBackHour: 2 }, // DST abolished 2019
  { zone: 'UTC', springForwardGapDate: null, fallBackRepeatDate: null, gapHour: 2, fallBackHour: 2 },
];

describe.each(DST_CASES)('DST matrix: $zone', ({
  zone,
  springForwardGapDate,
  fallBackRepeatDate,
  gapHour,
  fallBackHour,
}) => {
  test('the transition hour does not exist on the spring-forward date', () => {
    if (!springForwardGapDate) {
      const [y, mo, d] = '2026-03-15'.split('-').map(Number) as [number, number, number];
      expect(resolveWallClock({ y, mo, d, h: gapHour, mi: 30, s: 0 }, zone).kind).toBe('unique');
      return;
    }
    const [y, mo, d] = springForwardGapDate.split('-').map(Number) as [number, number, number];
    expect(resolveWallClock({ y, mo, d, h: gapHour, mi: 30, s: 0 }, zone).kind).toBe('gap');
  });

  test('the repeated local hour at the fall-back transition is ambiguous', () => {
    if (!fallBackRepeatDate) {
      const [y, mo, d] = '2026-11-15'.split('-').map(Number) as [number, number, number];
      expect(resolveWallClock({ y, mo, d, h: fallBackHour, mi: 30, s: 0 }, zone).kind).toBe('unique');
      return;
    }
    const [y, mo, d] = fallBackRepeatDate.split('-').map(Number) as [number, number, number];
    expect(resolveWallClock({ y, mo, d, h: fallBackHour, mi: 30, s: 0 }, zone).kind).toBe('ambiguous');
  });

  test('expandRecurrence through the gap/repeat day never throws and never duplicates an instant', () => {
    const boundaryDate = springForwardGapDate ?? fallBackRepeatDate ?? '2026-06-15';
    const template = makeTemplate({
      start_at: '2026-01-01T02:30:00Z',
      timezone: zone,
      recurrence_rule: 'FREQ=DAILY;COUNT=200',
    });
    const rangeStart = `${boundaryDate}T00:00:00Z`;
    const rangeEnd = new Date(new Date(rangeStart).getTime() + 24 * 3600_000).toISOString();
    const { occurrences } = expandRecurrence(template, [], rangeStart, rangeEnd);
    const instants = occurrences.map((o) => o.occurrence_start);
    expect(new Set(instants).size).toBe(instants.length); // no duplicate instant
  });
});

// ── Independent day-count oracle for DAILY/WEEKLY arithmetic ─────────────────────────────────
function addUtcDays(iso: string, days: number): string {
  const d = new Date(iso);
  return new Date(d.getTime() + days * 86_400_000).toISOString();
}

interface ArithmeticCase {
  label: string;
  startAt: string;
  freqLine: string;
  windowDays: number;
  expectedOffsetsDays: number[]; // offsets from startAt, independently listed
}

const ARITHMETIC_CASES: ArithmeticCase[] = [
  {
    label: 'daily interval 1, 10-day window',
    startAt: '2026-01-01T09:00:00Z',
    freqLine: 'FREQ=DAILY',
    windowDays: 10,
    expectedOffsetsDays: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  },
  {
    label: 'daily interval 2, 10-day window',
    startAt: '2026-01-01T09:00:00Z',
    freqLine: 'FREQ=DAILY;INTERVAL=2',
    windowDays: 10,
    expectedOffsetsDays: [0, 2, 4, 6, 8],
  },
  {
    label: 'daily interval 3, 10-day window',
    startAt: '2026-01-01T09:00:00Z',
    freqLine: 'FREQ=DAILY;INTERVAL=3',
    windowDays: 10,
    expectedOffsetsDays: [0, 3, 6, 9],
  },
  {
    label: 'weekly interval 1 across a month boundary',
    startAt: '2026-01-19T09:00:00Z',
    freqLine: 'FREQ=WEEKLY',
    windowDays: 28,
    expectedOffsetsDays: [0, 7, 14, 21],
  },
  {
    label: 'weekly interval 2 across a month boundary',
    startAt: '2026-01-19T09:00:00Z',
    freqLine: 'FREQ=WEEKLY;INTERVAL=2',
    windowDays: 28,
    expectedOffsetsDays: [0, 14],
  },
  {
    label: 'daily across a leap-year February boundary (2028)',
    startAt: '2028-02-27T09:00:00Z',
    freqLine: 'FREQ=DAILY',
    windowDays: 4,
    expectedOffsetsDays: [0, 1, 2, 3],
  },
  {
    label: 'daily across a non-leap-year February boundary (2026)',
    startAt: '2026-02-26T09:00:00Z',
    freqLine: 'FREQ=DAILY',
    windowDays: 4,
    expectedOffsetsDays: [0, 1, 2, 3],
  },
  {
    label: 'daily across a year boundary',
    startAt: '2026-12-29T09:00:00Z',
    freqLine: 'FREQ=DAILY',
    windowDays: 5,
    expectedOffsetsDays: [0, 1, 2, 3, 4],
  },
];

describe.each(ARITHMETIC_CASES)('arithmetic oracle: $label', ({
  startAt,
  freqLine,
  windowDays,
  expectedOffsetsDays,
}) => {
  test('matches the independently computed day-offset list exactly', () => {
    const template = makeTemplate({ start_at: startAt, timezone: 'UTC', recurrence_rule: freqLine });
    const rangeStart = startAt;
    const rangeEnd = new Date(new Date(addUtcDays(startAt, windowDays)).getTime() - 1).toISOString();
    const { occurrences } = expandRecurrence(template, [], rangeStart, rangeEnd);
    const expected = expectedOffsetsDays.map((offset) => addUtcDays(startAt, offset));
    expect(occurrences.map((o) => o.occurrence_start)).toEqual(expected);
  });
});

// ── EXDATE position matrix: first / middle / last / multiple occurrence excluded ─────────────
interface ExdatePositionCase {
  label: string;
  excludeOffsets: number[]; // which of the 6 weekly occurrences (0-indexed) to exclude
}

const EXDATE_POSITION_CASES: ExdatePositionCase[] = [
  { label: 'excludes the first occurrence', excludeOffsets: [0] },
  { label: 'excludes a middle occurrence', excludeOffsets: [2] },
  { label: 'excludes the last occurrence', excludeOffsets: [5] },
  { label: 'excludes first and last together', excludeOffsets: [0, 5] },
  { label: 'excludes three non-adjacent occurrences', excludeOffsets: [1, 3, 5] },
];

describe.each(EXDATE_POSITION_CASES)('EXDATE position matrix: $label', ({ excludeOffsets }) => {
  test('excludes exactly the targeted occurrences and no others', () => {
    const dtstart = '2026-01-06T10:00:00Z'; // Tuesday
    const weeklyDates = Array.from({ length: 6 }, (_, i) => addUtcDays(dtstart, i * 7));
    const exdateLines = excludeOffsets
      .map((i) => weeklyDates[i]!.replace(/[-:]/g, '').replace(/\.\d{3}/, ''))
      .map((token) => `EXDATE:${token}`)
      .join('\n');
    const template = makeTemplate({
      start_at: dtstart,
      timezone: 'UTC',
      recurrence_rule: `RRULE:FREQ=WEEKLY;COUNT=6\n${exdateLines}`,
    });
    const { occurrences } = expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z');
    const expected = weeklyDates.filter((_, i) => !excludeOffsets.includes(i));
    expect(occurrences.map((o) => o.occurrence_start)).toEqual(expected);
  });
});

// ── Value-type mismatch matrix (spec §9) ──────────────────────────────────────────────────────
interface MismatchCase {
  label: string;
  allDay: boolean;
  exceptionLine: string;
  shouldThrow: boolean;
}

const MISMATCH_CASES: MismatchCase[] = [
  {
    label: 'date-time series, date-time EXDATE — ok',
    allDay: false,
    exceptionLine: 'EXDATE:20260113T100000Z',
    shouldThrow: false,
  },
  {
    label: 'date-time series, date-only EXDATE — mismatch',
    allDay: false,
    exceptionLine: 'EXDATE:20260113',
    shouldThrow: true,
  },
  {
    label: 'all-day series, date-only EXDATE — ok',
    allDay: true,
    exceptionLine: 'EXDATE:20260113',
    shouldThrow: false,
  },
  {
    label: 'all-day series, date-time EXDATE — mismatch',
    allDay: true,
    exceptionLine: 'EXDATE:20260113T100000Z',
    shouldThrow: true,
  },
  {
    label: 'date-time series, date-time RDATE — ok',
    allDay: false,
    exceptionLine: 'RDATE:20260301T100000Z',
    shouldThrow: false,
  },
  { label: 'all-day series, date-only RDATE — ok', allDay: true, exceptionLine: 'RDATE:20260301', shouldThrow: false },
];

describe.each(MISMATCH_CASES)('value-type matrix: $label', ({ allDay, exceptionLine, shouldThrow }) => {
  test(shouldThrow ? 'throws value_type_mismatch' : 'does not throw', () => {
    const template = makeTemplate({
      start_at: allDay ? '2026-01-01T00:00:00Z' : '2026-01-06T10:00:00Z',
      all_day: allDay ? 1 : 0,
      timezone: allDay ? 'UTC' : 'UTC',
      recurrence_rule: `RRULE:FREQ=WEEKLY;COUNT=6\n${exceptionLine}`,
    });
    const run = () => expandRecurrence(template, [], '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z');
    if (shouldThrow) {
      expect(run).toThrow(RecurrenceUnsupportedError);
    } else {
      expect(run).not.toThrow();
    }
  });
});
