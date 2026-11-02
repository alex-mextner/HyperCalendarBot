// src/database/repositories/chat-history.repository.ts
import type { Database } from 'bun:sqlite';
import type { ChatHistoryMessage } from '../types.ts';

/** `id NOT IN (?, …)` for the given rows. */
function excludedRowsSql(excludeIds: ReadonlySet<number>): string {
  return `id NOT IN (${[...excludeIds].map(() => '?').join(', ')})`;
}

const COLUMNS = 'id, user_id, role, content, chat_id, created_at, turn_order';
/**
 * When a row reads in the conversation: its own time, or for a turn that was moved after later rows
 * (`turn_order` = the newest row's id at the move + 0.5) the time of that newest row. `created_at` itself is
 * never rewritten: it stays the time the user sent the message.
 */
const POSITION_AT =
  'COALESCE((SELECT p.created_at FROM chat_history p WHERE p.id = CAST(chat_history.turn_order AS INTEGER)), chat_history.created_at)';
/** Reading order: by when the row reads, then by its place (own id unless moved), then by id. */
const ORDER_ASC = 'position_at ASC, position ASC, id ASC';
const ORDER_DESC = 'position_at DESC, position DESC, id DESC';

export class ChatHistoryRepository {
  constructor(private db: Database) {}

  save(userId: number, role: 'user' | 'assistant' | 'tool', content: string, chatId?: number): number {
    const result = this.db
      .prepare('INSERT INTO chat_history (user_id, role, content, chat_id) VALUES (?, ?, ?, ?)')
      .run(userId, role, content, chatId ?? null);
    return Number(result.lastInsertRowid);
  }

  /**
   * Puts a user turn after everything saved so far, keeping its id and the time it was sent. A message that
   * waited behind an earlier run was saved before what that run wrote, so by row order it sits in the middle
   * of that run's output; the model must read «earlier request, what was done, this message». The row keeps
   * its id (the action log, the per-user map and every context built from it stay valid, and ids stay the
   * order messages arrived in) and its `created_at`; only where it reads moves, and `turn_order` records
   * that it was moved, so a reader can tell it was sent before the rows it now follows. Returns false when
   * the row is not a user turn of `userId` or nothing was saved after it.
   */
  placeUserTurnAfterLatest(rowId: number, userId: number): boolean {
    // "After" means after a bot row of the same conversation: the group's rows (whoever triggered them), or
    // the user's private rows.
    const result = this.db
      .prepare(
        `UPDATE chat_history
         SET turn_order = (SELECT MAX(id) FROM chat_history) + 0.5
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

  /** The newest `limit` rows matching `conditions`, oldest first, in reading order. */
  private newestInReadingOrder(
    conditions: readonly string[],
    args: readonly (number | string)[],
    limit: number,
  ): ChatHistoryMessage[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM (
          SELECT ${COLUMNS}, ${POSITION_AT} AS position_at, COALESCE(turn_order, id) AS position
          FROM chat_history WHERE ${conditions.join(' AND ')}
          ORDER BY ${ORDER_DESC} LIMIT ?
        ) sub ORDER BY ${ORDER_ASC}`,
      )
      .all(...args, limit) as ChatHistoryMessage[];
  }

  /** `excludeIds` rows (turns queued behind the reader) are left out BEFORE the limit, so they cost no context. */
  getRecentByChat(chatId: number, limit = 10, excludeIds: ReadonlySet<number> = new Set()): ChatHistoryMessage[] {
    const conditions = ['chat_id = ?'];
    if (excludeIds.size > 0) conditions.push(excludedRowsSql(excludeIds));
    return this.newestInReadingOrder(conditions, [chatId, ...excludeIds], limit);
  }

  searchByChat(
    chatId: number,
    params: { limit?: number; search?: string; excludeIds?: ReadonlySet<number> },
  ): ChatHistoryMessage[] {
    const { limit = 50, search, excludeIds = new Set<number>() } = params;
    const conditions: string[] = ['chat_id = ?'];
    const args: (number | string)[] = [chatId];
    if (excludeIds.size > 0) {
      conditions.push(excludedRowsSql(excludeIds));
      args.push(...excludeIds);
    }

    if (search) {
      conditions.push('content LIKE ?');
      args.push(`%${search}%`);
    }

    return this.newestInReadingOrder(conditions, args, limit);
  }

  getRecent(userId: number, limit = 10, excludeIds: ReadonlySet<number> = new Set()): ChatHistoryMessage[] {
    const conditions = ['user_id = ?', 'chat_id IS NULL'];
    if (excludeIds.size > 0) conditions.push(excludedRowsSql(excludeIds));
    return this.newestInReadingOrder(conditions, [userId, ...excludeIds], limit);
  }

  search(
    userId: number,
    params: { limit?: number; search?: string; before?: string; after?: string; excludeIds?: ReadonlySet<number> },
  ): ChatHistoryMessage[] {
    const { limit = 50, search, before, after, excludeIds = new Set<number>() } = params;
    const conditions: string[] = ['user_id = ?'];
    const args: (number | string)[] = [userId];
    if (excludeIds.size > 0) {
      conditions.push(excludedRowsSql(excludeIds));
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

    return this.newestInReadingOrder(conditions, args, limit);
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
