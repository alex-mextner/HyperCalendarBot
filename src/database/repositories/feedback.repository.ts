import type { Database } from 'bun:sqlite';
import type { CreateFeedbackMessageData, CreateFeedbackThreadData, FeedbackMessage, FeedbackThread } from '../types.ts';

export class FeedbackRepository {
  constructor(private db: Database) {}

  createThread(data: CreateFeedbackThreadData): number {
    const result = this.db
      .prepare(`
        INSERT INTO feedback_threads (user_id, status, type, subject, chat_id)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(data.user_id, 'open', data.type, data.subject, data.chat_id ?? null);

    return Number(result.lastInsertRowid);
  }

  getThread(id: number): FeedbackThread | null {
    return this.db.prepare('SELECT * FROM feedback_threads WHERE id = ?').get(id) as FeedbackThread | null;
  }

  getOpenThreadForUser(userId: number): FeedbackThread | null {
    return this.db
      .prepare(
        'SELECT * FROM feedback_threads WHERE user_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(userId, 'open') as FeedbackThread | null;
  }

  closeThread(id: number): void {
    this.db
      .prepare("UPDATE feedback_threads SET status = ?, closed_at = datetime('now') WHERE id = ?")
      .run('closed', id);
  }

  addMessage(data: CreateFeedbackMessageData): number {
    const result = this.db
      .prepare(`
        INSERT INTO feedback_messages (thread_id, sender, text, telegram_message_id)
        VALUES (?, ?, ?, ?)
      `)
      .run(data.thread_id, data.sender, data.text, data.telegram_message_id ?? null);

    return Number(result.lastInsertRowid);
  }

  getMessages(threadId: number): FeedbackMessage[] {
    return this.db
      .prepare('SELECT * FROM feedback_messages WHERE thread_id = ? ORDER BY created_at ASC')
      .all(threadId) as FeedbackMessage[];
  }

  countOpenThreads(userId: number): number {
    const result = this.db
      .prepare('SELECT COUNT(*) as count FROM feedback_threads WHERE user_id = ? AND status = ?')
      .get(userId, 'open') as { count: number };

    return result.count;
  }
}
