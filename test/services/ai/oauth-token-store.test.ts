// test/services/ai/oauth-token-store.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { AgentOauthTokenRepository } from '../../../src/database/repositories/agent-oauth-token.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { OauthTokenStore } from '../../../src/services/ai/oauth-token-store.ts';
import { decrypt } from '../../../src/utils/crypto.ts';

const ENCRYPTION_KEY = 'a'.repeat(64);
const USER_A = 100;

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('OauthTokenStore', () => {
  let db: Database;
  let repo: AgentOauthTokenRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new AgentOauthTokenRepository(db);
    new UserRepository(db).create({ telegram_id: USER_A });
  });

  test('updateTokens encrypts both tokens before persisting and round-trips via decrypt', () => {
    const store = new OauthTokenStore(repo, ENCRYPTION_KEY);
    store.updateTokens(USER_A, 'access-plaintext', 'refresh-plaintext', 1_893_456_000_000);

    const row = repo.findByUserId(USER_A);
    expect(row).not.toBeNull();
    expect(row!.access_token_enc).not.toBe('access-plaintext');
    expect(row!.refresh_token_enc).not.toBe('refresh-plaintext');
    expect(decrypt(row!.access_token_enc, ENCRYPTION_KEY)).toBe('access-plaintext');
    expect(decrypt(row!.refresh_token_enc, ENCRYPTION_KEY)).toBe('refresh-plaintext');
    expect(row!.expires_at).toBe(1_893_456_000_000);
  });

  test('updateTokens without ENCRYPTION_KEY does not throw and does not persist a row', () => {
    const store = new OauthTokenStore(repo, undefined);
    expect(() => store.updateTokens(USER_A, 'access', 'refresh', Date.now())).not.toThrow();
    expect(repo.findByUserId(USER_A)).toBeNull();
  });

  test('updateTokens overwrites the previous row for the same user', () => {
    const store = new OauthTokenStore(repo, ENCRYPTION_KEY);
    store.updateTokens(USER_A, 'access-1', 'refresh-1', 1000);
    store.updateTokens(USER_A, 'access-2', 'refresh-2', 2000);

    const row = repo.findByUserId(USER_A);
    expect(decrypt(row!.access_token_enc, ENCRYPTION_KEY)).toBe('access-2');
    expect(decrypt(row!.refresh_token_enc, ENCRYPTION_KEY)).toBe('refresh-2');
    expect(row!.expires_at).toBe(2000);
  });
});
