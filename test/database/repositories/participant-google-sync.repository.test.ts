import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ParticipantGoogleSyncRepository } from '../../../src/database/repositories/participant-google-sync.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

describe('ParticipantGoogleSyncRepository', () => {
  let db: Database;
  let repo: ParticipantGoogleSyncRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    db.run("INSERT INTO users (telegram_id, username) VALUES (1, 'owner')");
    db.run("INSERT INTO users (telegram_id, username) VALUES (2, 'participant')");
    db.run("INSERT INTO users (telegram_id, username) VALUES (3, 'participant2')");
    db.run(
      "INSERT INTO events (user_id, title, start_at, timezone) VALUES (1, 'Meeting', '2026-04-10T10:00:00Z', 'UTC')",
    );
    repo = new ParticipantGoogleSyncRepository(db);
  });

  test('upsert creates a new record', () => {
    repo.upsert(2, 1, { sync_status: 'pending_push' });
    const record = repo.getByUserAndEvent(2, 1);
    expect(record).not.toBeNull();
    expect(record!.user_id).toBe(2);
    expect(record!.event_id).toBe(1);
    expect(record!.sync_status).toBe('pending_push');
    expect(record!.google_calendar_id).toBe('primary');
  });

  test('upsert updates existing record on conflict', () => {
    repo.upsert(2, 1, { sync_status: 'pending_push' });
    repo.upsert(2, 1, {
      google_event_id: 'g-123',
      google_etag: '"etag"',
      sync_status: 'synced',
      last_synced_at: '2026-04-08T12:00:00Z',
    });
    const record = repo.getByUserAndEvent(2, 1);
    expect(record!.google_event_id).toBe('g-123');
    expect(record!.google_etag).toBe('"etag"');
    expect(record!.sync_status).toBe('synced');
  });

  test('getSyncedByEvent returns all records for event', () => {
    repo.upsert(2, 1, { sync_status: 'synced', google_event_id: 'g-1' });
    repo.upsert(3, 1, { sync_status: 'synced', google_event_id: 'g-2' });
    const records = repo.getSyncedByEvent(1);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.user_id).sort()).toEqual([2, 3]);
  });

  test('getSyncedByUser returns all records for user', () => {
    db.run(
      "INSERT INTO events (user_id, title, start_at, timezone) VALUES (1, 'Event 2', '2026-04-11T10:00:00Z', 'UTC')",
    );
    repo.upsert(2, 1, { sync_status: 'synced' });
    repo.upsert(2, 2, { sync_status: 'synced' });
    const records = repo.getSyncedByUser(2);
    expect(records).toHaveLength(2);
  });

  test('updateSyncFields updates specific fields', () => {
    repo.upsert(2, 1, { sync_status: 'pending_push' });
    repo.updateSyncFields(2, 1, {
      google_event_id: 'g-new',
      sync_status: 'synced',
      last_synced_at: '2026-04-08T14:00:00Z',
    });
    const record = repo.getByUserAndEvent(2, 1);
    expect(record!.google_event_id).toBe('g-new');
    expect(record!.sync_status).toBe('synced');
  });

  test('delete removes specific record', () => {
    repo.upsert(2, 1, { sync_status: 'synced' });
    repo.upsert(3, 1, { sync_status: 'synced' });
    repo.delete(2, 1);
    expect(repo.getByUserAndEvent(2, 1)).toBeNull();
    expect(repo.getByUserAndEvent(3, 1)).not.toBeNull();
  });

  test('deleteByEvent removes all records for event', () => {
    repo.upsert(2, 1, { sync_status: 'synced' });
    repo.upsert(3, 1, { sync_status: 'synced' });
    repo.deleteByEvent(1);
    expect(repo.getSyncedByEvent(1)).toHaveLength(0);
  });

  test('deleteByUser removes all records for user', () => {
    db.run(
      "INSERT INTO events (user_id, title, start_at, timezone) VALUES (1, 'Event 2', '2026-04-11T10:00:00Z', 'UTC')",
    );
    repo.upsert(2, 1, { sync_status: 'synced' });
    repo.upsert(2, 2, { sync_status: 'synced' });
    repo.deleteByUser(2);
    expect(repo.getSyncedByUser(2)).toHaveLength(0);
  });

  test('getByUserAndEvent returns null for non-existent', () => {
    expect(repo.getByUserAndEvent(999, 999)).toBeNull();
  });

  test('cascade delete on event removal', () => {
    repo.upsert(2, 1, { sync_status: 'synced' });
    db.run('DELETE FROM events WHERE id = 1');
    expect(repo.getByUserAndEvent(2, 1)).toBeNull();
  });

  test('cascade delete on user removal', () => {
    repo.upsert(2, 1, { sync_status: 'synced' });
    db.run('DELETE FROM users WHERE telegram_id = 2');
    expect(repo.getByUserAndEvent(2, 1)).toBeNull();
  });
});
