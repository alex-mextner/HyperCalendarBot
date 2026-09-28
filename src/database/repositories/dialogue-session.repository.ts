// src/database/repositories/dialogue-session.repository.ts
//
// Durable store for GH-652's workflow v3 dialogue sessions (src/services/dialogue/v3-types.ts),
// backed by the `dialogue_v3_sessions` table (migrations.ts `066_dialogue_v3_sessions`). Same
// idiom as WorkflowSessionRepository (workflow-session.repository.ts) — TEXT-JSON payload, a
// zod codec, row-age TTL — deliberately a SEPARATE table; see that migration's comment for why
// reusing `workflow_sessions` or `gramio_scenes` was rejected.
//
// Scope key is (chat_id, user_id, topic_id) — `topic_id` is 0 when the chat has no forum
// topics, matching how callers already normalize a Telegram `message_thread_id`.

import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { DialogueV3Session } from '../../services/dialogue/v3-types.ts';
import { jsonCodec } from '../../utils/json-codec.ts';

const ScheduleSchema = z.union([
  z.object({ kind: z.literal('timed'), startAt: z.string() }),
  z.object({ kind: z.literal('all_day'), startDate: z.string(), endDateExclusive: z.string() }),
]);

const DraftPersonSchema = z.object({
  contactId: z.number().nullable(),
  telegramId: z.number().nullable(),
  displayName: z.string(),
  confirmed: z.boolean(),
});

const DraftPlaceSchema = z.object({
  kind: z.union([z.literal('manual'), z.literal('native')]),
  label: z.string(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const EventCreateDraftSchema = z.object({
  title: z.string().optional(),
  schedule: ScheduleSchema.optional(),
  people: z.array(DraftPersonSchema),
  place: DraftPlaceSchema.optional(),
  description: z.string().optional(),
  recurrenceRule: z.string().optional(),
  scope: z.union([z.literal('personal'), z.literal('group')]),
  groupId: z.number().optional(),
});

const PendingPersonCandidateSchema = z.object({
  contactId: z.number(),
  telegramId: z.number().nullable(),
  displayName: z.string(),
  confidence: z.number(),
});

const PendingFuzzyPersonSchema = z.object({
  rawName: z.string(),
  candidates: z.array(PendingPersonCandidateSchema),
});

const DialogueV3SessionSchema = z.object({
  version: z.literal(3),
  sessionId: z.string(),
  actorId: z.number(),
  chatId: z.number(),
  topicId: z.number(),
  operation: z.literal('event.create'),
  draft: EventCreateDraftSchema,
  pendingField: z.string().nullable(),
  pendingFuzzyPeople: z.array(PendingFuzzyPersonSchema),
  status: z.union([
    z.literal('collecting'),
    z.literal('ready'),
    z.literal('executed'),
    z.literal('cancelled'),
    z.literal('handed_off'),
  ]),
  createdAt: z.number(),
  updatedAt: z.number(),
  sourceText: z.string(),
});

const DialogueV3SessionCodec = jsonCodec(DialogueV3SessionSchema);

/**
 * A guided multi-field draft needs more headroom than the regex-intent engine's single
 * suspended ask_user turn (workflow_sessions: 5 min) — 30 minutes matches the GramIO scene
 * wizard's own storage TTL (scenes/storage.ts's `$ttl: 30*60`), the closest existing analog
 * for "a human is filling out a form", not an arbitrary new number.
 */
export const DIALOGUE_V3_SESSION_TTL_MS = 30 * 60 * 1000;

const isExpired = (updatedAt: number, now: number) => now - updatedAt >= DIALOGUE_V3_SESSION_TTL_MS;

export interface DialogueSessionKey {
  readonly chatId: number;
  readonly userId: number;
  readonly topicId: number;
}

export class DialogueSessionRepository {
  constructor(private db: Database) {}

  get(key: DialogueSessionKey): DialogueV3Session | null {
    const row = this.db
      .prepare('SELECT data, updated_at FROM dialogue_v3_sessions WHERE chat_id = ? AND user_id = ? AND topic_id = ?')
      .get(key.chatId, key.userId, key.topicId) as { data: string; updated_at: number } | null;
    if (!row) return null;
    if (isExpired(row.updated_at, Date.now())) {
      this.delete(key);
      return null;
    }
    const result = DialogueV3SessionCodec.safeParse(row.data);
    return result.success ? result.data : null;
  }

  set(key: DialogueSessionKey, session: DialogueV3Session): void {
    this.db
      .prepare(
        `INSERT INTO dialogue_v3_sessions (chat_id, user_id, topic_id, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (chat_id, user_id, topic_id) DO UPDATE SET
           data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .run(key.chatId, key.userId, key.topicId, JSON.stringify(session), session.createdAt, session.updatedAt);
  }

  delete(key: DialogueSessionKey): void {
    this.db
      .prepare('DELETE FROM dialogue_v3_sessions WHERE chat_id = ? AND user_id = ? AND topic_id = ?')
      .run(key.chatId, key.userId, key.topicId);
  }

  cleanup(): void {
    this.db
      .prepare('DELETE FROM dialogue_v3_sessions WHERE updated_at <= ?')
      .run(Date.now() - DIALOGUE_V3_SESSION_TTL_MS);
  }
}
