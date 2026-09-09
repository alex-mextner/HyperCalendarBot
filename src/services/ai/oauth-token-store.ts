// src/services/ai/oauth-token-store.ts
import type { AgentOauthTokenRepository } from '../../database/repositories/agent-oauth-token.repository.ts';
import { encrypt } from '../../utils/crypto.ts';
import { logger } from '../../utils/logger.ts';

const storeLogger = logger.child({ module: 'oauth-token-store' });

/**
 * Repository-backed pairing/storage sink for the Anthropic OAuth tokens the Mac
 * agent already holds (it authenticates as Claude Desktop client-side; that flow
 * is unaffected by this store). The repository is the source of truth — there is
 * no in-memory cache to preload, so this store carries no read path. Consuming
 * these tokens to route live AI turns is a separate, deferred piece of work (see
 * docs/specs/2026-09-09-desktop-oauth-design.md); nothing here ever calls
 * api.anthropic.com.
 */
export class OauthTokenStore {
  constructor(
    private repo: AgentOauthTokenRepository,
    private encryptionKey: string | undefined,
  ) {}

  updateTokens(userId: number, accessToken: string, refreshToken: string, expiresAt: number): void {
    if (!this.encryptionKey) {
      storeLogger.warn({ userId }, 'ENCRYPTION_KEY not configured — dropping Anthropic OAuth token push');
      return;
    }
    const accessTokenEnc = encrypt(accessToken, this.encryptionKey);
    const refreshTokenEnc = encrypt(refreshToken, this.encryptionKey);
    this.repo.upsert(userId, accessTokenEnc, refreshTokenEnc, expiresAt);
    storeLogger.debug({ userId }, 'Anthropic OAuth token stored');
  }
}
