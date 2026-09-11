import { beforeAll, describe, expect, mock, test } from 'bun:test';

// oauth-manager.ts imports 'electron' and 'keytar' at module scope; both are
// stubbed here so the module loads under plain bun instead of the Electron
// main process, and so token exchange/refresh can be driven deterministically.

const cookiesGetMock = mock(async ({ name }: { name: string; url: string }) => {
  if (name === 'sessionKey') return [{ value: 'session-key-value' }];
  if (name === 'lastActiveOrg') return [{ value: 'org-uuid-value' }];
  return [];
});

const netFetchMock = mock(async (url: string, init: RequestInit) => {
  const body = init.body ? (JSON.parse(init.body as string) as { grant_type?: string }) : {};
  if (url.includes('/authorize')) {
    return new Response(JSON.stringify({ authorization_code: 'auth-code-1' }), { status: 200 });
  }
  if (body.grant_type === 'refresh_token') {
    return new Response(
      JSON.stringify({ access_token: 'refreshed-at-1', refresh_token: 'refreshed-rt-1', expires_in: 3600 }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ access_token: 'full-at-1', refresh_token: 'full-rt-1', expires_in: 30 }), {
    status: 200,
  });
});

mock.module('electron', () => ({
  net: { fetch: netFetchMock },
  session: { defaultSession: { cookies: { get: cookiesGetMock } } },
}));

const keytarState: { access: string | null; refresh: string | null; expiresAt: string | null } = {
  access: null,
  refresh: null,
  expiresAt: null,
};
const getPasswordMock = mock(async (_service: string, key: string) => {
  if (key === 'access_token') return keytarState.access;
  if (key === 'refresh_token') return keytarState.refresh;
  if (key === 'expires_at') return keytarState.expiresAt;
  return null;
});
const setPasswordMock = mock(async (_service: string, key: string, value: string) => {
  if (key === 'access_token') keytarState.access = value;
  if (key === 'refresh_token') keytarState.refresh = value;
  if (key === 'expires_at') keytarState.expiresAt = value;
});

mock.module('keytar', () => ({
  default: { getPassword: getPasswordMock, setPassword: setPasswordMock },
}));

// Import after mocking
const { initOAuth, getAccessToken, setOnTokensRefreshed, getCachedTokens } = await import(
  '../../packages/agent-macos/src/oauth-manager.ts'
);

const onTokensRefreshedSpy = mock((_accessToken: string, _refreshToken: string, _expiresAt: number) => {});
setOnTokensRefreshed(onTokensRefreshedSpy);

describe('oauth-manager token-push notifications', () => {
  beforeAll(() => {
    onTokensRefreshedSpy.mockClear();
  });

  test('getCachedTokens() returns null before any tokens are acquired', () => {
    expect(getCachedTokens()).toBeNull();
  });

  test('getAccessToken() runs the full OAuth flow and notifies with the acquired tokens when nothing is cached', async () => {
    const accessToken = await getAccessToken();

    expect(accessToken).toBe('full-at-1');
    expect(onTokensRefreshedSpy).toHaveBeenCalledTimes(1);
    expect(onTokensRefreshedSpy).toHaveBeenLastCalledWith('full-at-1', 'full-rt-1', expect.any(Number));
    expect(getCachedTokens()).toEqual({
      accessToken: 'full-at-1',
      refreshToken: 'full-rt-1',
      expiresAt: expect.any(Number),
    });
  });

  test('getAccessToken() refreshes and notifies with the refreshed tokens once the cached token is near expiry', async () => {
    // The previous test cached a token with a 30s expiry, which is inside the
    // 60s refresh-ahead window, so this call must go through doRefreshFlow.
    onTokensRefreshedSpy.mockClear();

    const accessToken = await getAccessToken();

    expect(accessToken).toBe('refreshed-at-1');
    expect(onTokensRefreshedSpy).toHaveBeenCalledTimes(1);
    expect(onTokensRefreshedSpy).toHaveBeenLastCalledWith('refreshed-at-1', 'refreshed-rt-1', expect.any(Number));
    expect(getCachedTokens()).toEqual({
      accessToken: 'refreshed-at-1',
      refreshToken: 'refreshed-rt-1',
      expiresAt: expect.any(Number),
    });
  });

  test('initOAuth() loads an unexpired stored token and notifies with the stored values', async () => {
    onTokensRefreshedSpy.mockClear();
    netFetchMock.mockClear();
    const farFutureExpiresAt = Date.now() + 3600_000;
    keytarState.access = 'stored-at';
    keytarState.refresh = 'stored-rt';
    keytarState.expiresAt = String(farFutureExpiresAt);

    await initOAuth();

    expect(netFetchMock).not.toHaveBeenCalled();
    expect(onTokensRefreshedSpy).toHaveBeenCalledTimes(1);
    expect(onTokensRefreshedSpy).toHaveBeenLastCalledWith('stored-at', 'stored-rt', farFutureExpiresAt);
    expect(getCachedTokens()).toEqual({
      accessToken: 'stored-at',
      refreshToken: 'stored-rt',
      expiresAt: farFutureExpiresAt,
    });
  });
});
