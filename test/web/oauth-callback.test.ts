// test/web/oauth-callback.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { handleOAuthCallback } from '../../src/web/oauth-callback.ts';

function createMockDeps(overrides: Record<string, unknown> = {}) {
  return {
    config: { ENCRYPTION_KEY: 'a'.repeat(64) },
    oauthService: {
      exchangeCode: mock(() =>
        Promise.resolve({
          refreshToken: 'rt',
          accessToken: 'at',
          expiresAt: Date.now() + 3600000,
        }),
      ),
      scopes: 'calendar.events',
    },
    userRepo: { updateGoogleToken: mock(() => {}) },
    syncRepo: {
      upsertSyncState: mock(() => {}),
      updateAccessToken: mock(() => {}),
    },
    calendarRepo: {},
    stateLookup: {
      get: mock(() => Promise.resolve(JSON.stringify({ telegram_user_id: 42 }))),
      del: mock(() => Promise.resolve()),
    },
    onConnected: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('handleOAuthCallback', () => {
  test('returns 400 when code or state missing', async () => {
    const req = new Request('http://localhost/oauth/google/callback');
    const res = await handleOAuthCallback(req, createMockDeps() as never);
    expect(res.status).toBe(400);
  });

  test('returns 400 when state is expired/invalid', async () => {
    const req = new Request('http://localhost/oauth/google/callback?code=abc&state=bad');
    const deps = createMockDeps({
      stateLookup: { get: mock(() => Promise.resolve(null)), del: mock(() => Promise.resolve()) },
    });
    const res = await handleOAuthCallback(req, deps as never);
    expect(res.status).toBe(400);
  });

  test('stores encrypted token on successful exchange', async () => {
    const deps = createMockDeps();
    const req = new Request('http://localhost/oauth/google/callback?code=abc&state=valid');
    const res = await handleOAuthCallback(req, deps as never);
    expect(res.status).toBe(200);
    expect(deps.userRepo.updateGoogleToken).toHaveBeenCalledTimes(1);
    expect(deps.stateLookup.del).toHaveBeenCalledTimes(1);
  });

  test('shows denial page when error param present', async () => {
    const req = new Request('http://localhost/oauth/google/callback?error=access_denied');
    const res = await handleOAuthCallback(req, createMockDeps() as never);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('denied');
  });
});
