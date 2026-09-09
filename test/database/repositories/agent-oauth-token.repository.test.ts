// test/database/repositories/agent-oauth-token.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { AgentOauthTokenRepository } from '../../../src/database/repositories/agent-oauth-token.repository';
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

const ACCESS_ENC = 'iv:tag:access-ciphertext';
const REFRESH_ENC = 'iv:tag:refresh-ciphertext';
const EXPIRES_AT = 1_893_456_000_000;

describe('AgentOauthTokenRepository', () => {
  let db: Database;
  let repo: AgentOauthTokenRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new AgentOauthTokenRepository(db);
    const users = new UserRepository(db);
    users.create({ telegram_id: USER_A });
    users.create({ telegram_id: USER_B });
  });

  test('upsert creates a new row', () => {
    repo.upsert(USER_A, ACCESS_ENC, REFRESH_ENC, EXPIRES_AT);
    const row = repo.findByUserId(USER_A);
    expect(row).not.toBeNull();
    expect(row!.user_id).toBe(USER_A);
    expect(row!.access_token_enc).toBe(ACCESS_ENC);
    expect(row!.refresh_token_enc).toBe(REFRESH_ENC);
    expect(row!.expires_at).toBe(EXPIRES_AT);
  });

  test('upsert replaces existing row for the same user', () => {
    repo.upsert(USER_A, ACCESS_ENC, REFRESH_ENC, EXPIRES_AT);
    const newAccess = 'iv2:tag2:new-access-ciphertext';
    const newRefresh = 'iv2:tag2:new-refresh-ciphertext';
    const newExpiresAt = EXPIRES_AT + 3_600_000;
    repo.upsert(USER_A, newAccess, newRefresh, newExpiresAt);

    const row = repo.findByUserId(USER_A);
    expect(row).not.toBeNull();
    expect(row!.access_token_enc).toBe(newAccess);
    expect(row!.refresh_token_enc).toBe(newRefresh);
    expect(row!.expires_at).toBe(newExpiresAt);
  });

  test('upsert for one user does not affect another', () => {
    repo.upsert(USER_A, ACCESS_ENC, REFRESH_ENC, EXPIRES_AT);
    repo.upsert(USER_B, 'other-access', 'other-refresh', EXPIRES_AT);

    expect(repo.findByUserId(USER_A)!.access_token_enc).toBe(ACCESS_ENC);
    expect(repo.findByUserId(USER_B)!.access_token_enc).toBe('other-access');
  });

  test('findByUserId returns null for missing user', () => {
    expect(repo.findByUserId(999)).toBeNull();
  });

  test('deleteByUserId removes the row', () => {
    repo.upsert(USER_A, ACCESS_ENC, REFRESH_ENC, EXPIRES_AT);
    repo.deleteByUserId(USER_A);
    expect(repo.findByUserId(USER_A)).toBeNull();
  });

  test('deleteByUserId is a no-op when no row exists', () => {
    expect(() => repo.deleteByUserId(USER_A)).not.toThrow();
  });
});
