// src/database/repositories/chat-history.repository.ts
import type { Database } from 'bun:sqlite';
import type { ChatHistoryMessage } from '../types.ts';

export class ChatHistoryRepository {
  constructor(private db: Database) {}

  save(userId: number, role: 'user' | 'assistant' | 'tool', content: string, chatId?: number): number {
    const result = this.db
      .prepare('INSERT INTO chat_history (user_id, role, content, chat_id) VALUES (?, ?, ?, ?)')
      .run(userId, role, content, chatId ?? null);
    return Number(result.lastInsertRowid);
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

  searchByChat(chatId: number, params: { limit?: number; search?: string }): ChatHistoryMessage[] {
    const { limit = 50, search } = params;
    const conditions: string[] = ['chat_id = ?'];
    const args: (number | string)[] = [chatId];

    if (search) {
      conditions.push('content LIKE ?');
      args.push(`%${search}%`);
    }

    const where = conditions.join(' AND ');
    return this.db
      .prepare(
        `SELECT * FROM (
          SELECT * FROM chat_history WHERE ${where}
          ORDER BY created_at DESC, id DESC LIMIT ?
        ) sub ORDER BY created_at ASC, id ASC`,
      )
      .all(...args, limit) as ChatHistoryMessage[];
  }

  getRecent(userId: number, limit = 10): ChatHistoryMessage[] {
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

  search(
    userId: number,
    params: { limit?: number; search?: string; before?: string; after?: string },
  ): ChatHistoryMessage[] {
    const { limit = 50, search, before, after } = params;
    const conditions: string[] = ['user_id = ?'];
    const args: (number | string)[] = [userId];

    if (search) {
      conditions.push('content LIKE ?');
      args.push(`%${search}%`);
    }
    if (before) {
      conditions.push('created_at < ?');
      args.push(before);
    }
    if (after) {
      conditions.push('created_at > ?');
      args.push(after);
    }

    const where = conditions.join(' AND ');
    return this.db
      .prepare(
        `SELECT * FROM (
          SELECT * FROM chat_history WHERE ${where}
          ORDER BY created_at DESC, id DESC LIMIT ?
        ) sub ORDER BY created_at ASC, id ASC`,
      )
      .all(...args, limit) as ChatHistoryMessage[];
  }

  clear(userId: number): void {
    this.db.prepare('DELETE FROM chat_history WHERE user_id = ?').run(userId);
  }
}
