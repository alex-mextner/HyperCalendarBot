// test/database/repositories/birthday-metadata.repository.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { BirthdayMetadataRepository } from '../../../src/database/repositories/birthday-metadata.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

let db: Database;
let repo: BirthdayMetadataRepository;
let eventRepo: EventRepository;
let eventId: number;

function createTestDb(): Database {
  const d = new Database(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
  runMigrations(d, migrations);
  return d;
}

beforeEach(() => {
  db = createTestDb();
  repo = new BirthdayMetadataRepository(db);
  eventRepo = new EventRepository(db);
  db.prepare("INSERT INTO users (telegram_id, first_name, language, timezone) VALUES (1, 'Alice', 'en', 'UTC')").run();
  const event = eventRepo.create({
    user_id: 1,
    title: 'Д/р Bob',
    start_at: '2026-05-10T00:00:00Z',
    all_day: true,
    timezone: 'UTC',
    event_type: 'birthday',
  });
  eventId = event.id;
});

test('upsertMetadata creates and reads row', () => {
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: 1990, auto_created: 1 });
  const row = repo.findByEventId(eventId);
  expect(row?.celebrant_id).toBe(42);
  expect(row?.birth_year).toBe(1990);
  expect(row?.auto_created).toBe(1);
});

test('upsertMetadata updates on conflict', () => {
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: 1990, auto_created: 1 });
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: 1991, auto_created: 0 });
  const row = repo.findByEventId(eventId);
  expect(row?.birth_year).toBe(1991);
});

test('findByCelebrantAndOwner returns matching row', () => {
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: null, auto_created: 1 });
  const result = repo.findByCelebrantAndOwner(42, 1);
  expect(result?.event_id).toBe(eventId);
});

test('findByCelebrantAndOwner returns null for wrong owner', () => {
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: null, auto_created: 1 });
  const result = repo.findByCelebrantAndOwner(42, 999);
  expect(result).toBeNull();
});

test('upsertSyncState and getSyncState round-trip', () => {
  repo.upsertSyncState(1, '2026-03-20T10:00:00Z');
  const state = repo.getSyncState(1);
  expect(state?.synced_at).toBe('2026-03-20T10:00:00Z');
});

test('getUsersNeedingSync includes users with no sync state', () => {
  const users = repo.getUsersNeedingSync(7 * 24 * 60 * 60 * 1000);
  expect(users).toContain(1);
});

test('getUsersNeedingSync excludes recently synced users', () => {
  repo.upsertSyncState(1, new Date().toISOString());
  const users = repo.getUsersNeedingSync(7 * 24 * 60 * 60 * 1000);
  expect(users).not.toContain(1);
});
