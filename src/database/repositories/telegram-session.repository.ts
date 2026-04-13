// src/database/repositories/telegram-session.repository.ts
import type { Database } from 'bun:sqlite';
import type { TelegramSession } from '../types.ts';

export class TelegramSessionRepository {
  constructor(private db: Database) {}

  findByUserId(userId: number): TelegramSession | null {
    return this.db
      .prepare('SELECT * FROM user_telegram_sessions WHERE user_id = ?')
      .get(userId) as TelegramSession | null;
  }

  getActive(userId: number): TelegramSession | null {
    return this.db
      .prepare("SELECT * FROM user_telegram_sessions WHERE user_id = ? AND status = 'active'")
      .get(userId) as TelegramSession | null;
  }

  findByPhoneHash(phoneHash: string): TelegramSession | null {
    return this.db
      .prepare('SELECT * FROM user_telegram_sessions WHERE phone_hash = ?')
      .get(phoneHash) as TelegramSession | null;
  }

  getMostRecentActive(): TelegramSession | null {
    return this.db
      .prepare("SELECT * FROM user_telegram_sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1")
      .get() as TelegramSession | null;
  }

  upsert(userId: number, encryptedSession: Buffer, encryptedPhone: Buffer, phoneHash: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM user_telegram_sessions WHERE phone_hash = ? AND user_id <> ?')
        .run(phoneHash, userId);
      this.db
        .prepare(
          `INSERT INTO user_telegram_sessions (user_id, encrypted_session, encrypted_phone, phone_hash)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             encrypted_session = excluded.encrypted_session,
             encrypted_phone = excluded.encrypted_phone,
             phone_hash = excluded.phone_hash,
             status = 'active',
             updated_at = datetime('now')`,
        )
        .run(userId, encryptedSession, encryptedPhone, phoneHash);
    })();
  }

  updateStatus(userId: number, status: 'active' | 'expired' | 'revoked'): void {
    this.db
      .prepare("UPDATE user_telegram_sessions SET status = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(status, userId);
  }

  deleteByUserId(userId: number): void {
    this.db.prepare('DELETE FROM user_telegram_sessions WHERE user_id = ?').run(userId);
  }
}
