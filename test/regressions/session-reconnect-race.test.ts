import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { TelegramSessionRepository } from '../../src/database/repositories/telegram-session.repository.ts';
import { encryptBlob } from '../../src/services/crypto/session-crypto.ts';
import { createConnectedUserSender } from '../../src/services/telegram-session/connected-user-sender.ts';
import { SessionBridge } from '../../src/services/telegram-session/session-bridge.ts';
import { processSessionKeepalive } from '../../src/worker/session-keepalive.ts';

const key = Buffer.alloc(32, 42);
const original = { ...SessionBridge };
let db: Database;
let sessions: TelegramSessionRepository;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE user_telegram_sessions (
    user_id INTEGER PRIMARY KEY, encrypted_session BLOB NOT NULL, phone_masked TEXT,
    phone_hash TEXT, status TEXT NOT NULL DEFAULT 'active',
    tz_detection_consent_at TEXT, updated_at TEXT DEFAULT (datetime('now')));`);
  sessions = new TelegramSessionRepository(db);
  SessionBridge.createTempSessionFile = mock(async () => '/tmp/synthetic-session-race.session');
  SessionBridge.cleanupTempFile = mock(async () => {});
});
afterEach(() => {
  Object.assign(SessionBridge, original);
  db.close();
});

const expired = { success: false as const, error: 'SESSION_EXPIRED', message: 'synthetic revoked session' };

test('in-flight sender cannot expire or notify expiry for replacement credentials', async () => {
  const userId = 8765401;
  const current = encryptBlob(Buffer.from('new session'), key);
  sessions.upsert(userId, encryptBlob(Buffer.from('old session'), key), 'masked', 'synthetic-phone');
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<typeof expired>();
  SessionBridge.sendAsUser = mock(async () => {
    started.resolve();
    return result.promise;
  });
  const notify = mock(() => {});
  const send = createConnectedUserSender({ sessionRepo: sessions, masterKey: key, onSessionExpired: notify });
  const pending = send(userId, 9000, 'synthetic message');
  await started.promise;
  sessions.upsert(userId, current, 'masked', 'synthetic-phone');
  result.resolve(expired);
  expect(await pending).toBe(false);
  expect(sessions.getActive(userId)?.status).toBe('active');
  expect(Buffer.from(sessions.getActive(userId)!.encrypted_session).equals(current)).toBe(true);
  expect(notify).not.toHaveBeenCalled();
  expect(SessionBridge.cleanupTempFile).toHaveBeenCalledTimes(1);
});

test('keepalive snapshot cannot expire a reconnected user', async () => {
  const userId = 8765402;
  sessions.upsert(userId, Buffer.from('old ciphertext'), 'masked', 'synthetic-phone');
  const notify = mock(() => {});
  const cleanup = mock(async () => {});
  const outcome = await processSessionKeepalive({
    sessionRepo: sessions,
    masterKey: key,
    rateLimitMs: 0,
    decrypt: () => Buffer.from('synthetic session'),
    createTempFile: async () => '/tmp/synthetic-keepalive.session',
    getAuthorizations: async () => {
      sessions.upsert(userId, Buffer.from('new ciphertext'), 'masked', 'synthetic-phone');
      return expired;
    },
    cleanupFile: cleanup,
    onSessionExpired: notify,
  });
  expect(outcome).toEqual({ checked: 1, expired: 0 });
  expect(sessions.getActive(userId)).not.toBeNull();
  expect(notify).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
});
