// src/database/repositories/workflow-session.repository.ts
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { WorkflowSession, WorkflowSessionStore } from '../../bot/pipeline/types.ts';
import type { EventSummary } from '../../services/intent/variable-resolver.ts';
import { WorkflowSchema } from '../../services/intent/workflow-schema.ts';
import { jsonCodec } from '../../utils/json-codec.ts';

/** Recursive JSON-safe type for tool output values (objects, arrays, primitives). */
type ToolOutputValue = string | number | boolean | null | ToolOutputValue[] | { [k: string]: ToolOutputValue };
const ToolOutputValueSchema: z.ZodType<ToolOutputValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(ToolOutputValueSchema),
    z.record(z.string(), ToolOutputValueSchema),
  ]),
);

const EventSummarySchema = z.object({
  id: z.number(),
  title: z.string(),
  date: z.string(),
  time: z.string().optional(),
  all_day: z.boolean(),
  end_at: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  recurrence_rule: z.string().optional(),
});

/**
 * Schema for serialized step results stored in the DB.
 * Runtime-only fields (isPastHour, isPastDay, etc.) are NOT serialized — they are
 * re-added by buildEventStepResults() on resume.
 *
 * Known keys: last_added_event, last_mentioned_event (EventSummary), group, user,
 * tool_outputs, choices, ask, and $1/$2/... regex captures.
 */
const StepResultsSchema = z
  .object({
    last_added_event: EventSummarySchema.optional(),
    last_mentioned_event: EventSummarySchema.optional(),
    group: z.object({ is_group: z.boolean(), chat_id: z.number().nullable() }).optional(),
    user: z
      .object({
        id: z.number().optional(),
        language: z.string(),
        timezone: z.string(),
        username: z.string().optional(),
        first_name: z.string().optional(),
      })
      .optional(),
    tool_outputs: z.record(z.string(), ToolOutputValueSchema).optional(),
    choices: z.array(z.union([z.string(), z.number()])).optional(),
    ask: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  })
  .catchall(ToolOutputValueSchema);

/**
 * TypeScript type for step results.
 *
 * Defined manually rather than via z.infer because Zod v4's catchall with
 * z.union([z.string(), z.number()]) produces a broken intersection where
 * object-typed explicit fields (tool_outputs, group, etc.) collide with the
 * string|number index signature, making them `never`.
 *
 * The Zod schema (StepResultsSchema) is still used for runtime validation.
 */
export interface StepResults {
  last_added_event?: EventSummary;
  last_mentioned_event?: EventSummary;
  group?: { is_group: boolean; chat_id: number | null };
  user?: {
    id?: number;
    language: string;
    timezone: string;
    username?: string;
    first_name?: string;
  };
  tool_outputs?: { [k: string]: ToolOutputValue };
  choices?: (string | number)[];
  ask?: { [k: string]: string | number };
  /** Dynamic keys: regex captures ($1, $2, ...) and other runtime values. */
  [key: string]: unknown;
}

const WorkflowSessionSchema = z.object({
  intentId: z.number(),
  stepIndex: z.number(),
  stepResults: StepResultsSchema,
  workflow: WorkflowSchema,
  captures: z.record(z.string(), z.string()),
  createdAt: z.number(),
  pendingPrompt: z
    .object({ text: z.string(), options: z.array(z.string()).optional(), delivered: z.boolean() })
    .optional(),
});

const WorkflowSessionCodec = jsonCodec(WorkflowSessionSchema);

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
    const result = WorkflowSessionCodec.safeParse(row.data);
    return result.success ? result.data : null;
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
