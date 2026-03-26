// src/services/google/oauth.ts
import type { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import type { EnvConfig } from '../../config/env.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import { decrypt } from '../../utils/crypto.ts';
import { syncLogger } from '../../utils/logger.ts';

export class GoogleNotConnectedError extends Error {
  constructor(public userId: number) {
    super(`Google Calendar not connected for user ${userId}`);
    this.name = 'GoogleNotConnectedError';
  }
}

export class GoogleTokenRevokedError extends Error {
  constructor(public userId: number) {
    super(`Google token revoked for user ${userId}`);
    this.name = 'GoogleTokenRevokedError';
  }
}

const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

// Minimal Redis interface required for token refresh locking
export interface RedisLockClient {
  set(key: string, value: string, mode: 'NX', expMode: 'EX', seconds: number): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

// Token refresh is guarded by a 5-minute window: if the stored token expires
// within this threshold we treat it as expired and refresh proactively.
const REFRESH_THRESHOLD_MS = 5 * 60_000;

export class GoogleOAuthService {
  constructor(
    private config: EnvConfig,
    private userRepo: UserRepository,
    private syncRepo: GoogleSyncRepository,
    private redis?: RedisLockClient,
  ) {}

  private assertGoogleConfigured(): void {
    if (!this.config.GOOGLE_CLIENT_ID || !this.config.GOOGLE_CLIENT_SECRET) {
      throw new Error('Google OAuth not configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required');
    }
  }

  isConfigured(): boolean {
    return !!(this.config.GOOGLE_CLIENT_ID && this.config.GOOGLE_CLIENT_SECRET);
  }

  createOAuth2Client(): OAuth2Client {
    this.assertGoogleConfigured();
    return new google.auth.OAuth2(
      this.config.GOOGLE_CLIENT_ID,
      this.config.GOOGLE_CLIENT_SECRET,
      this.config.GOOGLE_REDIRECT_URI,
    );
  }

  generateAuthUrl(stateId: string): string {
    const client = this.createOAuth2Client();
    return client.generateAuthUrl({
      access_type: 'offline',
      scope: GOOGLE_CALENDAR_SCOPES,
      state: stateId,
      prompt: 'consent',
    });
  }

  async exchangeCode(code: string): Promise<{ refreshToken: string; accessToken: string; expiresAt: number }> {
    const client = this.createOAuth2Client();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('No refresh token received — user may need to revoke and reconnect');
    }
    return {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token ?? '',
      expiresAt: tokens.expiry_date ?? Date.now() + 3600_000,
    };
  }

  async getAuthClient(userId: number): Promise<OAuth2Client> {
    const user = this.userRepo.findByTelegramId(userId);
    if (!user?.google_refresh_token_enc) {
      throw new GoogleNotConnectedError(userId);
    }

    const syncState = this.syncRepo.getSyncState(userId);
    if (syncState?.status === 'revoked') {
      throw new GoogleTokenRevokedError(userId);
    }

    if (!this.config.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY not configured');
    }

    const refreshToken = decrypt(user.google_refresh_token_enc, this.config.ENCRYPTION_KEY);
    const client = this.createOAuth2Client();

    // Determine if a proactive refresh is needed (token expired or expires within threshold)
    const thresholdIso = new Date(Date.now() + REFRESH_THRESHOLD_MS).toISOString();
    const needsRefresh = !syncState?.expires_at || syncState.expires_at < thresholdIso;

    if (needsRefresh && this.redis) {
      const lockKey = `gcal:refresh:${userId}`;
      const lockVal = crypto.randomUUID();
      const acquired = await this.redis.set(lockKey, lockVal, 'NX', 'EX', 30);

      if (!acquired) {
        // Another process holds the lock — wait for them to finish refreshing
        let waited = 0;
        while (waited < 10_000) {
          await Bun.sleep(500);
          waited += 500;
          if (!(await this.redis.get(lockKey))) break;
        }
        // Re-read potentially-refreshed state from DB
        const freshState = this.syncRepo.getSyncState(userId);
        client.setCredentials({
          refresh_token: refreshToken,
          access_token: freshState?.access_token ?? undefined,
        });
        return client;
      }

      // We hold the lock — google-auth-library will refresh on first API call.
      // Release the lock once the tokens event fires.
      client.setCredentials({
        refresh_token: refreshToken,
        access_token: syncState?.access_token ?? undefined,
      });

      const redis = this.redis;
      client.once('tokens', async (newTokens) => {
        if (newTokens.access_token) {
          this.syncRepo.updateAccessToken(
            userId,
            newTokens.access_token,
            newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : '',
          );
        }
        const current = await redis.get(lockKey);
        if (current === lockVal) await redis.del(lockKey);
      });

      return client;
    }

    // No Redis or token still valid — set credentials and register token update handler
    client.setCredentials({
      refresh_token: refreshToken,
      access_token: syncState?.access_token ?? undefined,
    });

    client.on('tokens', (newTokens) => {
      if (newTokens.access_token) {
        this.syncRepo.updateAccessToken(
          userId,
          newTokens.access_token,
          newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : '',
        );
      }
    });

    return client;
  }

  async revokeToken(refreshToken: string): Promise<void> {
    const client = this.createOAuth2Client();
    try {
      await client.revokeToken(refreshToken);
    } catch (err) {
      syncLogger.warn({ err: err }, 'Token revocation failed (may already be revoked)');
    }
  }

  get scopes(): string {
    return GOOGLE_CALENDAR_SCOPES.join(' ');
  }
}
