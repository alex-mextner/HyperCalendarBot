import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

const OWNER_ID = 100;
const REQUESTER_ID = 200;
const START = '2026-04-01T09:00:00Z';
const END = '2026-04-01T10:00:00Z';

function createTestDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}

describe('findVisibleOverlapping - privacy filtering', () => {
  let db: Database;
  let events: EventRepository;
  let sharingSettings: SharingSettingsRepository;

  beforeEach(() => {
    db = createTestDb();
    events = new EventRepository(db);
    sharingSettings = new SharingSettingsRepository(db);
    new UserRepository(db).create({ telegram_id: OWNER_ID });
    new UserRepository(db).create({ telegram_id: REQUESTER_ID });
  });

  function createEvent() {
    return events.create({
      user_id: OWNER_ID,
      title: 'Secret Meeting',
      start_at: START,
      end_at: END,
      all_day: false,
      timezone: 'UTC',
    });
  }

  test('without requesterId returns all visible events', () => {
    createEvent();
    sharingSettings.ensureDefaults(OWNER_ID);
    sharingSettings.update(OWNER_ID, { default_visibility: 'private' });
    const result = events.findVisibleOverlapping(OWNER_ID, '2026-04-01T08:00:00Z', '2026-04-01T11:00:00Z');
    expect(result).toHaveLength(1);
  });

  test('owner as requester always sees own private events', () => {
    createEvent();
    sharingSettings.ensureDefaults(OWNER_ID);
    sharingSettings.update(OWNER_ID, { default_visibility: 'private' });
    const result = events.findVisibleOverlapping(OWNER_ID, '2026-04-01T08:00:00Z', '2026-04-01T11:00:00Z', OWNER_ID);
    expect(result).toHaveLength(1);
  });

  test('requester cannot see private event (default_visibility = private)', () => {
    createEvent();
    sharingSettings.ensureDefaults(OWNER_ID);
    sharingSettings.update(OWNER_ID, { default_visibility: 'private' });
    const result = events.findVisibleOverlapping(
      OWNER_ID,
      '2026-04-01T08:00:00Z',
      '2026-04-01T11:00:00Z',
      REQUESTER_ID,
    );
    expect(result).toHaveLength(0);
  });

  test('requester sees event when default_visibility = full', () => {
    createEvent();
    sharingSettings.ensureDefaults(OWNER_ID);
    sharingSettings.update(OWNER_ID, { default_visibility: 'full' });
    const result = events.findVisibleOverlapping(
      OWNER_ID,
      '2026-04-01T08:00:00Z',
      '2026-04-01T11:00:00Z',
      REQUESTER_ID,
    );
    expect(result).toHaveLength(1);
  });

  test('per-event private override hides event even if default is full', () => {
    const ev = createEvent();
    sharingSettings.ensureDefaults(OWNER_ID);
    sharingSettings.update(OWNER_ID, { default_visibility: 'full' });
    sharingSettings.setEventVisibility(ev.id, 'private');
    const result = events.findVisibleOverlapping(
      OWNER_ID,
      '2026-04-01T08:00:00Z',
      '2026-04-01T11:00:00Z',
      REQUESTER_ID,
    );
    expect(result).toHaveLength(0);
  });

  test('per-event free_busy override shows event to requester', () => {
    const ev = createEvent();
    sharingSettings.ensureDefaults(OWNER_ID);
    sharingSettings.update(OWNER_ID, { default_visibility: 'private' });
    sharingSettings.setEventVisibility(ev.id, 'free_busy');
    const result = events.findVisibleOverlapping(
      OWNER_ID,
      '2026-04-01T08:00:00Z',
      '2026-04-01T11:00:00Z',
      REQUESTER_ID,
    );
    expect(result).toHaveLength(1);
  });

  test('no sharing_settings row defaults to full visibility', () => {
    createEvent();
    const result = events.findVisibleOverlapping(
      OWNER_ID,
      '2026-04-01T08:00:00Z',
      '2026-04-01T11:00:00Z',
      REQUESTER_ID,
    );
    expect(result).toHaveLength(1);
  });
});
