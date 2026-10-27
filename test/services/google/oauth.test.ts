import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
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

// Lets the async 'tokens' listener (several awaited Redis calls) run to completion.
const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

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

  test('persists a refreshed access token on the tokens event without Redis', async () => {
    const syncRepo = makeSyncRepo({ status: 'active', access_token: 'tok', expires_at: FUTURE_EXPIRES });
    const svc = new GoogleOAuthService(makeConfig() as never, makeUserRepo(VALID_USER) as never, syncRepo as never);
    const client = await svc.getAuthClient(42);
    client.emit('tokens', { access_token: 'new', expiry_date: Date.UTC(2030, 0, 1) });
    client.emit('tokens', { expiry_date: 1 });
    expect(syncRepo.updateAccessToken).toHaveBeenCalledTimes(1);
    expect(syncRepo.updateAccessToken).toHaveBeenCalledWith(42, 'new', '2030-01-01T00:00:00.000Z');
    expect((await client.getAccessToken()).token).toBe('tok');
  });

  test('stores an empty expiry when the tokens event carries none', async () => {
    const syncRepo = makeSyncRepo({ status: 'active', access_token: 'tok', expires_at: FUTURE_EXPIRES });
    const svc = new GoogleOAuthService(makeConfig() as never, makeUserRepo(VALID_USER) as never, syncRepo as never);
    const client = await svc.getAuthClient(42);
    client.emit('tokens', { access_token: 'new' });
    expect(syncRepo.updateAccessToken).toHaveBeenCalledWith(42, 'new', '');
  });

  test('holding the lock: tokens event persists the token and releases only our own lock', async () => {
    const syncRepo = makeSyncRepo({ status: 'active', access_token: 'old', expires_at: PAST_EXPIRES });
    const redis = makeRedis('OK');
    const svc = new GoogleOAuthService(
      makeConfig() as never,
      makeUserRepo(VALID_USER) as never,
      syncRepo as never,
      redis as never,
    );
    const client = await svc.getAuthClient(42);
    const lockVal = (redis.set.mock.calls[0] as unknown as string[])[1];
    redis.get.mockImplementation(() => Promise.resolve(lockVal ?? null));
    client.emit('tokens', { access_token: 'new', expiry_date: Date.UTC(2030, 0, 1) });
    await flushAsync();
    expect(syncRepo.updateAccessToken).toHaveBeenCalledWith(42, 'new', '2030-01-01T00:00:00.000Z');
    expect(redis.del).toHaveBeenCalledWith('gcal:refresh:42');

    // `once`: a second tokens event is ignored
    client.emit('tokens', { access_token: 'again' });
    await flushAsync();
    expect(syncRepo.updateAccessToken).toHaveBeenCalledTimes(1);
  });

  test('holding the lock: a lock now owned by someone else is left alone', async () => {
    const redis = makeRedis('OK', 'someone-else');
    const svc = new GoogleOAuthService(
      makeConfig() as never,
      makeUserRepo(VALID_USER) as never,
      makeSyncRepo({ status: 'active', access_token: 'old', expires_at: PAST_EXPIRES }) as never,
      redis as never,
    );
    const client = await svc.getAuthClient(42);
    client.emit('tokens', { access_token: 'new' });
    await flushAsync();
    expect(redis.del).not.toHaveBeenCalled();
  });

  test('holding the lock: a failing release is swallowed', async () => {
    const syncRepo = makeSyncRepo({ status: 'active', access_token: 'old', expires_at: PAST_EXPIRES });
    syncRepo.updateAccessToken.mockImplementation(() => {
      throw new Error('db down');
    });
    const redis = makeRedis('OK');
    const svc = new GoogleOAuthService(
      makeConfig() as never,
      makeUserRepo(VALID_USER) as never,
      syncRepo as never,
      redis as never,
    );
    const client = await svc.getAuthClient(42);
    client.emit('tokens', { access_token: 'new' });
    await flushAsync();
    expect(redis.get).not.toHaveBeenCalled();
  });

  test('lock not acquired: waits until the lock key is released, then reads fresh state', async () => {
    const syncRepo = makeSyncRepo({ status: 'active', access_token: 'old', expires_at: PAST_EXPIRES });
    syncRepo.getSyncState
      .mockReturnValueOnce({ status: 'active', access_token: 'old', expires_at: PAST_EXPIRES })
      .mockReturnValueOnce({ status: 'active', access_token: 'fresh', expires_at: FUTURE_EXPIRES });
    const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
    const redis = makeRedis(null);
    redis.get.mockReturnValueOnce(Promise.resolve('held')).mockReturnValueOnce(Promise.resolve(null));
    const svc = new GoogleOAuthService(
      makeConfig() as never,
      makeUserRepo(VALID_USER) as never,
      syncRepo as never,
      redis as never,
    );
    const client = await svc.getAuthClient(42);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(redis.get).toHaveBeenCalledTimes(2);
    expect(client.credentials.access_token).toBe('fresh');
    expect(client.credentials.refresh_token).toBe('test-refresh-token');
  });
});
