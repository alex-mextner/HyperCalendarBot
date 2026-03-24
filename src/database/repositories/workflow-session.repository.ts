// src/database/repositories/workflow-session.repository.ts
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { WorkflowSession, WorkflowSessionStore } from '../../bot/pipeline/types.ts';
import { WorkflowSchema } from '../../services/intent/workflow-schema.ts';

const WorkflowSessionSchema = z.object({
  intentId: z.number(),
  stepIndex: z.number(),
  stepResults: z.record(z.string(), z.unknown()),
  workflow: WorkflowSchema,
  captures: z.record(z.string(), z.string()),
  createdAt: z.number(),
});

const TTL_MS = 5 * 60 * 1000;

export class WorkflowSessionRepository implements WorkflowSessionStore {
  constructor(private db: Database) {}

  get(chatId: number, userId: number): WorkflowSession | null {
    const row = this.db
      .prepare('SELECT data, created_at FROM workflow_sessions WHERE chat_id = ? AND user_id = ?')
      .get(chatId, userId) as { data: string; created_at: number } | null;
    if (!row) return null;
    if (Date.now() - row.created_at >= TTL_MS) {
      this.delete(chatId, userId);
      return null;
    }
    try {
      return WorkflowSessionSchema.parse(JSON.parse(row.data));
    } catch {
      return null;
    }
  }

  set(chatId: number, userId: number, session: WorkflowSession): void {
    this.db
      .prepare(
        `INSERT INTO workflow_sessions (chat_id, user_id, data, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (chat_id, user_id) DO UPDATE SET
           data = excluded.data,
           created_at = excluded.created_at`,
      )
      .run(chatId, userId, JSON.stringify(session), session.createdAt);
  }

  delete(chatId: number, userId: number): void {
    this.db.prepare('DELETE FROM workflow_sessions WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
  }

  deleteByUser(userId: number): void {
    this.db.prepare('DELETE FROM workflow_sessions WHERE user_id = ?').run(userId);
  }

  cleanup(): void {
    this.db.prepare('DELETE FROM workflow_sessions WHERE created_at < ?').run(Date.now() - TTL_MS);
  }
}
