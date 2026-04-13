import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TelegramSessionRepository } from '../../src/database/repositories/telegram-session.repository.ts';
import type { TelegramSession } from '../../src/database/types.ts';
import type { BridgeResult } from '../../src/services/telegram-session/session-bridge.ts';

// --- Mock crypto ---
const mockDecryptBlob = mock((_blob: Buffer, _key: Buffer) => Buffer.from('session-data'));
mock.module('../../src/services/crypto/session-crypto.ts', () => ({
  decryptBlob: mockDecryptBlob,
}));

// --- Mock SessionBridge ---
const mockCreateTempSessionFile = mock(async (userId: number, _data: Buffer) => `/tmp/tgsess_${userId}.session`);
const mockGetAuthorizations = mock(
  async (_path: string): Promise<BridgeResult> => ({
    success: true,
    data: { authorizations: [] },
  }),
);
const mockCleanupTempFile = mock(async (_path: string) => {});

mock.module('../../src/services/telegram-session/session-bridge.ts', () => ({
  SessionBridge: {
    createTempSessionFile: mockCreateTempSessionFile,
    getAuthorizations: mockGetAuthorizations,
    cleanupTempFile: mockCleanupTempFile,
  },
}));

const { processSessionKeepalive } = await import('../../src/worker/session-keepalive.ts');

function makeSession(userId: number): TelegramSession {
  return {
    user_id: userId,
    encrypted_session: Buffer.from('enc-session'),
    encrypted_phone: Buffer.from('enc-phone'),
    phone_hash: `hash_${userId}`,
    status: 'active',
    tz_detection_consent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeSessionRepo(sessions: TelegramSession[]) {
  const updateStatus = mock((_userId: number, _status: 'active' | 'expired' | 'revoked') => {});
  const repo = {
    getAllActive: () => sessions,
    updateStatus,
  };
  return { repo: repo as unknown as TelegramSessionRepository, updateStatus };
}

const MASTER_KEY = Buffer.alloc(32);

beforeEach(() => {
  mockDecryptBlob.mockClear();
  mockCreateTempSessionFile.mockClear();
  mockGetAuthorizations.mockClear();
  mockCleanupTempFile.mockClear();
});

describe('processSessionKeepalive', () => {
  test('returns zero counts when no active sessions', async () => {
    const { repo } = makeSessionRepo([]);
    const result = await processSessionKeepalive({ sessionRepo: repo, masterKey: MASTER_KEY });
    expect(result.checked).toBe(0);
    expect(result.expired).toBe(0);
    expect(mockGetAuthorizations).not.toHaveBeenCalled();
  });

  test('checks each active session via getAuthorizations', async () => {
    const sessions = [makeSession(1), makeSession(2)];
    const { repo } = makeSessionRepo(sessions);
    mockGetAuthorizations.mockImplementation(
      async (): Promise<BridgeResult> => ({
        success: true,
        data: { authorizations: [] },
      }),
    );

    const result = await processSessionKeepalive({ sessionRepo: repo, masterKey: MASTER_KEY, rateLimitMs: 0 });

    expect(result.checked).toBe(2);
    expect(result.expired).toBe(0);
    expect(mockGetAuthorizations).toHaveBeenCalledTimes(2);
  });

  test('marks session expired when getAuthorizations returns SESSION_EXPIRED', async () => {
    const sessions = [makeSession(42)];
    const { repo, updateStatus } = makeSessionRepo(sessions);
    const onSessionExpired = mock((_userId: number) => {});

    mockGetAuthorizations.mockImplementation(
      async (): Promise<BridgeResult> => ({
        success: false,
        error: 'SESSION_EXPIRED',
        message: 'Session expired',
      }),
    );

    const result = await processSessionKeepalive({
      sessionRepo: repo,
      masterKey: MASTER_KEY,
      onSessionExpired,
    });

    expect(result.checked).toBe(1);
    expect(result.expired).toBe(1);
    expect(updateStatus).toHaveBeenCalledTimes(1);
    const [calledUserId, calledStatus] = updateStatus.mock.calls[0] as unknown as [number, string];
    expect(calledUserId).toBe(42);
    expect(calledStatus).toBe('expired');
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    const [notifiedUserId] = onSessionExpired.mock.calls[0] as unknown as [number];
    expect(notifiedUserId).toBe(42);
  });

  test('does not mark expired for other bridge errors', async () => {
    const sessions = [makeSession(10)];
    const { repo, updateStatus } = makeSessionRepo(sessions);

    mockGetAuthorizations.mockImplementation(
      async (): Promise<BridgeResult> => ({
        success: false,
        error: 'FLOOD_WAIT',
        message: 'Too many requests',
      }),
    );

    const result = await processSessionKeepalive({ sessionRepo: repo, masterKey: MASTER_KEY });

    expect(result.checked).toBe(1);
    expect(result.expired).toBe(0);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  test('continues processing remaining sessions when one throws', async () => {
    const sessions = [makeSession(1), makeSession(2)];
    const { repo } = makeSessionRepo(sessions);

    let callCount = 0;
    mockCreateTempSessionFile.mockImplementation(async (userId: number, _data: Buffer) => {
      callCount++;
      if (callCount === 1) throw new Error('decrypt failed');
      return `/tmp/tgsess_${userId}.session`;
    });

    mockGetAuthorizations.mockImplementation(
      async (): Promise<BridgeResult> => ({
        success: true,
        data: { authorizations: [] },
      }),
    );

    const result = await processSessionKeepalive({ sessionRepo: repo, masterKey: MASTER_KEY, rateLimitMs: 0 });

    expect(result.checked).toBe(2);
    expect(result.expired).toBe(0);
    // Second session was still checked
    expect(mockGetAuthorizations).toHaveBeenCalledTimes(1);
  });

  test('always cleans up temp file even after getAuthorizations returns expired', async () => {
    const sessions = [makeSession(5)];
    const { repo } = makeSessionRepo(sessions);

    mockGetAuthorizations.mockImplementation(
      async (): Promise<BridgeResult> => ({
        success: false,
        error: 'SESSION_EXPIRED',
        message: 'expired',
      }),
    );

    await processSessionKeepalive({ sessionRepo: repo, masterKey: MASTER_KEY });

    expect(mockCleanupTempFile).toHaveBeenCalledTimes(1);
  });

  test('decrypts session with the provided masterKey', async () => {
    const sessions = [makeSession(7)];
    const { repo } = makeSessionRepo(sessions);
    const customKey = Buffer.alloc(32, 0xab);

    mockGetAuthorizations.mockImplementation(
      async (): Promise<BridgeResult> => ({
        success: true,
        data: { authorizations: [] },
      }),
    );

    await processSessionKeepalive({ sessionRepo: repo, masterKey: customKey });

    expect(mockDecryptBlob).toHaveBeenCalledTimes(1);
    const [, usedKey] = mockDecryptBlob.mock.calls[0] as unknown as [Buffer, Buffer];
    expect(usedKey).toEqual(customKey);
  });
});
