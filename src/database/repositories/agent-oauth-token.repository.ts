// src/database/repositories/agent-oauth-token.repository.ts
import type { Database } from 'bun:sqlite';
import type { AgentOauthToken } from '../types.ts';

export class AgentOauthTokenRepository {
  constructor(private db: Database) {}

  findByUserId(userId: number): AgentOauthToken | null {
    return this.db.prepare('SELECT * FROM agent_oauth_tokens WHERE user_id = ?').get(userId) as AgentOauthToken | null;
  }

  upsert(userId: number, accessTokenEnc: string, refreshTokenEnc: string, expiresAt: number): void {
    this.db
      .prepare(
        `INSERT INTO agent_oauth_tokens (user_id, access_token_enc, refresh_token_enc, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           expires_at = excluded.expires_at,
           updated_at = datetime('now')`,
      )
      .run(userId, accessTokenEnc, refreshTokenEnc, expiresAt);
  }

  deleteByUserId(userId: number): void {
    this.db.prepare('DELETE FROM agent_oauth_tokens WHERE user_id = ?').run(userId);
  }
}
