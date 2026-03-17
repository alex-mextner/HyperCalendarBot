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
}
