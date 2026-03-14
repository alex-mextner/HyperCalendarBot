import type { Database } from 'bun:sqlite';
import type { CreateGroupChatData, GroupChat, GroupSharedEvent } from '../types.ts';

export class GroupChatRepository {
  constructor(private db: Database) {}

  upsertGroup(data: CreateGroupChatData): void {
    this.db
      .prepare(
        `INSERT INTO group_chats (chat_id, title, added_by)
         VALUES (?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET
           title = COALESCE(excluded.title, group_chats.title),
           is_active = 1`,
      )
      .run(data.chat_id, data.title ?? null, data.added_by);
  }

  findByChatId(chatId: number): GroupChat | null {
    return (this.db.prepare('SELECT * FROM group_chats WHERE chat_id = ?').get(chatId) as GroupChat | null) ?? null;
  }

  deactivate(chatId: number): void {
    this.db.prepare('UPDATE group_chats SET is_active = 0 WHERE chat_id = ?').run(chatId);
  }

  shareEvent(chatId: number, eventId: number, sharedBy: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO group_shared_events (chat_id, event_id, shared_by)
         VALUES (?, ?, ?)`,
      )
      .run(chatId, eventId, sharedBy);
  }

  getSharedEvents(chatId: number): GroupSharedEvent[] {
    return this.db
      .prepare('SELECT * FROM group_shared_events WHERE chat_id = ? ORDER BY created_at DESC')
      .all(chatId) as GroupSharedEvent[];
  }

  unshareEvent(chatId: number, eventId: number, userId: number): boolean {
    const result = this.db
      .prepare('DELETE FROM group_shared_events WHERE chat_id = ? AND event_id = ? AND shared_by = ?')
      .run(chatId, eventId, userId);
    return result.changes > 0;
  }
}
