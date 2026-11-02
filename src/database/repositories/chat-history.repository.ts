// src/database/repositories/chat-history.repository.ts
import type { Database } from 'bun:sqlite';
import type { ChatHistoryMessage } from '../types.ts';

/** `AND id NOT IN (?, …)` for the given rows; nothing when there are none. */
function excludedRowsSql(excludeIds: ReadonlySet<number>): string {
  return excludeIds.size > 0 ? `AND id NOT IN (${[...excludeIds].map(() => '?').join(', ')})` : '';
}

const COLUMNS = 'id, user_id, role, content, chat_id, created_at';
/** Reading order of a conversation: by time, then by where a turn was placed (its own id unless it was moved after later rows). */
const ORDER_ASC = 'created_at ASC, COALESCE(turn_order, id) ASC, id ASC';
const ORDER_DESC = 'created_at DESC, COALESCE(turn_order, id) DESC, id DESC';

export class ChatHistoryRepository {
  constructor(private db: Database) {}

  save(userId: number, role: 'user' | 'assistant' | 'tool', content: string, chatId?: number): number {
    const result = this.db
      .prepare('INSERT INTO chat_history (user_id, role, content, chat_id) VALUES (?, ?, ?, ?)')
      .run(userId, role, content, chatId ?? null);
    return Number(result.lastInsertRowid);
  }

  /**
   * Puts a user turn after everything saved so far, keeping its id. A message that waited behind an earlier
   * run was saved before what that run wrote, so by row order it sits in the middle of that run's output; the
   * model must read «earlier request, what was done, this message». The row keeps its id (the action log,
   * the per-user map and every context built from it stay valid, and ids stay the order messages arrived
   * in); only where it reads moves. Returns false when the row is not a user turn of `userId`.
   */
  placeUserTurnAfterLatest(rowId: number, userId: number): boolean {
    // "After" means after a bot row of the same conversation: the group's rows (whoever triggered them), or
    // the user's private rows.
    const result = this.db
      .prepare(
        `UPDATE chat_history
         SET created_at = datetime('now'), turn_order = (SELECT MAX(id) FROM chat_history) + 0.5
         WHERE id = ? AND user_id = ? AND role = 'user'
           AND EXISTS (
             SELECT 1 FROM chat_history later
             WHERE later.id > chat_history.id AND later.role != 'user'
               AND (CASE WHEN chat_history.chat_id IS NULL
                         THEN later.chat_id IS NULL AND later.user_id = chat_history.user_id
                         ELSE later.chat_id = chat_history.chat_id END))`,
      )
      .run(rowId, userId);
    return result.changes > 0;
  }

  /** `excludeIds` rows (turns queued behind the reader) are left out BEFORE the limit, so they cost no context. */
  getRecentByChat(chatId: number, limit = 10, excludeIds: ReadonlySet<number> = new Set()): ChatHistoryMessage[] {
    return this.db
      .prepare(`
        SELECT ${COLUMNS} FROM (
          SELECT ${COLUMNS}, turn_order FROM chat_history
          WHERE chat_id = ? ${excludedRowsSql(excludeIds)}
          ORDER BY ${ORDER_DESC}
          LIMIT ?
        ) sub ORDER BY ${ORDER_ASC}
      `)
      .all(chatId, ...excludeIds, limit) as ChatHistoryMessage[];
  }

  searchByChat(
    chatId: number,
    params: { limit?: number; search?: string; excludeIds?: ReadonlySet<number> },
  ): ChatHistoryMessage[] {
    const { limit = 50, search, excludeIds = new Set<number>() } = params;
    const conditions: string[] = ['chat_id = ?'];
    const args: (number | string)[] = [chatId];
    if (excludeIds.size > 0) {
      conditions.push(`id NOT IN (${[...excludeIds].map(() => '?').join(', ')})`);
      args.push(...excludeIds);
    }

    if (search) {
      conditions.push('content LIKE ?');
      args.push(`%${search}%`);
    }

    const where = conditions.join(' AND ');
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM (
          SELECT ${COLUMNS}, turn_order FROM chat_history WHERE ${where}
          ORDER BY ${ORDER_DESC} LIMIT ?
        ) sub ORDER BY ${ORDER_ASC}`,
      )
      .all(...args, limit) as ChatHistoryMessage[];
  }

  getRecent(userId: number, limit = 10, excludeIds: ReadonlySet<number> = new Set()): ChatHistoryMessage[] {
    return this.db
      .prepare(`
        SELECT ${COLUMNS} FROM (
          SELECT ${COLUMNS}, turn_order FROM chat_history
          WHERE user_id = ? AND chat_id IS NULL ${excludedRowsSql(excludeIds)}
          ORDER BY ${ORDER_DESC}
          LIMIT ?
        ) sub ORDER BY ${ORDER_ASC}
      `)
      .all(userId, ...excludeIds, limit) as ChatHistoryMessage[];
  }

  search(
    userId: number,
    params: { limit?: number; search?: string; before?: string; after?: string; excludeIds?: ReadonlySet<number> },
  ): ChatHistoryMessage[] {
    const { limit = 50, search, before, after, excludeIds = new Set<number>() } = params;
    const conditions: string[] = ['user_id = ?'];
    const args: (number | string)[] = [userId];
    if (excludeIds.size > 0) {
      conditions.push(`id NOT IN (${[...excludeIds].map(() => '?').join(', ')})`);
      args.push(...excludeIds);
    }

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
        `SELECT ${COLUMNS} FROM (
          SELECT ${COLUMNS}, turn_order FROM chat_history WHERE ${where}
          ORDER BY ${ORDER_DESC} LIMIT ?
        ) sub ORDER BY ${ORDER_ASC}`,
      )
      .all(...args, limit) as ChatHistoryMessage[];
  }

  deleteOlderThan(days: number): number {
    const result = this.db
      .prepare(`DELETE FROM chat_history WHERE created_at < datetime('now', ? || ' days')`)
      .run(`-${days}`);
    return result.changes;
  }

  clear(userId: number): void {
    this.db.prepare('DELETE FROM chat_history WHERE user_id = ?').run(userId);
  }
}
