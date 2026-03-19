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

export class GoogleOAuthService {
  constructor(
    private config: EnvConfig,
    private userRepo: UserRepository,
    private syncRepo: GoogleSyncRepository,
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

  getAuthClient(userId: number): OAuth2Client {
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
