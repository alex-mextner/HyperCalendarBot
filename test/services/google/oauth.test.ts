import { afterEach, describe, expect, type Mock, mock, spyOn, test } from 'bun:test';
import type { EnvConfig } from '../../../src/config/env.ts';
import type { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import type { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import type { GoogleSyncState, User } from '../../../src/database/types.ts';
import { GoogleOAuthService, type RedisLockClient } from '../../../src/services/google/oauth.ts';
import { encrypt } from '../../../src/utils/crypto.ts';
import { STORED_AT, userRow } from '../ai/context-fixtures.ts';
import { partialOf } from '../ai/partial-stubs.ts';

// 32-byte key expressed as 64 hex chars
const ENCRYPTION_KEY = '0'.repeat(64);

function syncStateRow(overrides: Partial<GoogleSyncState> = {}): GoogleSyncState {
  return {
    user_id: 42,
    access_token: null,
    expires_at: null,
    scopes: 'https://www.googleapis.com/auth/calendar.events',
    status: 'active',
    created_at: STORED_AT,
    updated_at: STORED_AT,
    ...overrides,
  };
}

interface SyncRepoMocks {
  getSyncState: Mock<(userId: number) => GoogleSyncState | null>;
  updateAccessToken: Mock<(userId: number, accessToken: string, expiresAt: string) => void>;
}

function makeSyncRepo(state: GoogleSyncState | null = null): SyncRepoMocks {
  return {
    getSyncState: mock((_userId: number): GoogleSyncState | null => state),
    updateAccessToken: mock((_userId: number, _accessToken: string, _expiresAt: string): void => {}),
  };
}

function makeRedis(setResult: string | null = 'OK', getResult: string | null = null) {
  return {
    set: mock(
      (_key: string, _value: string, _mode: 'NX', _expMode: 'EX', _seconds: number): Promise<string | null> =>
        Promise.resolve(setResult),
    ),
    get: mock((_key: string): Promise<string | null> => Promise.resolve(getResult)),
    del: mock((_key: string): Promise<number> => Promise.resolve(1)),
  };
}

function makeService(user: User | null, syncRepo: SyncRepoMocks, redis?: RedisLockClient): GoogleOAuthService {
  // The service reads only these four settings; any other one throws if the code starts using it.
  const config = partialOf<EnvConfig>('config', {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csec',
    GOOGLE_REDIRECT_URI: 'http://localhost/cb',
    ENCRYPTION_KEY,
  });
  const userRepo = partialOf<UserRepository>('userRepo', { findByTelegramId: () => user });
  return new GoogleOAuthService(config, userRepo, partialOf<GoogleSyncRepository>('syncRepo', syncRepo), redis);
}

const VALID_USER = userRow({
  telegram_id: 42,
  google_refresh_token_enc: encrypt('test-refresh-token', ENCRYPTION_KEY),
});

// Lets the async 'tokens' listener (several awaited Redis calls) run to completion.
const flushAsync = () => new Promise<void>((resolve) => setImmediate(resolve));

const FUTURE_EXPIRES = new Date(Date.now() + 60 * 60_000).toISOString(); // 1h from now
const PAST_EXPIRES = new Date(Date.now() - 60_000).toISOString(); // 1m ago

describe('GoogleOAuthService.getAuthClient', () => {
  afterEach(() => {
    mock.restore();
  });

  test('throws GoogleNotConnectedError when user has no refresh token', async () => {
    const svc = makeService(userRow({ telegram_id: 42 }), makeSyncRepo());
    await expect(svc.getAuthClient(42)).rejects.toMatchObject({ name: 'GoogleNotConnectedError' });
  });

  test('throws GoogleTokenRevokedError when sync state is revoked', async () => {
    const svc = makeService(VALID_USER, makeSyncRepo(syncStateRow({ status: 'revoked' })));
    await expect(svc.getAuthClient(42)).rejects.toMatchObject({ name: 'GoogleTokenRevokedError' });
  });

  test('acquires Redis lock when token is expired', async () => {
    const redis = makeRedis('OK');
    const svc = makeService(
      VALID_USER,
      makeSyncRepo(syncStateRow({ access_token: 'old', expires_at: PAST_EXPIRES })),
      redis,
    );
    await svc.getAuthClient(42);
    expect(redis.set).toHaveBeenCalledWith('gcal:refresh:42', expect.any(String), 'NX', 'EX', 30);
  });

  test('skips Redis lock when token is still valid', async () => {
    const redis = makeRedis('OK');
    const svc = makeService(
      VALID_USER,
      makeSyncRepo(syncStateRow({ access_token: 'fresh', expires_at: FUTURE_EXPIRES })),
      redis,
    );
    await svc.getAuthClient(42);
    expect(redis.set).not.toHaveBeenCalled();
  });

  test('re-reads DB when lock is not acquired (another process is refreshing)', async () => {
    const syncRepo = makeSyncRepo(syncStateRow({ access_token: 'old', expires_at: PAST_EXPIRES }));
    // First getSyncState call returns stale; second returns fresh (after lock released)
    syncRepo.getSyncState
      .mockReturnValueOnce(syncStateRow({ access_token: 'old', expires_at: PAST_EXPIRES }))
      .mockReturnValueOnce(syncStateRow({ access_token: 'fresh', expires_at: FUTURE_EXPIRES }));

    // Lock not acquired (NX set returns null), then lock released quickly (get returns null)
    const redis = makeRedis(null, null);
    const svc = makeService(VALID_USER, syncRepo, redis);
    const client = await svc.getAuthClient(42);
    expect(client).toBeDefined();
    // Re-read after lock release
    expect(syncRepo.getSyncState).toHaveBeenCalledTimes(2);
  });

  test('works without Redis (no lock)', async () => {
    const svc = makeService(VALID_USER, makeSyncRepo(syncStateRow({ access_token: 'tok', expires_at: PAST_EXPIRES })));
    const client = await svc.getAuthClient(42);
    expect(client).toBeDefined();
  });

  test('persists a refreshed access token on the tokens event without Redis', async () => {
    const syncRepo = makeSyncRepo(syncStateRow({ access_token: 'tok', expires_at: FUTURE_EXPIRES }));
    const svc = makeService(VALID_USER, syncRepo);
    const client = await svc.getAuthClient(42);
    client.emit('tokens', { access_token: 'new', expiry_date: Date.UTC(2030, 0, 1) });
    client.emit('tokens', { expiry_date: 1 });
    expect(syncRepo.updateAccessToken).toHaveBeenCalledTimes(1);
    expect(syncRepo.updateAccessToken).toHaveBeenCalledWith(42, 'new', '2030-01-01T00:00:00.000Z');
    expect((await client.getAccessToken()).token).toBe('tok');
  });

  test('stores an empty expiry when the tokens event carries none', async () => {
    const syncRepo = makeSyncRepo(syncStateRow({ access_token: 'tok', expires_at: FUTURE_EXPIRES }));
    const svc = makeService(VALID_USER, syncRepo);
    const client = await svc.getAuthClient(42);
    client.emit('tokens', { access_token: 'new' });
    expect(syncRepo.updateAccessToken).toHaveBeenCalledWith(42, 'new', '');
  });

  test('holding the lock: tokens event persists the token and releases only our own lock', async () => {
    const syncRepo = makeSyncRepo(syncStateRow({ access_token: 'old', expires_at: PAST_EXPIRES }));
    const redis = makeRedis('OK');
    const svc = makeService(VALID_USER, syncRepo, redis);
    const client = await svc.getAuthClient(42);
    const lockVal = redis.set.mock.calls[0]?.[1];
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
    const svc = makeService(
      VALID_USER,
      makeSyncRepo(syncStateRow({ access_token: 'old', expires_at: PAST_EXPIRES })),
      redis,
    );
    const client = await svc.getAuthClient(42);
    client.emit('tokens', { access_token: 'new' });
    await flushAsync();
    expect(redis.del).not.toHaveBeenCalled();
  });

  test('holding the lock: a failing release is swallowed', async () => {
    const syncRepo = makeSyncRepo(syncStateRow({ access_token: 'old', expires_at: PAST_EXPIRES }));
    syncRepo.updateAccessToken.mockImplementation(() => {
      throw new Error('db down');
    });
    const redis = makeRedis('OK');
    const svc = makeService(VALID_USER, syncRepo, redis);
    const client = await svc.getAuthClient(42);
    client.emit('tokens', { access_token: 'new' });
    await flushAsync();
    expect(redis.get).not.toHaveBeenCalled();
  });

  test('lock not acquired: waits until the lock key is released, then reads fresh state', async () => {
    const syncRepo = makeSyncRepo(syncStateRow({ access_token: 'old', expires_at: PAST_EXPIRES }));
    syncRepo.getSyncState
      .mockReturnValueOnce(syncStateRow({ access_token: 'old', expires_at: PAST_EXPIRES }))
      .mockReturnValueOnce(syncStateRow({ access_token: 'fresh', expires_at: FUTURE_EXPIRES }));
    const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
    const redis = makeRedis(null);
    redis.get.mockReturnValueOnce(Promise.resolve('held')).mockReturnValueOnce(Promise.resolve(null));
    const svc = makeService(VALID_USER, syncRepo, redis);
    const client = await svc.getAuthClient(42);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(redis.get).toHaveBeenCalledTimes(2);
    expect(client.credentials.access_token).toBe('fresh');
    expect(client.credentials.refresh_token).toBe('test-refresh-token');
  });
});
