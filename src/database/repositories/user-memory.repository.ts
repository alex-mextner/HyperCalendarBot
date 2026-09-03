import type { Database } from 'bun:sqlite';
import type { UserMemoryEntry } from '../types.ts';

export class UserMemoryRepository {
  constructor(private db: Database) {}

  private static readonly MAX_FACTS = 50;

  /**
   * The newest facts, back in the order they were learned.
   *
   * The limit has to be taken from the recent end: a user past fifty facts was
   * otherwise served the fifty oldest forever, and everything learned after
   * that never reached the prompt at all. `created_at` is stored to the second,
   * so facts saved within one second tie — the id breaks it, being the order
   * they were inserted in.
   */
  getAll(userId: number): UserMemoryEntry[] {
    const newestFirst = this.db
      .query<UserMemoryEntry, [number, number]>(
        'SELECT id, user_id, content, created_at FROM user_memory WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(userId, UserMemoryRepository.MAX_FACTS);
    return newestFirst.reverse();
  }

  append(userId: number, content: string): void {
    this.db.prepare('INSERT INTO user_memory (user_id, content) VALUES (?, ?)').run(userId, content);
  }

  rewrite(userId: number, content: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM user_memory WHERE user_id = ?').run(userId);
      this.db.prepare('INSERT INTO user_memory (user_id, content) VALUES (?, ?)').run(userId, content);
    })();
  }
}
