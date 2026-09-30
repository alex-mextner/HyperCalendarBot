// test/database/repositories/call-log.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { CallLogRepository } from '../../../src/database/repositories/call-log.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('CallLogRepository', () => {
  let db: Database;
  let repo: CallLogRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new CallLogRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('create stores call log entry', () => {
    const log = repo.create({ user_id: USER_ID, event_id: 1, tts_text: 'Meeting in 10 minutes' });
    expect(log.id).toBeGreaterThan(0);
    expect(log.status).toBe('queued');
  });

  test('updateStatus transitions status', () => {
    const log = repo.create({ user_id: USER_ID });
    repo.updateStatus(log.id, 'ringing');
    expect(repo.findById(log.id)!.status).toBe('ringing');
  });

  test('complete sets status, duration, completed_at', () => {
    const log = repo.create({ user_id: USER_ID });
    repo.complete(log.id, 'completed', 30);
    const updated = repo.findById(log.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.duration_sec).toBe(30);
    expect(updated.completed_at).not.toBeNull();
  });

  test('complete with error stores error message', () => {
    const log = repo.create({ user_id: USER_ID });
    repo.complete(log.id, 'failed', 0, 'User busy');
    expect(repo.findById(log.id)!.error).toBe('User busy');
  });

  test('countTodayCalls counts calls for today', () => {
    repo.create({ user_id: USER_ID });
    repo.create({ user_id: USER_ID });
    expect(repo.countTodayCalls(USER_ID)).toBe(2);
  });

  test('getRecent returns latest calls', () => {
    repo.create({ user_id: USER_ID, tts_text: 'First' });
    repo.create({ user_id: USER_ID, tts_text: 'Second' });
    const recent = repo.getRecent(USER_ID, 5);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.tts_text).toBe('Second');
  });

  // --- Red tests ---

  test('findById returns null for non-existent id', () => {
    expect(repo.findById(999)).toBeNull();
  });

  test('countTodayCalls returns 0 for user with no calls', () => {
    expect(repo.countTodayCalls(999)).toBe(0);
  });

  test('getRecent returns empty for user with no calls', () => {
    expect(repo.getRecent(999, 5)).toHaveLength(0);
  });

  test('create without optional fields uses defaults', () => {
    const log = repo.create({ user_id: USER_ID });
    expect(log.event_id).toBeNull();
    expect(log.tts_text).toBeNull();
    expect(log.error).toBeNull();
    expect(log.duration_sec).toBeNull();
    expect(log.completed_at).toBeNull();
  });

  test('complete with failed status stores error', () => {
    const log = repo.create({ user_id: USER_ID });
    repo.complete(log.id, 'failed', 0, 'Connection timeout');
    const updated = repo.findById(log.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toBe('Connection timeout');
    expect(updated.duration_sec).toBe(0);
  });
});
