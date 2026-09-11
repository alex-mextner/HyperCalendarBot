import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TelegramSessionRepository } from '../../src/database/repositories/telegram-session.repository.ts';
import type { TelegramSession } from '../../src/database/types.ts';
import type { BridgeResult } from '../../src/services/telegram-session/session-bridge.ts';
import { processSessionKeepalive } from '../../src/worker/session-keepalive.ts';

// All dependencies injected via deps — no mock.module needed.

function makeSession(userId: number): TelegramSession {
  return {
    user_id: userId,
    encrypted_session: Buffer.from('enc-session'),
    phone_masked: '+7 ••• 0000',
    phone_hash: `hash_${userId}`,
    status: 'active',
    tz_detection_consent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeSessionRepo(sessions: TelegramSession[]) {
  const expireIfCurrent = mock((_userId: number, _credential: Uint8Array) => true);
  const repo = {
    getAllActive: () => sessions,
    expireIfCurrent,
  };
  return { repo: repo as unknown as TelegramSessionRepository, expireIfCurrent };
}

const MASTER_KEY = Buffer.alloc(32);

const mockDecrypt = mock((_blob: Buffer, _key: Buffer) => Buffer.from('session-data'));
const mockCreateTemp = mock(async (userId: number, _data: Buffer) => `/tmp/tgsess_${userId}.session`);
const mockGetAuths = mock(
  async (_path: string): Promise<BridgeResult> => ({
    success: true,
    data: { authorizations: [] },
  }),
);
const mockCleanup = mock(async (_path: string) => {});

function baseDeps(repo: TelegramSessionRepository) {
  return {
    sessionRepo: repo,
    masterKey: MASTER_KEY,
    rateLimitMs: 0,
    decrypt: mockDecrypt,
    createTempFile: mockCreateTemp,
    getAuthorizations: mockGetAuths,
    cleanupFile: mockCleanup,
  };
}

beforeEach(() => {
  mockDecrypt.mockClear();
  mockCreateTemp.mockClear();
  mockGetAuths.mockClear();
  mockCleanup.mockClear();

  // Reset default implementations
  mockDecrypt.mockImplementation((_blob: Buffer, _key: Buffer) => Buffer.from('session-data'));
  mockCreateTemp.mockImplementation(async (userId: number) => `/tmp/tgsess_${userId}.session`);
  mockGetAuths.mockImplementation(async (): Promise<BridgeResult> => ({ success: true, data: { authorizations: [] } }));
  mockCleanup.mockImplementation(async () => {});
});

describe('processSessionKeepalive', () => {
  test('returns zero counts when no active sessions', async () => {
    const { repo } = makeSessionRepo([]);
    const result = await processSessionKeepalive(baseDeps(repo));
    expect(result.checked).toBe(0);
    expect(result.expired).toBe(0);
    expect(mockGetAuths).not.toHaveBeenCalled();
  });

  test('checks each active session via getAuthorizations', async () => {
    const sessions = [makeSession(1), makeSession(2)];
    const { repo } = makeSessionRepo(sessions);

    const result = await processSessionKeepalive(baseDeps(repo));

    expect(result.checked).toBe(2);
    expect(result.expired).toBe(0);
    expect(mockGetAuths).toHaveBeenCalledTimes(2);
  });

  test('marks session expired when getAuthorizations returns SESSION_EXPIRED', async () => {
    const sessions = [makeSession(42)];
    const { repo, expireIfCurrent } = makeSessionRepo(sessions);
    const onSessionExpired = mock((_userId: number) => {});

    mockGetAuths.mockImplementation(
      async (): Promise<BridgeResult> => ({
        success: false,
        error: 'SESSION_EXPIRED',
        message: 'Session expired',
      }),
    );

    const result = await processSessionKeepalive({
      ...baseDeps(repo),
      onSessionExpired,
    });

    expect(result.checked).toBe(1);
    expect(result.expired).toBe(1);
    expect(expireIfCurrent).toHaveBeenCalledTimes(1);
    const [calledUserId, checkedCredential] = expireIfCurrent.mock.calls[0]!;
    expect(calledUserId).toBe(42);
    expect(checkedCredential).toEqual(sessions[0]!.encrypted_session);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    const [notifiedUserId] = onSessionExpired.mock.calls[0] as unknown as [number];
    expect(notifiedUserId).toBe(42);
  });

  test('does not mark expired for other bridge errors', async () => {
    const sessions = [makeSession(10)];
    const { repo, expireIfCurrent } = makeSessionRepo(sessions);

    mockGetAuths.mockImplementation(
      async (): Promise<BridgeResult> => ({
        success: false,
        error: 'FLOOD_WAIT',
        message: 'Too many requests',
      }),
    );

    const result = await processSessionKeepalive(baseDeps(repo));

    expect(result.checked).toBe(1);
    expect(result.expired).toBe(0);
    expect(expireIfCurrent).not.toHaveBeenCalled();
  });

  test('continues processing remaining sessions when one throws', async () => {
    const sessions = [makeSession(1), makeSession(2)];
    const { repo } = makeSessionRepo(sessions);

    let callCount = 0;
    mockCreateTemp.mockImplementation(async (userId: number) => {
      callCount++;
      if (callCount === 1) throw new Error('decrypt failed');
      return `/tmp/tgsess_${userId}.session`;
    });

    const result = await processSessionKeepalive(baseDeps(repo));

    expect(result.checked).toBe(2);
    expect(result.expired).toBe(0);
    expect(mockGetAuths).toHaveBeenCalledTimes(1);
  });

  test('always cleans up temp file even after SESSION_EXPIRED', async () => {
    const sessions = [makeSession(5)];
    const { repo } = makeSessionRepo(sessions);

    mockGetAuths.mockImplementation(
      async (): Promise<BridgeResult> => ({
        success: false,
        error: 'SESSION_EXPIRED',
        message: 'expired',
      }),
    );

    await processSessionKeepalive(baseDeps(repo));

    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  test('decrypts session with the provided masterKey', async () => {
    const sessions = [makeSession(7)];
    const { repo } = makeSessionRepo(sessions);
    const customKey = Buffer.alloc(32, 0xab);

    await processSessionKeepalive({ ...baseDeps(repo), masterKey: customKey });

    expect(mockDecrypt).toHaveBeenCalledTimes(1);
    const [, usedKey] = mockDecrypt.mock.calls[0] as unknown as [Buffer, Buffer];
    expect(usedKey).toEqual(customKey);
  });
});
