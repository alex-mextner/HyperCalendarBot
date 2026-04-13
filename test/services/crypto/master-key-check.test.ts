import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { migrations } from '../../../src/database/migrations.ts';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { verifyMasterKey } from '../../../src/services/crypto/master-key-check.ts';
import { encryptBlob } from '../../../src/services/crypto/session-crypto.ts';

describe('verifyMasterKey', () => {
  let db: Database;
  let repo: TelegramSessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    runMigrations(db, migrations);
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(100, 'Test');
    repo = new TelegramSessionRepository(db);
  });

  test('passes when no sessions exist', () => {
    const result = verifyMasterKey(repo, randomBytes(32));
    expect(result).toEqual({ ok: true, reason: 'no-sessions' });
  });

  test('passes when key matches existing session', () => {
    const key = randomBytes(32);
    const blob = encryptBlob(Buffer.from('some-pyrogram-session-bytes'), key);
    const phone = encryptBlob(Buffer.from('+79001234567'), key);
    repo.upsert(100, blob, phone, 'hash');
    const result = verifyMasterKey(repo, key);
    expect(result).toEqual({ ok: true, reason: 'verified' });
  });

  test('fails when key does not match existing session', () => {
    const correctKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    repo.upsert(
      100,
      encryptBlob(Buffer.from('session'), correctKey),
      encryptBlob(Buffer.from('+79001234567'), correctKey),
      'hash',
    );
    const result = verifyMasterKey(repo, wrongKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('mismatch');
    }
  });
});
