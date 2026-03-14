import type { Database } from 'bun:sqlite';
import type { CreateDeepLinkData, DeepLink } from '../types.ts';

export class DeepLinkRepository {
  constructor(private db: Database) {}

  create(data: CreateDeepLinkData): DeepLink {
    this.db
      .prepare(
        `INSERT INTO deep_links (code, type, payload, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(data.code, data.type, data.payload, data.created_by, data.expires_at ?? null);
    return this.findByCode(data.code)!;
  }

  findByCode(code: string): DeepLink | null {
    return (
      (this.db.prepare('SELECT * FROM deep_links WHERE code = ?').get(code) as DeepLink | null) ??
      null
    );
  }

  incrementUsedCount(code: string): void {
    this.db.prepare('UPDATE deep_links SET used_count = used_count + 1 WHERE code = ?').run(code);
  }

  deleteExpired(): number {
    const result = this.db
      .prepare("DELETE FROM deep_links WHERE expires_at IS NOT NULL AND expires_at < datetime('now')")
      .run();
    return result.changes;
  }
}
