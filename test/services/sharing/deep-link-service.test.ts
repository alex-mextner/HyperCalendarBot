import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';
import { DeepLinkService } from '../../../src/services/sharing/deep-link-service';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('DeepLinkService', () => {
  test('createShareLink generates s_ prefixed code', () => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    const repo = new DeepLinkRepository(db);
    const service = new DeepLinkService(repo);
    const link = service.createShareLink(1, USER_ID);
    expect(link.code).toMatch(/^s_[a-zA-Z0-9_-]+$/);
    expect(link.type).toBe('shared_event');
  });

  test('createInvitationLink generates i_ prefixed code', () => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    const repo = new DeepLinkRepository(db);
    const service = new DeepLinkService(repo);
    const link = service.createInvitationLink(1, 42, USER_ID);
    expect(link.code).toMatch(/^i_[a-zA-Z0-9_-]+$/);
    expect(link.type).toBe('invitation');
  });

  test('createGroupContextLink generates g_ prefixed code', () => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    const repo = new DeepLinkRepository(db);
    const service = new DeepLinkService(repo);
    const link = service.createGroupContextLink(-1001234, USER_ID);
    expect(link.code).toMatch(/^g_[a-zA-Z0-9_-]+$/);
    expect(link.type).toBe('group_context');
  });

  test('resolve returns parsed payload and increments used count', () => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    const repo = new DeepLinkRepository(db);
    const service = new DeepLinkService(repo);
    const link = service.createShareLink(42, USER_ID);
    const resolved = service.resolve(link.code);
    expect(resolved).not.toBeNull();
    expect(resolved!.type).toBe('shared_event');
    expect(resolved!.payload).toEqual({ event_id: 42 });
    // Check used_count incremented
    const raw = repo.findByCode(link.code);
    expect(raw!.used_count).toBe(1);
  });

  test('resolve returns null for unknown code', () => {
    const db = createTestDb();
    const repo = new DeepLinkRepository(db);
    const service = new DeepLinkService(repo);
    expect(service.resolve('unknown')).toBeNull();
  });

  test('resolve returns null for expired link', () => {
    const db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    const repo = new DeepLinkRepository(db);
    repo.create({
      code: 'exp_test',
      type: 'shared_event',
      payload: '{"event_id":1}',
      created_by: USER_ID,
      expires_at: '2020-01-01T00:00:00Z',
    });
    const service = new DeepLinkService(repo);
    expect(service.resolve('exp_test')).toBeNull();
  });

  test('generateUrl builds valid telegram deep link', () => {
    const db = createTestDb();
    const repo = new DeepLinkRepository(db);
    const service = new DeepLinkService(repo);
    const url = service.generateUrl('s_abc123', 'MyBot');
    expect(url).toBe('https://t.me/MyBot?start=s_abc123');
  });
});
