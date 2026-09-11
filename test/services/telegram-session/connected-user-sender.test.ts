import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import type { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { encryptBlob } from '../../../src/services/crypto/session-crypto.ts';
import {
  createConnectedUserSender,
  isRateLimited,
} from '../../../src/services/telegram-session/connected-user-sender.ts';
import type { BridgeResult } from '../../../src/services/telegram-session/session-bridge.ts';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';

// --- Mock factory helpers (centralized, as unknown as allowed per CLAUDE.md) ---

function makeMockSessionRepo(activeSession?: { encrypted_session: Buffer }) {
  return {
    getActive: mock((userId: number) => {
      if (activeSession) {
        return {
          user_id: userId,
          encrypted_session: activeSession.encrypted_session,
          phone_masked: '+7 ••• 0000',
          phone_hash: 'abc',
          status: 'active' as const,
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        };
      }
      return null;
    }),
    expireIfCurrent: mock((_userId: number, _credential: Uint8Array) => true),
  } as unknown as TelegramSessionRepository & {
    getActive: ReturnType<typeof mock>;
    expireIfCurrent: ReturnType<typeof mock>;
  };
}

function makeMockNotifLogRepo() {
  return {
    insert: mock(
      (_data: { user_id: number; type: string; reference_key: string; channel: string; payload: string }) => 1,
    ),
  } as unknown as NotificationLogRepository & {
    insert: ReturnType<typeof mock>;
  };
}

const MASTER_KEY = Buffer.alloc(32, 0xab);
const REAL_SESSION_DATA = Buffer.from('pyrogram-session-blob-data');
const ENCRYPTED_SESSION = encryptBlob(REAL_SESSION_DATA, MASTER_KEY);

// Save originals for restoring after mocks
const originalCreateTempSessionFile = SessionBridge.createTempSessionFile;
const originalSendAsUser = SessionBridge.sendAsUser;
const originalCleanupTempFile = SessionBridge.cleanupTempFile;

describe('createConnectedUserSender', () => {
  beforeEach(() => {
    SessionBridge.createTempSessionFile = mock(async (_userId: number, _data: Buffer) => '/tmp/tgsess_test.session');
    SessionBridge.cleanupTempFile = mock(async (_path: string) => {});
  });

  afterEach(() => {
    SessionBridge.createTempSessionFile = originalCreateTempSessionFile;
    SessionBridge.sendAsUser = originalSendAsUser;
    SessionBridge.cleanupTempFile = originalCleanupTempFile;
  });

  test('returns false when no active session exists', async () => {
    const sessionRepo = makeMockSessionRepo(); // no activeSession
    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY });

    const result = await sender(123, 456, 'Hello');

    expect(result).toBe(false);
    expect(sessionRepo.getActive).toHaveBeenCalledWith(123);
  });

  test('returns true on successful send', async () => {
    const sessionRepo = makeMockSessionRepo({ encrypted_session: ENCRYPTED_SESSION });
    const bridgeResult: BridgeResult = { success: true, data: { status: 'ok' as const } };
    SessionBridge.sendAsUser = mock(async () => bridgeResult);

    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY });
    const result = await sender(100, 200, 'Hey there', 'bob');

    expect(result).toBe(true);
    expect(SessionBridge.createTempSessionFile).toHaveBeenCalled();
    expect(SessionBridge.sendAsUser).toHaveBeenCalledWith('/tmp/tgsess_test.session', 200, 'Hey there', 'bob');
    expect(SessionBridge.cleanupTempFile).toHaveBeenCalledWith('/tmp/tgsess_test.session');
  });

  test('logs to notification_log on success when meta provided', async () => {
    const sessionRepo = makeMockSessionRepo({ encrypted_session: ENCRYPTED_SESSION });
    const notifLogRepo = makeMockNotifLogRepo();
    const bridgeResult: BridgeResult = { success: true, data: { status: 'ok' as const } };
    SessionBridge.sendAsUser = mock(async () => bridgeResult);

    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY, notifLogRepo });
    await sender(100, 200, 'invitation text', 'bob', { invitationId: 42 });

    expect(notifLogRepo.insert).toHaveBeenCalledWith({
      user_id: 200,
      type: 'invitation_sent',
      reference_key: 'invitation_42_200_mtproto_user',
      channel: 'mtproto_user',
      payload: 'invitation text',
    });
  });

  test('does not log to notification_log when no meta', async () => {
    const sessionRepo = makeMockSessionRepo({ encrypted_session: ENCRYPTED_SESSION });
    const notifLogRepo = makeMockNotifLogRepo();
    const bridgeResult: BridgeResult = { success: true, data: { status: 'ok' as const } };
    SessionBridge.sendAsUser = mock(async () => bridgeResult);

    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY, notifLogRepo });
    await sender(100, 200, 'hello');

    expect(notifLogRepo.insert).not.toHaveBeenCalled();
  });

  test('returns false and marks expired on SESSION_EXPIRED', async () => {
    const sessionRepo = makeMockSessionRepo({ encrypted_session: ENCRYPTED_SESSION });
    const bridgeResult: BridgeResult = { success: false, error: 'SESSION_EXPIRED', message: 'Session expired' };
    SessionBridge.sendAsUser = mock(async () => bridgeResult);

    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY });
    const result = await sender(100, 200, 'hello');

    expect(result).toBe(false);
    expect(sessionRepo.expireIfCurrent).toHaveBeenCalledWith(100, ENCRYPTED_SESSION);
  });

  test('calls onSessionExpired callback on SESSION_EXPIRED', async () => {
    const sessionRepo = makeMockSessionRepo({ encrypted_session: ENCRYPTED_SESSION });
    const bridgeResult: BridgeResult = { success: false, error: 'SESSION_EXPIRED', message: 'Session expired' };
    SessionBridge.sendAsUser = mock(async () => bridgeResult);
    const onSessionExpired = mock((_userId: number) => {});

    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY, onSessionExpired });
    await sender(100, 200, 'hello');

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(onSessionExpired).toHaveBeenCalledWith(100);
  });

  test('returns false on other bridge errors without marking expired', async () => {
    const sessionRepo = makeMockSessionRepo({ encrypted_session: ENCRYPTED_SESSION });
    const bridgeResult: BridgeResult = { success: false, error: 'FLOOD_WAIT', message: 'Too many requests' };
    SessionBridge.sendAsUser = mock(async () => bridgeResult);
    const onSessionExpired = mock((_userId: number) => {});

    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY, onSessionExpired });
    const result = await sender(100, 200, 'hello');

    expect(result).toBe(false);
    expect(sessionRepo.expireIfCurrent).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  test('returns false and marks expired on decryption failure', async () => {
    const badEncrypted = Buffer.from('not-a-valid-encrypted-blob');
    const sessionRepo = makeMockSessionRepo({ encrypted_session: badEncrypted });

    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY });
    const result = await sender(100, 200, 'hello');

    expect(result).toBe(false);
    expect(sessionRepo.expireIfCurrent).toHaveBeenCalledWith(100, badEncrypted);
  });

  test('calls onSessionExpired callback on decryption failure', async () => {
    const badEncrypted = Buffer.from('not-a-valid-encrypted-blob');
    const sessionRepo = makeMockSessionRepo({ encrypted_session: badEncrypted });
    const onSessionExpired = mock((_userId: number) => {});

    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY, onSessionExpired });
    await sender(100, 200, 'hello');

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(onSessionExpired).toHaveBeenCalledWith(100);
  });

  test('cleans up temp file even on crash', async () => {
    const sessionRepo = makeMockSessionRepo({ encrypted_session: ENCRYPTED_SESSION });
    SessionBridge.sendAsUser = mock(async () => {
      throw new Error('bridge process crashed');
    });

    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY });
    const result = await sender(100, 200, 'hello');

    expect(result).toBe(false);
    expect(SessionBridge.cleanupTempFile).toHaveBeenCalledWith('/tmp/tgsess_test.session');
  });

  test('returns false when rate-limited', async () => {
    const sessionRepo = makeMockSessionRepo({ encrypted_session: ENCRYPTED_SESSION });
    const bridgeResult: BridgeResult = { success: true, data: { status: 'ok' as const } };
    SessionBridge.sendAsUser = mock(async () => bridgeResult);

    const sender = createConnectedUserSender({ sessionRepo, masterKey: MASTER_KEY });
    // Use a unique user ID to avoid interference from other tests
    const userId = 77700;

    // First 10 calls should succeed (rate limit is 10/hour)
    for (let i = 0; i < 10; i++) {
      await sender(userId, 200, `msg ${i}`);
    }

    // 11th call should be rate-limited, returning false without calling getActive
    const result = await sender(userId, 200, 'over limit');
    expect(result).toBe(false);
    // getActive should have been called only 10 times (not 11)
    const getActiveCalls = (sessionRepo.getActive as ReturnType<typeof mock>).mock.calls.filter(
      (call: unknown[]) => call[0] === userId,
    );
    expect(getActiveCalls.length).toBe(10);
  });
});

describe('isRateLimited', () => {
  test('allows first call for a new user', () => {
    expect(isRateLimited(99901)).toBe(false);
  });

  test('allows up to SEND_RATE_LIMIT calls', () => {
    const userId = 99902;
    for (let i = 0; i < 9; i++) {
      expect(isRateLimited(userId)).toBe(false);
    }
  });

  test('blocks after SEND_RATE_LIMIT calls', () => {
    const userId = 99903;
    for (let i = 0; i < 10; i++) {
      isRateLimited(userId);
    }
    expect(isRateLimited(userId)).toBe(true);
  });

  test('different users have independent limits', () => {
    const userA = 99904;
    const userB = 99905;
    for (let i = 0; i < 10; i++) {
      isRateLimited(userA);
    }
    expect(isRateLimited(userA)).toBe(true);
    expect(isRateLimited(userB)).toBe(false);
  });
});
