import type { Database } from 'bun:sqlite';
import type { CreateTriggerData, Trigger } from './types.ts';

export class TriggerRepository {
  constructor(private db: Database) {}

  create(data: CreateTriggerData): string {
    const id = crypto.randomUUID();
    this.db
      .prepare(`
        INSERT INTO ai_triggers (id, user_id, topic, condition, action, label, once, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        data.userId,
        data.topic,
        data.condition ?? null,
        data.action,
        data.label ?? null,
        data.once ? 1 : 0,
        new Date().toISOString(),
      );
    return id;
  }

  findEnabled(userId: number, topic: string): Trigger[] {
    return this.db
      .prepare('SELECT * FROM ai_triggers WHERE user_id = ? AND topic = ? AND enabled = 1')
      .all(userId, topic) as Trigger[];
  }

  listByUser(userId: number): Trigger[] {
    return this.db
      .prepare('SELECT * FROM ai_triggers WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as Trigger[];
  }

  countEnabled(userId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM ai_triggers WHERE user_id = ? AND enabled = 1')
      .get(userId) as { n: number };
    return row.n;
  }

  disable(id: string): void {
    this.db.prepare('UPDATE ai_triggers SET enabled = 0 WHERE id = ?').run(id);
  }

  recordFire(id: string, disableAfter: boolean): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE ai_triggers SET fire_count = fire_count + 1, last_fired_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id);
      if (disableAfter) {
        this.db.prepare('UPDATE ai_triggers SET enabled = 0 WHERE id = ?').run(id);
      }
    })();
  }

  remove(id: string, userId: number): void {
    this.db.prepare('DELETE FROM ai_triggers WHERE id = ? AND user_id = ?').run(id, userId);
  }
}
