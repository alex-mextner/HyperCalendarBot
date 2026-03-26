import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { GoogleSyncState } from '../../../src/database/types.ts';
import { GoogleOAuthService } from '../../../src/services/google/oauth.ts';
import { encrypt } from '../../../src/utils/crypto.ts';

// 32-byte key expressed as 64 hex chars
const ENCRYPTION_KEY = '0'.repeat(64);

// Minimal stubs — we only test the auth client setup logic
function makeUserRepo(user: Record<string, unknown> | null = null) {
  return { findByTelegramId: mock(() => user) };
}

function makeSyncRepo(state: Partial<GoogleSyncState> | null = null) {
  return {
    getSyncState: mock(() => state),
    updateAccessToken: mock(() => {}),
  };
}

function makeRedis(setResult: string | null = 'OK', getResult: string | null = null) {
  return {
    set: mock(() => Promise.resolve(setResult)),
    get: mock(() => Promise.resolve(getResult)),
    del: mock(() => Promise.resolve(1)),
  };
}

const VALID_USER = {
  telegram_id: 42,
  google_refresh_token_enc: encrypt('test-refresh-token', ENCRYPTION_KEY),
};

const FUTURE_EXPIRES = new Date(Date.now() + 60 * 60_000).toISOString(); // 1h from now
const PAST_EXPIRES = new Date(Date.now() - 60_000).toISOString(); // 1m ago

describe('GoogleOAuthService.getAuthClient', () => {
  afterEach(() => {
    mock.restore();
  });

  const makeConfig = () => ({
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csec',
    GOOGLE_REDIRECT_URI: 'http://localhost/cb',
    ENCRYPTION_KEY,
  });

  test('throws GoogleNotConnectedError when user has no refresh token', async () => {
    const svc = new GoogleOAuthService(
      makeConfig() as never,
      makeUserRepo({ telegram_id: 42 }) as never,
      makeSyncRepo() as never,
    );
    await expect(svc.getAuthClient(42)).rejects.toMatchObject({ name: 'GoogleNotConnectedError' });
  });

  test('throws GoogleTokenRevokedError when sync state is revoked', async () => {
    const svc = new GoogleOAuthService(
      makeConfig() as never,
      makeUserRepo(VALID_USER) as never,
      makeSyncRepo({ status: 'revoked' }) as never,
    );
    await expect(svc.getAuthClient(42)).rejects.toMatchObject({ name: 'GoogleTokenRevokedError' });
  });

  test('acquires Redis lock when token is expired', async () => {
    const redis = makeRedis('OK');
    const svc = new GoogleOAuthService(
      makeConfig() as never,
      makeUserRepo(VALID_USER) as never,
      makeSyncRepo({ status: 'active', access_token: 'old', expires_at: PAST_EXPIRES }) as never,
      redis as never,
    );
    await svc.getAuthClient(42);
    expect(redis.set).toHaveBeenCalledWith('gcal:refresh:42', expect.any(String), 'NX', 'EX', 30);
  });

  test('skips Redis lock when token is still valid', async () => {
    const redis = makeRedis('OK');
    const svc = new GoogleOAuthService(
      makeConfig() as never,
      makeUserRepo(VALID_USER) as never,
      makeSyncRepo({ status: 'active', access_token: 'fresh', expires_at: FUTURE_EXPIRES }) as never,
      redis as never,
    );
    await svc.getAuthClient(42);
    expect(redis.set).not.toHaveBeenCalled();
  });

  test('re-reads DB when lock is not acquired (another process is refreshing)', async () => {
    const syncRepo = makeSyncRepo({ status: 'active', access_token: 'old', expires_at: PAST_EXPIRES });
    // First getSyncState call returns stale; second returns fresh (after lock released)
    syncRepo.getSyncState
      .mockReturnValueOnce({ status: 'active', access_token: 'old', expires_at: PAST_EXPIRES })
      .mockReturnValueOnce({ status: 'active', access_token: 'fresh', expires_at: FUTURE_EXPIRES });

    // Lock not acquired (NX set returns null), then lock released quickly (get returns null)
    const redis = makeRedis(null, null);
    const svc = new GoogleOAuthService(
      makeConfig() as never,
      makeUserRepo(VALID_USER) as never,
      syncRepo as never,
      redis as never,
    );
    const client = await svc.getAuthClient(42);
    expect(client).toBeDefined();
    // Re-read after lock release
    expect(syncRepo.getSyncState).toHaveBeenCalledTimes(2);
  });

  test('works without Redis (no lock)', async () => {
    const svc = new GoogleOAuthService(
      makeConfig() as never,
      makeUserRepo(VALID_USER) as never,
      makeSyncRepo({ status: 'active', access_token: 'tok', expires_at: PAST_EXPIRES }) as never,
    );
    const client = await svc.getAuthClient(42);
    expect(client).toBeDefined();
  });
});
