import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('DeepLinkRepository', () => {
  let db: Database;
  let repo: DeepLinkRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new DeepLinkRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('create stores deep link and returns it', () => {
    const link = repo.create({
      code: 'abc123',
      type: 'shared_event',
      payload: '{"event_id":1}',
      created_by: USER_ID,
    });
    expect(link.code).toBe('abc123');
    expect(link.type).toBe('shared_event');
    expect(link.used_count).toBe(0);
  });

  test('findByCode returns link', () => {
    repo.create({ code: 'xyz', type: 'invitation', payload: '{}', created_by: USER_ID });
    const found = repo.findByCode('xyz');
    expect(found).not.toBeNull();
    expect(found!.type).toBe('invitation');
  });

  test('findByCode returns null for missing code', () => {
    expect(repo.findByCode('nope')).toBeNull();
  });

  test('incrementUsedCount increments counter', () => {
    repo.create({ code: 'cnt', type: 'shared_event', payload: '{}', created_by: USER_ID });
    repo.incrementUsedCount('cnt');
    repo.incrementUsedCount('cnt');
    const link = repo.findByCode('cnt');
    expect(link!.used_count).toBe(2);
  });

  test('deleteExpired removes expired links', () => {
    repo.create({
      code: 'exp',
      type: 'shared_event',
      payload: '{}',
      created_by: USER_ID,
      expires_at: '2020-01-01T00:00:00Z',
    });
    repo.create({ code: 'ok', type: 'shared_event', payload: '{}', created_by: USER_ID });
    const deleted = repo.deleteExpired();
    expect(deleted).toBe(1);
    expect(repo.findByCode('exp')).toBeNull();
    expect(repo.findByCode('ok')).not.toBeNull();
  });
});
