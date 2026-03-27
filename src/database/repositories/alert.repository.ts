// src/database/repositories/alert.repository.ts
import type { Database } from 'bun:sqlite';

export interface Alert {
  id: number;
  text: string;
  source: string;
  created_at: string;
}

export class AlertRepository {
  constructor(private readonly db: Database) {}

  push(text: string, source: string): void {
    this.db.run('INSERT INTO alerts (text, source) VALUES (?, ?)', [text, source]);
  }

  /** Returns the oldest unconsumed alert and marks it consumed. Returns null if none. */
  pop(): Alert | null {
    return this.db.transaction(() => {
      const row = this.db
        .query<Alert, []>('SELECT id, text, source, created_at FROM alerts WHERE consumed = 0 ORDER BY id ASC LIMIT 1')
        .get();
      if (row) {
        this.db.run('UPDATE alerts SET consumed = 1 WHERE id = ?', [row.id]);
      }
      return row ?? null;
    })();
  }
}
