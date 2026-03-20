// src/database/repositories/group-session.repository.ts
import type { Database } from 'bun:sqlite';
import type { GroupSession } from '../../services/group/group-session.ts';

interface GroupSessionRow {
  chat_id: number;
  activated_by: number;
  remaining_messages: number;
  last_bot_message_id: number;
  expires_at: number;
}

export class GroupSessionRepository {
  constructor(private db: Database) {}

  get(chatId: number): GroupSession | null {
    const row = this.db.prepare('SELECT * FROM group_sessions WHERE chat_id = ?').get(chatId) as GroupSessionRow | null;
    if (!row) return null;
    return {
      chatId: row.chat_id,
      activatedBy: row.activated_by,
      remainingMessages: row.remaining_messages,
      lastBotMessageId: row.last_bot_message_id,
      expiresAt: row.expires_at,
    };
  }

  upsert(session: GroupSession): void {
    this.db
      .prepare(
        `INSERT INTO group_sessions (chat_id, activated_by, remaining_messages, last_bot_message_id, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET
           activated_by = excluded.activated_by,
           remaining_messages = excluded.remaining_messages,
           last_bot_message_id = excluded.last_bot_message_id,
           expires_at = excluded.expires_at`,
      )
      .run(session.chatId, session.activatedBy, session.remainingMessages, session.lastBotMessageId, session.expiresAt);
  }

  delete(chatId: number): void {
    this.db.prepare('DELETE FROM group_sessions WHERE chat_id = ?').run(chatId);
  }

  deleteExpired(): void {
    this.db.prepare('DELETE FROM group_sessions WHERE expires_at <= ? OR remaining_messages <= 0').run(Date.now());
  }
}
