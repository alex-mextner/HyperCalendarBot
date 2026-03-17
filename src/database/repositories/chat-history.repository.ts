// src/database/repositories/chat-history.repository.ts
import type { Database } from 'bun:sqlite';
import type { ChatHistoryMessage } from '../types.ts';

export class ChatHistoryRepository {
  constructor(private db: Database) {}

  save(userId: number, role: 'user' | 'assistant' | 'tool', content: string, chatId?: number): void {
    this.db
      .prepare('INSERT INTO chat_history (user_id, role, content, chat_id) VALUES (?, ?, ?, ?)')
      .run(userId, role, content, chatId ?? null);
  }

  getRecentByChat(chatId: number, limit = 10): ChatHistoryMessage[] {
    return this.db
      .prepare(`
        SELECT * FROM (
          SELECT * FROM chat_history
          WHERE chat_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        ) sub ORDER BY created_at ASC, id ASC
      `)
      .all(chatId, limit) as ChatHistoryMessage[];
  }

  getRecent(userId: number, limit = 50): ChatHistoryMessage[] {
    return this.db
      .prepare(`
        SELECT * FROM (
          SELECT * FROM chat_history
          WHERE user_id = ? AND chat_id IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        ) sub ORDER BY created_at ASC, id ASC
      `)
      .all(userId, limit) as ChatHistoryMessage[];
  }

  clear(userId: number): void {
    this.db.prepare('DELETE FROM chat_history WHERE user_id = ?').run(userId);
  }
}
