import { net, session } from 'electron';
import keytar from 'keytar';

const API_HOST = 'https://api.anthropic.com';
// Claude Desktop first-party client — grants Opus/Sonnet via Pro subscription
const CLIENT_ID = '89355bc3-cbfd-4382-905b-976645cad410';
const REDIRECT_URI = 'https://claude.ai/desktop/callback';
const SCOPE = 'user:inference';

const KEYTAR_SERVICE = 'HyperBotAgent-OAuth';
const KEYTAR_ACCESS_TOKEN = 'access_token';
const KEYTAR_REFRESH_TOKEN = 'refresh_token';
const KEYTAR_EXPIRES_AT = 'expires_at';

function log(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const extra = data ? ' ' + JSON.stringify(data) : '';
  console.log(`[oauth ${ts}] ${msg}${extra}`);
}

// Match Claude Desktop's exact PKCE code_verifier generation:
// 32 random bytes → btoa(String.fromCharCode(...)) → replace +/= → base64url
function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateState(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('');
}

async function oauthFetch(url: string, init: RequestInit): Promise<Response> {
  return net.fetch(url, init as Parameters<typeof net.fetch>[1]);
}

// Read sessionKey and orgId from the Electron session (after initClaudeCookies)
async function getSessionCookies(): Promise<{ sessionKey: string; orgId: string } | null> {
  const ses = session.defaultSession;
  const [skCookies, orgCookies] = await Promise.all([
    ses.cookies.get({ name: 'sessionKey', url: 'https://claude.ai' }),
    ses.cookies.get({ name: 'lastActiveOrg', url: 'https://claude.ai' }),
  ]);
  if (!skCookies.length || !orgCookies.length) return null;
  return { sessionKey: skCookies[0].value, orgId: orgCookies[0].value };
}

// Full PKCE authorize + token exchange using sessionKey as Bearer auth
async function doAuthorizationCodeFlow(): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  const cookies = await getSessionCookies();
  if (!cookies) throw new Error('OAuth init failed: missing sessionKey or lastActiveOrg cookie');

  const { sessionKey, orgId } = cookies;
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  log('authorize', { orgId: orgId.substring(0, 8) + '...' });
  const authRes = await oauthFetch(`${API_HOST}/v1/oauth/${orgId}/authorize`, {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      Authorization: `Bearer ${sessionKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      response_type: 'code',
      client_id: CLIENT_ID,
      organization_uuid: orgId,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }),
  });

  if (!authRes.ok) {
    const body = await authRes.text();
    throw new Error(`OAuth authorize failed (${authRes.status}): ${body}`);
  }

  const authBody = (await authRes.json()) as { redirect_uri?: string; authorization_code?: string };
  if (!authBody.redirect_uri && !authBody.authorization_code) {
    throw new Error('OAuth authorize: no redirect_uri or authorization_code in response');
  }

  let code: string;
  if (authBody.authorization_code) {
    code = authBody.authorization_code;
  } else {
    const extracted = new URL(authBody.redirect_uri!).searchParams.get('code');
    if (!extracted) throw new Error('OAuth authorize: no code in redirect_uri');
    code = extracted;
  }

  log('token exchange');
  const tokenRes = await oauthFetch(`${API_HOST}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      Authorization: `Bearer ${sessionKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      state,
      code_verifier: codeVerifier,
      expires_in: 31536000,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`OAuth token exchange failed (${tokenRes.status}): ${body}`);
  }

  const tokenBody = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!tokenBody.access_token) throw new Error('OAuth token: no access_token in response');

  const expiresAt = Date.now() + (tokenBody.expires_in ?? 3600) * 1000;
  return {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token ?? '',
    expiresAt,
  };
}

async function doRefreshFlow(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  log('refresh token');
  const res = await oauthFetch(`${API_HOST}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      scope: SCOPE,
      expires_in: 31536000,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OAuth refresh failed (${res.status}): ${body}`);
  }

  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
    expiresAt,
  };
}

async function saveTokens(accessToken: string, refreshToken: string, expiresAt: number): Promise<void> {
  await Promise.all([
    keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCESS_TOKEN, accessToken),
    keytar.setPassword(KEYTAR_SERVICE, KEYTAR_REFRESH_TOKEN, refreshToken),
    keytar.setPassword(KEYTAR_SERVICE, KEYTAR_EXPIRES_AT, String(expiresAt)),
  ]);
}

async function loadStoredTokens(): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} | null> {
  const [at, rt, ea] = await Promise.all([
    keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCESS_TOKEN),
    keytar.getPassword(KEYTAR_SERVICE, KEYTAR_REFRESH_TOKEN),
    keytar.getPassword(KEYTAR_SERVICE, KEYTAR_EXPIRES_AT),
  ]);
  if (!at || !rt || !ea) return null;
  return { accessToken: at, refreshToken: rt, expiresAt: Number(ea) };
}

// In-memory cache
let cachedAccessToken: string | null = null;
let cachedExpiresAt = 0;
let cachedRefreshToken: string | null = null;

// Initialize: try stored tokens first, then full OAuth flow
export async function initOAuth(): Promise<void> {
  const stored = await loadStoredTokens();
  if (stored) {
    cachedAccessToken = stored.accessToken;
    cachedRefreshToken = stored.refreshToken;
    cachedExpiresAt = stored.expiresAt;
    // If token is already expired, try refresh immediately
    if (Date.now() >= cachedExpiresAt - 60_000 && cachedRefreshToken) {
      try {
        const refreshed = await doRefreshFlow(cachedRefreshToken);
        cachedAccessToken = refreshed.accessToken;
        cachedRefreshToken = refreshed.refreshToken;
        cachedExpiresAt = refreshed.expiresAt;
        await saveTokens(cachedAccessToken, cachedRefreshToken, cachedExpiresAt);
        log('refreshed token from stored refresh_token');
      } catch (err: unknown) {
        log('stored refresh failed, doing full OAuth flow', { err: err instanceof Error ? err.message : String(err) });
        cachedAccessToken = null;
      }
    } else {
      log('using stored token', { expiresInMin: Math.round((cachedExpiresAt - Date.now()) / 60000) });
    }
  }

  if (!cachedAccessToken) {
    const tokens = await doAuthorizationCodeFlow();
    cachedAccessToken = tokens.accessToken;
    cachedRefreshToken = tokens.refreshToken;
    cachedExpiresAt = tokens.expiresAt;
    await saveTokens(cachedAccessToken, cachedRefreshToken, cachedExpiresAt);
    log('OAuth init complete — new tokens acquired');
  }
}

// Get a valid access token, refreshing if needed
export async function getAccessToken(): Promise<string> {
  // Refresh 60s before expiry
  if (cachedAccessToken && Date.now() < cachedExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  if (cachedRefreshToken) {
    try {
      const tokens = await doRefreshFlow(cachedRefreshToken);
      cachedAccessToken = tokens.accessToken;
      cachedRefreshToken = tokens.refreshToken;
      cachedExpiresAt = tokens.expiresAt;
      await saveTokens(cachedAccessToken, cachedRefreshToken, cachedExpiresAt);
      return cachedAccessToken;
    } catch {
      // Fall through to full re-auth
    }
  }

  // Full re-auth
  const tokens = await doAuthorizationCodeFlow();
  cachedAccessToken = tokens.accessToken;
  cachedRefreshToken = tokens.refreshToken;
  cachedExpiresAt = tokens.expiresAt;
  await saveTokens(cachedAccessToken, cachedRefreshToken, cachedExpiresAt);
  return cachedAccessToken;
}
