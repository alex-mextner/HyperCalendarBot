// test/services/event/event-display.test.ts
import { describe, expect, test } from 'bun:test';
import type { CalendarEvent, EventOccurrence } from '../../../src/database/types.ts';
import {
  buildCanonicalEventCard,
  buildEventPicker,
  decideEventDisplay,
  eventAtOccurrenceStart,
  eventForOccurrence,
} from '../../../src/services/event/event-display.ts';
import { formatEventDetail } from '../../../src/services/event/formatters.ts';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    user_id: 123,
    title: 'Test Event',
    description: null,
    category: null,
    start_at: '2026-03-11T09:00:00Z',
    end_at: '2026-03-11T10:00:00Z',
    all_day: 0,
    timezone: 'UTC',
    location: null,
    recurrence_rule: null,
    recurrence_end_at: null,
    parent_event_id: null,
    original_start_at: null,
    is_cancelled: 0,
    is_deleted: 0,
    reminder_overrides: null,
    google_event_id: null,
    google_calendar_id: null,
    google_etag: null,
    sync_status: 'local_only',
    sync_version: 1,
    owner_type: 'user',
    group_id: null,
    created_by: null,
    resolved_address: null,
    latitude: null,
    longitude: null,
    google_maps_url: null,
    location_verified: 0,
    venue_name: null,
    last_synced_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeOccurrence(
  overrides: Partial<CalendarEvent> = {},
  occStart?: string,
  occEnd?: string | null,
): EventOccurrence {
  const event = makeEvent(overrides);
  return {
    event,
    occurrence_start: occStart ?? event.start_at,
    occurrence_end: occEnd === undefined ? event.end_at : occEnd,
    is_exception: false,
  };
}

describe('eventForOccurrence', () => {
  test('projects occurrence start/end onto a copy, leaving other fields alone', () => {
    const occ = makeOccurrence(
      {
        id: 5,
        title: 'Standup',
        recurrence_rule: 'FREQ=WEEKLY',
        start_at: '2026-03-11T09:00:00Z',
        end_at: '2026-03-11T09:30:00Z',
      },
      '2026-03-18T09:00:00Z',
      '2026-03-18T09:30:00Z',
    );
    const projected = eventForOccurrence(occ);
    expect(projected.start_at).toBe('2026-03-18T09:00:00Z');
    expect(projected.end_at).toBe('2026-03-18T09:30:00Z');
    expect(projected.title).toBe('Standup');
    expect(projected.recurrence_rule).toBe('FREQ=WEEKLY');
    // Pure: the source occurrence's event is untouched.
    expect(occ.event.start_at).toBe('2026-03-11T09:00:00Z');
  });

  test('falls back to the template end when the occurrence has none (open-ended)', () => {
    const occ = makeOccurrence({ end_at: '2026-03-11T10:00:00Z' }, '2026-03-18T09:00:00Z', null);
    expect(eventForOccurrence(occ).end_at).toBe('2026-03-11T10:00:00Z');
  });
});

describe('eventAtOccurrenceStart', () => {
  test('shifts start and preserves the template duration', () => {
    const event = makeEvent({ start_at: '2026-03-11T09:00:00Z', end_at: '2026-03-11T09:30:00Z' });
    const projected = eventAtOccurrenceStart(event, '2026-03-18T09:00:00Z');
    expect(projected.start_at).toBe('2026-03-18T09:00:00Z');
    expect(projected.end_at).toBe('2026-03-18T09:30:00.000Z');
  });

  test('leaves a null end_at as null', () => {
    const event = makeEvent({ end_at: null });
    expect(eventAtOccurrenceStart(event, '2026-03-18T09:00:00Z').end_at).toBeNull();
  });

  test('is pure: never mutates the input event', () => {
    const event = makeEvent({ start_at: '2026-03-11T09:00:00Z' });
    eventAtOccurrenceStart(event, '2026-03-18T09:00:00Z');
    expect(event.start_at).toBe('2026-03-11T09:00:00Z');
  });
});

describe('buildCanonicalEventCard', () => {
  test('text matches formatEventDetail exactly (single source of truth)', () => {
    const event = makeEvent({ id: 42, title: 'Retro' });
    const card = buildCanonicalEventCard(event, 'UTC', 'en');
    expect(card.text).toBe(formatEventDetail(event, 'UTC', 'en'));
  });

  test('no occurrenceDate → plain event-actions keyboard (id-only payload)', () => {
    const event = makeEvent({ id: 42 });
    const card = buildCanonicalEventCard(event, 'UTC', 'en');
    const payloads = JSON.stringify(card.keyboard);
    expect(payloads).toContain('"ee:42"');
    expect(payloads).toContain('"ed:42"');
    expect(payloads).not.toContain(':2026');
  });

  test('occurrenceDate set → occurrence-scoped keyboard payload', () => {
    const event = makeEvent({ id: 42 });
    const card = buildCanonicalEventCard(event, 'UTC', 'en', '2026-03-18T09:00:00Z');
    const payloads = JSON.stringify(card.keyboard);
    expect(payloads).toContain('ee:42:2026-03-18T09:00:00Z');
    expect(payloads).toContain('ed:42:2026-03-18T09:00:00Z');
  });
});

describe('buildEventPicker', () => {
  test('labels each button with the occurrence time, not the template hour', () => {
    const occs = [
      makeOccurrence({ id: 1, title: 'Standup' }, '2026-03-18T09:00:00Z'),
      makeOccurrence({ id: 2, title: 'Retro' }, '2026-03-18T15:00:00Z'),
    ];
    const kb = buildEventPicker(occs, 'UTC', 'ev', 'en');
    const text = JSON.stringify(kb);
    expect(text).toContain('09:00');
    expect(text).toContain('15:00');
  });

  test('each row payload carries id:occurrenceStart, not just the event id', () => {
    const occs = [makeOccurrence({ id: 7 }, '2026-03-18T09:00:00Z')];
    const kb = buildEventPicker(occs, 'UTC', 'ev', 'en');
    expect(JSON.stringify(kb)).toContain('"ev:7:2026-03-18T09:00:00Z"');
  });
});

describe('decideEventDisplay', () => {
  test('no occurrences → empty', () => {
    expect(decideEventDisplay([])).toEqual({ kind: 'empty' });
  });

  test('exactly one occurrence → single, with its occurrence date', () => {
    const occ = makeOccurrence({ id: 7 }, '2026-03-18T09:00:00Z', '2026-03-18T09:30:00Z');
    const decision = decideEventDisplay([occ]);
    expect(decision.kind).toBe('single');
    if (decision.kind === 'single') {
      expect(decision.event.id).toBe(7);
      expect(decision.event.start_at).toBe('2026-03-18T09:00:00Z');
      expect(decision.occurrenceDate).toBe('2026-03-18T09:00:00Z');
    }
  });

  test('two or more occurrences → multiple, never the first guess', () => {
    const occs = [makeOccurrence({ id: 1 }, '2026-03-18T09:00:00Z'), makeOccurrence({ id: 2 }, '2026-03-18T15:00:00Z')];
    const decision = decideEventDisplay(occs);
    expect(decision).toEqual({ kind: 'multiple', occurrences: occs });
  });
});
