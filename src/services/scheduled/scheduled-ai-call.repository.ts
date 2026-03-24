import type { Database } from 'bun:sqlite';
import type { CreateScheduleData, ScheduledAiCall } from './types.ts';

export type { CreateScheduleData, ScheduledAiCall };

export class ScheduledAiCallRepository {
  constructor(private db: Database) {}

  create(data: CreateScheduleData): ScheduledAiCall {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO scheduled_ai_calls (id, user_id, message, label, run_at, cron, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, data.userId, data.message, data.label ?? null, data.runAt ?? null, data.cron ?? null, now);
    return this.findById(id)!;
  }

  findById(id: string): ScheduledAiCall | null {
    return this.db.prepare('SELECT * FROM scheduled_ai_calls WHERE id = ?').get(id) as ScheduledAiCall | null;
  }

  listEnabled(userId: number): ScheduledAiCall[] {
    return this.db
      .prepare('SELECT * FROM scheduled_ai_calls WHERE user_id = ? AND enabled = 1 ORDER BY created_at DESC')
      .all(userId) as ScheduledAiCall[];
  }

  countEnabled(userId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM scheduled_ai_calls WHERE user_id = ? AND enabled = 1')
      .get(userId) as { n: number };
    return row.n;
  }

  disable(id: string): void {
    this.db.prepare('UPDATE scheduled_ai_calls SET enabled = 0 WHERE id = ?').run(id);
  }

  recordRun(id: string): void {
    this.db
      .prepare('UPDATE scheduled_ai_calls SET run_count = run_count + 1, last_run_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }
}
