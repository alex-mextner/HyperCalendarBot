// Synthetic agenda fixtures shared by presentation tests and Chromium previews.
import type { CalendarEvent, EventOccurrence } from '../../src/database/types.ts';
export function agendaEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    user_id: 123,
    title: 'Test Event',
    description: null,
    category: null,
    start_at: '2026-03-11T09:00:00Z',
    end_at: '2026-03-11T10:00:00Z',
    all_day: 0,
    timezone: 'Europe/Kyiv',
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
    sync_status: 'local_only' as const,
    sync_version: 0,
    resolved_address: null,
    latitude: null,
    longitude: null,
    google_maps_url: null,
    location_verified: 0,
    venue_name: null,
    last_synced_at: null,
    created_at: '2026-03-11T08:00:00Z',
    updated_at: '2026-03-11T08:00:00Z',
    owner_type: 'user',
    group_id: null,
    created_by: null,
    ...overrides,
  };
}

export function agendaOccurrences(): EventOccurrence[] {
  return Array.from({ length: 8 }, (_, i) => {
    const event = agendaEvent({
      id: i + 1,
      title: `Synthetic session ${i + 1} <planning>`,
      description: 'DESCRIPTION_ONLY_TEXT <script>alert("fixture")</script> & notes',
      location: i === 7 ? 'LongLocation'.repeat(35) : 'Studio <East> & conference room, second floor',
      displayMetadata: { invitationStatus: 'Accepted: Alex & Sam; Pending: Jo <guest>' },
      all_day: i === 0 ? 1 : 0,
      start_at: '2026-03-11T09:00:00Z',
      end_at: '2026-03-11T09:05:00Z',
    });
    return { event, occurrence_start: event.start_at, occurrence_end: event.end_at, is_exception: false };
  });
}
