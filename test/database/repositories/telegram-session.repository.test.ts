// test/database/repositories/telegram-session.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_A = 100;
const USER_B = 200;

const SESSION_BUF = Buffer.from('encrypted-session-data');
const PHONE_BUF = Buffer.from('encrypted-phone-data');
const PHONE_HASH = 'abc123def456';

describe('TelegramSessionRepository', () => {
  let db: Database;
  let repo: TelegramSessionRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new TelegramSessionRepository(db);
    const users = new UserRepository(db);
    users.create({ telegram_id: USER_A });
    users.create({ telegram_id: USER_B });
  });

  test('upsert creates a new session', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, PHONE_HASH);
    const session = repo.findByUserId(USER_A);
    expect(session).not.toBeNull();
    expect(session!.user_id).toBe(USER_A);
    expect(Buffer.from(session!.encrypted_session).toString()).toBe('encrypted-session-data');
    expect(Buffer.from(session!.encrypted_phone).toString()).toBe('encrypted-phone-data');
    expect(session!.phone_hash).toBe(PHONE_HASH);
    expect(session!.status).toBe('active');
  });

  test('upsert replaces existing session for the same user', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, PHONE_HASH);
    const newSession = Buffer.from('new-session-data');
    const newPhone = Buffer.from('new-phone-data');
    const newHash = 'newhash789';
    repo.upsert(USER_A, newSession, newPhone, newHash);

    const session = repo.findByUserId(USER_A);
    expect(session).not.toBeNull();
    expect(Buffer.from(session!.encrypted_session).toString()).toBe('new-session-data');
    expect(Buffer.from(session!.encrypted_phone).toString()).toBe('new-phone-data');
    expect(session!.phone_hash).toBe(newHash);
    expect(session!.status).toBe('active');
  });

  test('findByUserId returns null for missing user', () => {
    expect(repo.findByUserId(999)).toBeNull();
  });

  test('getActive returns only active sessions', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, PHONE_HASH);
    expect(repo.getActive(USER_A)).not.toBeNull();

    repo.updateStatus(USER_A, 'expired');
    expect(repo.getActive(USER_A)).toBeNull();
  });

  test('updateStatus changes status', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, PHONE_HASH);
    repo.updateStatus(USER_A, 'revoked');

    const session = repo.findByUserId(USER_A);
    expect(session!.status).toBe('revoked');
  });

  test('findByPhoneHash finds session', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, PHONE_HASH);
    const session = repo.findByPhoneHash(PHONE_HASH);
    expect(session).not.toBeNull();
    expect(session!.user_id).toBe(USER_A);
  });

  test('upsert claims phone from a different user (soft takeover)', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, PHONE_HASH);
    expect(repo.findByUserId(USER_A)).not.toBeNull();

    // USER_B connects with the same phone — should delete USER_A's row
    const newSession = Buffer.from('user-b-session');
    const newPhone = Buffer.from('user-b-phone');
    repo.upsert(USER_B, newSession, newPhone, PHONE_HASH);

    expect(repo.findByUserId(USER_A)).toBeNull();
    const session = repo.findByUserId(USER_B);
    expect(session).not.toBeNull();
    expect(session!.phone_hash).toBe(PHONE_HASH);
    expect(Buffer.from(session!.encrypted_session).toString()).toBe('user-b-session');
  });

  test('getMostRecentActive returns latest active session', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, 'hash_a');
    repo.upsert(USER_B, Buffer.from('b-session'), Buffer.from('b-phone'), 'hash_b');

    // Expire USER_A, so only USER_B is active
    repo.updateStatus(USER_A, 'expired');

    const recent = repo.getMostRecentActive();
    expect(recent).not.toBeNull();
    expect(recent!.user_id).toBe(USER_B);
  });

  test('getMostRecentActive returns null when no active sessions', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, PHONE_HASH);
    repo.updateStatus(USER_A, 'revoked');
    expect(repo.getMostRecentActive()).toBeNull();
  });

  test('getAllActive returns all active sessions', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, 'hash_a');
    repo.upsert(USER_B, Buffer.from('b-session'), Buffer.from('b-phone'), 'hash_b');

    const active = repo.getAllActive();
    expect(active.length).toBe(2);
    expect(active.map((s) => s.user_id).sort()).toEqual([USER_A, USER_B].sort());
  });

  test('getAllActive excludes expired and revoked sessions', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, 'hash_a');
    repo.upsert(USER_B, Buffer.from('b-session'), Buffer.from('b-phone'), 'hash_b');
    repo.updateStatus(USER_A, 'expired');
    repo.updateStatus(USER_B, 'revoked');

    const active = repo.getAllActive();
    expect(active.length).toBe(0);
  });

  test('getAllActive returns empty array when no sessions exist', () => {
    expect(repo.getAllActive()).toEqual([]);
  });

  test('countByStatus returns counts grouped by status', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, 'hash_a');
    repo.upsert(USER_B, Buffer.from('b-session'), Buffer.from('b-phone'), 'hash_b');
    repo.updateStatus(USER_B, 'expired');

    const counts = repo.countByStatus();
    expect(counts.active).toBe(1);
    expect(counts.expired).toBe(1);
    expect(counts.revoked).toBe(0);
  });

  test('countByStatus returns all zeros when no sessions exist', () => {
    const counts = repo.countByStatus();
    expect(counts.active).toBe(0);
    expect(counts.expired).toBe(0);
    expect(counts.revoked).toBe(0);
  });

  test('deleteByUserId removes session', () => {
    repo.upsert(USER_A, SESSION_BUF, PHONE_BUF, PHONE_HASH);
    expect(repo.findByUserId(USER_A)).not.toBeNull();

    repo.deleteByUserId(USER_A);
    expect(repo.findByUserId(USER_A)).toBeNull();
  });
});
