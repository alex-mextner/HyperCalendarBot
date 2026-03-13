// src/web/oauth-callback.ts
import type { EnvConfig } from '../config/env.ts';
import type { GoogleCalendarRepository } from '../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../database/repositories/google-sync.repository.ts';
import type { UserRepository } from '../database/repositories/user.repository.ts';
import type { GoogleOAuthService } from '../services/google/oauth.ts';
import { encrypt } from '../utils/crypto.ts';
import { webLogger } from '../utils/logger.ts';

interface OAuthStateLookup {
  get(stateId: string): Promise<string | null>;
  del(stateId: string): Promise<void>;
}

export interface OAuthCallbackDeps {
  config: EnvConfig;
  oauthService: GoogleOAuthService;
  userRepo: UserRepository;
  syncRepo: GoogleSyncRepository;
  calendarRepo: GoogleCalendarRepository;
  stateLookup: OAuthStateLookup;
  onConnected?: (userId: number) => Promise<void>;
}

export async function handleOAuthCallback(req: Request, deps: OAuthCallbackDeps): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    webLogger.warn({ error }, 'OAuth denied by user');
    return new Response('<html><body><h2>Authorization denied.</h2><p>You can close this tab.</p></body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 });
  }

  const payload = await deps.stateLookup.get(state);
  if (!payload) {
    return new Response('State expired or invalid', { status: 400 });
  }
  await deps.stateLookup.del(state);

  const { telegram_user_id: userId } = JSON.parse(payload) as { telegram_user_id: number };

  try {
    const tokens = await deps.oauthService.exchangeCode(code);

    if (!deps.config.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY not configured');
    }

    const encryptedRefreshToken = encrypt(tokens.refreshToken, deps.config.ENCRYPTION_KEY);
    deps.userRepo.updateGoogleToken(userId, encryptedRefreshToken);

    deps.syncRepo.upsertSyncState(userId, deps.oauthService.scopes);
    deps.syncRepo.updateAccessToken(userId, tokens.accessToken, new Date(tokens.expiresAt).toISOString());

    webLogger.info({ userId }, 'Google OAuth completed');

    if (deps.onConnected) {
      await deps.onConnected(userId);
    }

    return new Response(
      '<html><body><h2>Connected!</h2><p>Return to Telegram to choose which calendars to sync.</p></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    );
  } catch (err) {
    webLogger.error({ error: String(err), userId }, 'OAuth token exchange failed');
    return new Response('Authorization failed. Please try again.', { status: 500 });
  }
}
