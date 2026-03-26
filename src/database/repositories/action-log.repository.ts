// src/database/repositories/action-log.repository.ts
import type { Database } from 'bun:sqlite';
import type { CreateUserActionLogData, UserActionLog } from '../types.ts';

export interface ActionLogQuery {
  user_id?: number;
  chat_id?: number;
  action_type?: string;
  action_name?: string;
  target_event_id?: number;
  target_user_id?: number;
  after?: string;
  before?: string;
  limit?: number;
}

export interface ActionLogWithHistory extends UserActionLog {
  history_content: string | null;
  history_role: string | null;
}

/**
 * Generates a Telegram deep link to a specific message.
 * Private chats (positive chat_id): no link possible.
 * Groups/supergroups (negative chat_id starting with -100): tg://privatepost link.
 */
export function telegramMessageLink(chatId: number, messageId: number): string | null {
  // Supergroups and channels have chat IDs starting with -100
  const chatIdStr = String(chatId);
  if (chatIdStr.startsWith('-100')) {
    const internalId = chatIdStr.slice(4); // remove "-100"
    return `https://t.me/c/${internalId}/${messageId}`;
  }
  // Regular groups (negative, no -100 prefix) and private chats — no stable link
  return null;
}

export class ActionLogRepository {
  constructor(private db: Database) {}

  insert(data: CreateUserActionLogData): UserActionLog {
    const result = this.db
      .prepare(
        `INSERT INTO user_action_log
          (user_id, chat_id, action_type, action_name, message_id, chat_history_id,
           input_summary, result_summary, metadata, target_event_id, target_user_id, success)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.user_id,
        data.chat_id,
        data.action_type,
        data.action_name,
        data.message_id ?? null,
        data.chat_history_id ?? null,
        data.input_summary ?? null,
        data.result_summary ?? null,
        data.metadata ?? null,
        data.target_event_id ?? null,
        data.target_user_id ?? null,
        data.success === false ? 0 : 1,
      );

    return this.db.prepare('SELECT * FROM user_action_log WHERE id = ?').get(result.lastInsertRowid) as UserActionLog;
  }

  findById(id: number): UserActionLog | null {
    return this.db.prepare('SELECT * FROM user_action_log WHERE id = ?').get(id) as UserActionLog | null;
  }

  query(params: ActionLogQuery): UserActionLog[] {
    const conditions: string[] = [];
    const args: (number | string)[] = [];

    if (params.user_id !== undefined) {
      conditions.push('user_id = ?');
      args.push(params.user_id);
    }
    if (params.chat_id !== undefined) {
      conditions.push('chat_id = ?');
      args.push(params.chat_id);
    }
    if (params.action_type) {
      conditions.push('action_type = ?');
      args.push(params.action_type);
    }
    if (params.action_name) {
      conditions.push('action_name = ?');
      args.push(params.action_name);
    }
    if (params.target_event_id !== undefined) {
      conditions.push('target_event_id = ?');
      args.push(params.target_event_id);
    }
    if (params.target_user_id !== undefined) {
      conditions.push('target_user_id = ?');
      args.push(params.target_user_id);
    }
    if (params.after) {
      conditions.push('created_at > ?');
      args.push(params.after);
    }
    if (params.before) {
      conditions.push('created_at < ?');
      args.push(params.before);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit ?? 50;

    return this.db
      .prepare(
        `SELECT * FROM user_action_log ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...args, limit) as UserActionLog[];
  }

  /**
   * Query with LEFT JOIN to chat_history for full conversation context.
   */
  queryWithHistory(params: ActionLogQuery): ActionLogWithHistory[] {
    const conditions: string[] = [];
    const args: (number | string)[] = [];

    if (params.user_id !== undefined) {
      conditions.push('a.user_id = ?');
      args.push(params.user_id);
    }
    if (params.chat_id !== undefined) {
      conditions.push('a.chat_id = ?');
      args.push(params.chat_id);
    }
    if (params.action_type) {
      conditions.push('a.action_type = ?');
      args.push(params.action_type);
    }
    if (params.action_name) {
      conditions.push('a.action_name = ?');
      args.push(params.action_name);
    }
    if (params.target_event_id !== undefined) {
      conditions.push('a.target_event_id = ?');
      args.push(params.target_event_id);
    }
    if (params.after) {
      conditions.push('a.created_at > ?');
      args.push(params.after);
    }
    if (params.before) {
      conditions.push('a.created_at < ?');
      args.push(params.before);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit ?? 50;

    return this.db
      .prepare(
        `SELECT a.*, h.content AS history_content, h.role AS history_role
         FROM user_action_log a
         LEFT JOIN chat_history h ON a.chat_history_id = h.id
         ${where}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ?`,
      )
      .all(...args, limit) as ActionLogWithHistory[];
  }

  /**
   * Get all actions that affected a specific event.
   */
  getByEvent(eventId: number, limit = 50): UserActionLog[] {
    return this.db
      .prepare(
        `SELECT * FROM user_action_log
         WHERE target_event_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(eventId, limit) as UserActionLog[];
  }

  /**
   * Get recent actions for a user.
   */
  getRecent(userId: number, limit = 20): UserActionLog[] {
    return this.db
      .prepare(
        `SELECT * FROM user_action_log
         WHERE user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(userId, limit) as UserActionLog[];
  }

  /**
   * Delete entries older than the given datetime. Returns count of deleted rows.
   */
  deleteOlderThan(before: string): number {
    const result = this.db.prepare('DELETE FROM user_action_log WHERE created_at < ?').run(before);
    return result.changes;
  }
}
