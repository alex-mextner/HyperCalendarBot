import type { Database } from 'bun:sqlite';

export interface UserMemoryEntry {
  id: number;
  user_id: number;
  content: string;
  created_at: string;
}

export class UserMemoryRepository {
  constructor(private db: Database) {}

  private static readonly MAX_FACTS = 50;

  getAll(userId: number): UserMemoryEntry[] {
    return this.db
      .prepare('SELECT * FROM user_memory WHERE user_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(userId, UserMemoryRepository.MAX_FACTS) as UserMemoryEntry[];
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
