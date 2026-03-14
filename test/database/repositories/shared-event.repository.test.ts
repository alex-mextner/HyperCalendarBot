import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { SharedEventRepository } from '../../../src/database/repositories/shared-event.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('SharedEventRepository', () => {
  let db: Database;
  let repo: SharedEventRepository;
  let eventId: number;

  beforeEach(() => {
    db = createTestDb();
    repo = new SharedEventRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
    eventId = new EventRepository(db).create({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    }).id;
  });

  test('create stores shared event record', () => {
    const shared = repo.create({
      event_id: eventId,
      shared_by: USER_ID,
      shared_to_type: 'user',
      shared_to_id: 200,
      share_type: 'card',
    });
    expect(shared.id).toBeGreaterThan(0);
    expect(shared.shared_to_type).toBe('user');
  });

  test('getByEvent returns all shares for event', () => {
    repo.create({
      event_id: eventId,
      shared_by: USER_ID,
      shared_to_type: 'user',
      shared_to_id: 200,
      share_type: 'card',
    });
    repo.create({
      event_id: eventId,
      shared_by: USER_ID,
      shared_to_type: 'user',
      shared_to_id: 300,
      share_type: 'image',
    });
    expect(repo.getByEvent(eventId)).toHaveLength(2);
  });

  test('getByTarget returns shares for specific target', () => {
    repo.create({
      event_id: eventId,
      shared_by: USER_ID,
      shared_to_type: 'user',
      shared_to_id: 200,
      share_type: 'card',
    });
    repo.create({
      event_id: eventId,
      shared_by: USER_ID,
      shared_to_type: 'group',
      shared_to_id: 200,
      share_type: 'image',
    });
    expect(repo.getByTarget('user', 200)).toHaveLength(1);
    expect(repo.getByTarget('group', 200)).toHaveLength(1);
  });

  test('create stores optional message_id and deep_link_code', () => {
    const shared = repo.create({
      event_id: eventId,
      shared_by: USER_ID,
      shared_to_type: 'user',
      shared_to_id: 200,
      share_type: 'card',
      message_id: 42,
      deep_link_code: 'abc123',
    });
    expect(shared.message_id).toBe(42);
    expect(shared.deep_link_code).toBe('abc123');
  });

  test('create stores null for omitted optional fields', () => {
    const shared = repo.create({
      event_id: eventId,
      shared_by: USER_ID,
      shared_to_type: 'user',
      shared_to_id: 200,
      share_type: 'card',
    });
    expect(shared.message_id).toBeNull();
    expect(shared.deep_link_code).toBeNull();
  });
});
