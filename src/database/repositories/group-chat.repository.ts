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

  getSharedEventsPaginated(chatId: number, offset = 0, limit = 10): { items: GroupSharedEvent[]; total: number } {
    const total = this.db.prepare('SELECT COUNT(*) as cnt FROM group_shared_events WHERE chat_id = ?').get(chatId) as {
      cnt: number;
    };
    const items = this.db
      .prepare(
        `SELECT gse.* FROM group_shared_events gse
         JOIN events e ON e.id = gse.event_id
         WHERE gse.chat_id = ? AND e.is_deleted = 0 AND e.is_cancelled = 0
         ORDER BY e.start_at ASC
         LIMIT ? OFFSET ?`,
      )
      .all(chatId, limit, offset) as GroupSharedEvent[];
    return { items, total: total.cnt };
  }

  unshareEvent(chatId: number, eventId: number, userId: number): boolean {
    const result = this.db
      .prepare('DELETE FROM group_shared_events WHERE chat_id = ? AND event_id = ? AND shared_by = ?')
      .run(chatId, eventId, userId);
    return result.changes > 0;
  }

  setPinHintShown(chatId: number): void {
    this.db.prepare('UPDATE group_chats SET pin_hint_shown = 1 WHERE chat_id = ?').run(chatId);
  }

  getTimezone(chatId: number): string | null {
    const row = this.db.prepare('SELECT timezone FROM group_chats WHERE chat_id = ?').get(chatId) as {
      timezone: string | null;
    } | null;
    return row?.timezone ?? null;
  }

  setTimezone(chatId: number, timezone: string): void {
    this.db.prepare('UPDATE group_chats SET timezone = ? WHERE chat_id = ?').run(timezone, chatId);
  }

  setCountry(chatId: number, country: string): void {
    this.db.prepare('UPDATE group_chats SET country = ? WHERE chat_id = ?').run(country, chatId);
  }

  setInviteLink(chatId: number, link: string): void {
    this.db.prepare('UPDATE group_chats SET invite_link = ? WHERE chat_id = ?').run(link, chatId);
  }
}
