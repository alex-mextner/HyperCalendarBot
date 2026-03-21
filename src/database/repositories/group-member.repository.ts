import type { Database } from 'bun:sqlite';

export interface GroupMember {
  chat_id: number;
  user_id: number;
  last_seen_at: string;
}

export class GroupMemberRepository {
  constructor(private db: Database) {}

  upsert(chatId: number, userId: number): void {
    this.db
      .prepare(
        `INSERT INTO group_members (chat_id, user_id, last_seen_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT (chat_id, user_id) DO UPDATE SET last_seen_at = datetime('now')`,
      )
      .run(chatId, userId);
  }

  getMembers(chatId: number): GroupMember[] {
    return this.db
      .prepare('SELECT * FROM group_members WHERE chat_id = ? ORDER BY last_seen_at DESC')
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
}
