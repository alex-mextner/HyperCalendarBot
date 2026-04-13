import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';
import type { CalendarEvent } from '../../src/database/types.ts';
import { DomainEventBus } from '../../src/services/scheduled/domain-event-bus.ts';
import { EventStartingChecker } from '../../src/worker/event-starting-checker.ts';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const now = new Date();
  return {
    id: 1,
    user_id: 1,
    title: 'Test',
    description: null,
    category: null,
    start_at: new Date(Date.now() + 30_000).toISOString(),
    end_at: null,
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
    sync_status: 'none',
    sync_version: 0,
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
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  } as CalendarEvent;
}

describe('EventStartingChecker', () => {
  test('emits eventStarting for upcoming non-all-day events', async () => {
    const db = makeDb();
    const bus = new DomainEventBus();
    const handler = mock(() => {});
    bus.on('myCalendar.eventStarting', handler);
    const getUpcoming = mock(() => [makeEvent()]);
    const checker = new EventStartingChecker(db, bus, getUpcoming);

    await checker.check();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('skips all_day events', async () => {
    const db = makeDb();
    const bus = new DomainEventBus();
    const handler = mock(() => {});
    bus.on('myCalendar.eventStarting', handler);
    const getUpcoming = mock(() => [makeEvent({ all_day: 1 })]);
    const checker = new EventStartingChecker(db, bus, getUpcoming);

    await checker.check();
    expect(handler).not.toHaveBeenCalled();
  });

  test('does not emit for already-notified events', async () => {
    const db = makeDb();
    const bus = new DomainEventBus();
    const handler = mock(() => {});
    bus.on('myCalendar.eventStarting', handler);
    const event = makeEvent();
    const getUpcoming = mock(() => [event]);
    const checker = new EventStartingChecker(db, bus, getUpcoming);

    await checker.check();
    expect(handler).toHaveBeenCalledTimes(1);

    await checker.check();
    expect(handler).toHaveBeenCalledTimes(1); // not called again
  });
});
