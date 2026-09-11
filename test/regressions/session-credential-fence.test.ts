import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { TelegramSessionRepository } from '../../src/database/repositories/telegram-session.repository.ts';

describe('incident: async session expiry must be credential-bound', () => {
  let db: Database;
  let sessions: TelegramSessionRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE user_telegram_sessions (
      user_id INTEGER PRIMARY KEY, encrypted_session BLOB NOT NULL, phone_masked TEXT,
      phone_hash TEXT, status TEXT NOT NULL DEFAULT 'active',
      tz_detection_consent_at TEXT, updated_at TEXT DEFAULT (datetime('now')));`);
    sessions = new TelegramSessionRepository(db);
  });
  afterEach(() => db.close());

  test('late S1 failure does not expire reconnected S2', () => {
    const old = Buffer.from('test-only-old-ciphertext');
    const current = Buffer.from('test-only-new-ciphertext');
    sessions.upsert(10, old, 'masked', 'test-phone');
    sessions.upsert(10, current, 'masked', 'test-phone');
    assert.equal(sessions.expireIfCurrent(10, old), false);
    assert.equal(sessions.getActive(10)?.status, 'active');
    assert.deepEqual(Buffer.from(sessions.getActive(10)!.encrypted_session), current);
  });

  test('current credential expires once; repeated checks do not notify again', () => {
    const credential = Buffer.from('test-only-current');
    sessions.upsert(10, credential, 'masked', 'test-phone');
    assert.equal(sessions.expireIfCurrent(10, credential), true);
    assert.equal(sessions.expireIfCurrent(10, credential), false);
    assert.equal(sessions.findByUserId(10)?.status, 'expired');
  });

  test('a revoked session is not overwritten by an old expiry result', () => {
    const credential = Buffer.from('test-only-current');
    sessions.upsert(10, credential, 'masked', 'test-phone');
    sessions.updateStatus(10, 'revoked');
    assert.equal(sessions.expireIfCurrent(10, credential), false);
    assert.equal(sessions.findByUserId(10)?.status, 'revoked');
  });

  test('other metadata changes do not invalidate credential comparison', () => {
    const credential = Buffer.from('test-only-current');
    sessions.upsert(10, credential, 'masked', 'test-phone');
    sessions.setTzConsentAt(10, 'never');
    assert.equal(sessions.expireIfCurrent(10, credential), true);
  });
});
