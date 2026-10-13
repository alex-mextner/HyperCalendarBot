import type { Database } from 'bun:sqlite';
import type { GroupMember } from '../types.ts';

export class GroupMemberRepository {
  constructor(private db: Database) {}

  upsert(chatId: number, userId: number): void {
    this.db
      .prepare(
        `INSERT INTO group_members (chat_id, user_id, last_seen_at, joined_at, left_at)
         VALUES (?, ?, datetime('now'), datetime('now'), NULL)
         ON CONFLICT (chat_id, user_id) DO UPDATE SET last_seen_at = datetime('now'), left_at = NULL`,
      )
      .run(chatId, userId);
  }

  leave(chatId: number, userId: number): void {
    this.db
      .prepare(
        `UPDATE group_members SET left_at = datetime('now')
         WHERE chat_id = ? AND user_id = ? AND left_at IS NULL`,
      )
      .run(chatId, userId);
  }

  getMembers(chatId: number): GroupMember[] {
    return this.db
      .prepare('SELECT * FROM group_members WHERE chat_id = ? ORDER BY last_seen_at DESC')
      .all(chatId) as GroupMember[];
  }

  getActiveMembers(chatId: number): GroupMember[] {
    return this.db
      .prepare('SELECT * FROM group_members WHERE chat_id = ? AND left_at IS NULL ORDER BY last_seen_at DESC')
      .all(chatId) as GroupMember[];
  }

  getGroupsForUser(userId: number): { chat_id: number; title: string | null }[] {
    return this.db
      .prepare(
        `SELECT gm.chat_id, gc.title
         FROM group_members gm
         LEFT JOIN group_chats gc ON gc.chat_id = gm.chat_id
         WHERE gm.user_id = ?
         ORDER BY gm.last_seen_at DESC`,
      )
      .all(userId) as { chat_id: number; title: string | null }[];
  }

  getActiveGroupsForUser(userId: number): { chat_id: number; title: string | null }[] {
    return this.db
      .prepare(
        `SELECT gm.chat_id, gc.title
         FROM group_members gm
         LEFT JOIN group_chats gc ON gc.chat_id = gm.chat_id
         WHERE gm.user_id = ? AND gm.left_at IS NULL
         ORDER BY gm.last_seen_at DESC`,
      )
      .all(userId) as { chat_id: number; title: string | null }[];
  }

  getMembership(chatId: number, userId: number): GroupMember | null {
    return this.db
      .prepare('SELECT * FROM group_members WHERE chat_id = ? AND user_id = ?')
      .get(chatId, userId) as GroupMember | null;
  }

  isActiveMember(chatId: number, userId: number): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM group_members WHERE chat_id = ? AND user_id = ? AND left_at IS NULL')
        .get(chatId, userId) != null
    );
  }
}
