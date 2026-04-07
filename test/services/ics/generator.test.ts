// test/services/ics/generator.test.ts
import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from '../../../src/database/types.ts';
import { generateIcs } from '../../../src/services/ics/generator.ts';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    user_id: 123,
    title: 'Test Event',
    description: null,
    category: null,
    start_at: '2026-03-12T15:00:00Z',
    end_at: '2026-03-12T16:00:00Z',
    all_day: 0,
    timezone: 'UTC',
    location: null,
    recurrence_rule: null,
    recurrence_end_at: null,
    parent_event_id: null,
    original_start_at: null,
    is_cancelled: 0,
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
    last_synced_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('generateIcs', () => {
  test('generates valid ICS with VCALENDAR wrapper', () => {
    const ics = generateIcs([makeEvent()]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
  });

  test('includes event fields', () => {
    const ics = generateIcs([
      makeEvent({
        title: 'Dentist',
        description: 'Checkup',
        location: 'Clinic',
      }),
    ]);
    expect(ics).toContain('SUMMARY:Dentist');
    expect(ics).toContain('DESCRIPTION:Checkup');
    expect(ics).toContain('LOCATION:Clinic');
    expect(ics).toContain('DTSTART:20260312T150000Z');
    expect(ics).toContain('DTEND:20260312T160000Z');
  });

  test('includes RRULE if present', () => {
    const ics = generateIcs([makeEvent({ recurrence_rule: 'FREQ=DAILY' })]);
    expect(ics).toContain('RRULE:FREQ=DAILY');
  });

  test('handles multiple events', () => {
    const ics = generateIcs([makeEvent(), makeEvent({ id: 2, title: 'Other' })]);
    const count = (ics.match(/BEGIN:VEVENT/g) || []).length;
    expect(count).toBe(2);
  });
});
