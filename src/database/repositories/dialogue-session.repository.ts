// src/database/repositories/dialogue-session.repository.ts
//
// Durable store for GH-652's workflow v3 dialogue sessions (src/services/dialogue/v3-types.ts),
// backed by the `dialogue_v3_sessions` table (migrations.ts `066_dialogue_v3_sessions`,
// `067_dialogue_v3_sessions_revision`). Same idiom as WorkflowSessionRepository
// (workflow-session.repository.ts) — TEXT-JSON payload, a zod codec, row-age TTL —
// deliberately a SEPARATE table; see that migration's comment for why reusing
// `workflow_sessions` or `gramio_scenes` was rejected.
//
// Scope key is (chat_id, user_id, topic_id) — `topic_id` is 0 when the chat has no forum
// topics, matching how callers already normalize a Telegram `message_thread_id`.
//
// Writes are compare-and-swap on `revision` (067): `set()` requires the caller's
// `expectedRevision` — `null` means "this session must not already exist", a number means "the
// stored row must currently be at exactly this revision". A mismatch returns `{ ok: false }`
// rather than silently overwriting — the caller re-reads and decides, so a late/duplicate write
// (a retried webhook, a slow AI callback) can never clobber newer state or double-execute a
// session past its one irreversible transition (see v3-types.ts's `DialogueV3Status.executing`).

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

const InviteOutcomeSchema = z.object({
  delivered: z.array(DraftPersonSchema),
  pendingManualForward: z.array(DraftPersonSchema),
  noAccount: z.array(DraftPersonSchema),
  failed: z.array(z.object({ person: DraftPersonSchema, reason: z.string() })),
});

const EffectStatusSchema = z.union([
  z.literal('pending'),
  z.literal('applied'),
  z.literal('unknown'),
  z.literal('failed'),
]);

const EffectLedgerSchema = z.object({
  invitations: EffectStatusSchema,
  postCreateHooks: EffectStatusSchema,
  receipt: EffectStatusSchema,
});

const DraftPlaceSchema = z.object({
  kind: z.union([z.literal('manual'), z.literal('native')]),
  label: z.string(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const FieldProvenanceValueSchema = z.union([
  z.literal('missing'),
  z.literal('defaulted'),
  z.literal('supplied'),
  z.literal('ambiguous'),
  z.literal('cleared'),
]);

const FieldProvenanceMapSchema = z.object({
  title: FieldProvenanceValueSchema,
  schedule: FieldProvenanceValueSchema,
  people: FieldProvenanceValueSchema,
  place: FieldProvenanceValueSchema,
  description: FieldProvenanceValueSchema,
  recurrence: FieldProvenanceValueSchema,
});

const EventCreateDraftSchema = z.object({
  title: z.string().optional(),
  schedule: ScheduleSchema.optional(),
  endAt: z.string().optional(),
  people: z.array(DraftPersonSchema),
  place: DraftPlaceSchema.optional(),
  description: z.string().optional(),
  recurrenceRule: z.string().optional(),
  scope: z.union([z.literal('personal'), z.literal('group')]),
  groupId: z.number().optional(),
  provenance: FieldProvenanceMapSchema,
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

const ExecutionReceiptSchema = z.union([
  z.object({ status: z.literal('unknown'), attemptedAtRevision: z.number() }),
  z.object({
    status: z.literal('applied'),
    eventId: z.number(),
    appliedAtRevision: z.number(),
    effects: EffectLedgerSchema,
    inviteOutcome: InviteOutcomeSchema.nullable(),
  }),
]);

const DialogueV3SessionSchema = z.object({
  version: z.literal(3),
  sessionId: z.string(),
  actorId: z.number(),
  chatId: z.number(),
  topicId: z.number(),
  operation: z.literal('event.create'),
  timezone: z.string(),
  selectedDate: z.string(),
  draft: EventCreateDraftSchema,
  pendingField: z.string().nullable(),
  pendingFuzzyPeople: z.array(PendingFuzzyPersonSchema),
  status: z.union([
    z.literal('collecting'),
    z.literal('ready'),
    z.literal('executing'),
    z.literal('executed'),
    z.literal('cancelled'),
    z.literal('handed_off'),
  ]),
  revision: z.number(),
  executionReceipt: ExecutionReceiptSchema.nullable(),
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

/**
 * `ok: true` carries the new stored revision so the caller's in-memory session object can be
 * kept in sync without a re-read. `ok: false` on `revision_mismatch` means someone else already
 * wrote a newer version of this session (or it no longer exists) — the caller MUST re-read
 * (`get()`) and decide, never retry the same write blindly. `already_exists` is the insert-only
 * (`expectedRevision: null`) case where a row is already there.
 */
export type DialogueSessionWriteResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: 'revision_mismatch' | 'already_exists' };

export class DialogueSessionRepository {
  constructor(private db: Database) {}

  /**
   * `status === 'executed'` is never expired by TTL: by construction (session-runtime.ts's
   * `executeDraft`/`resumeExecutedSession`) a row is only ever persisted at that status while
   * its durable post-create effect ledger is NOT yet fully reconciled — it is the only record
   * of what happened after the calendar event already exists, deleted explicitly once every
   * effect is `applied`, never silently timed out like an abandoned in-progress draft.
   */
  get(key: DialogueSessionKey): DialogueV3Session | null {
    const row = this.db
      .prepare('SELECT data, updated_at FROM dialogue_v3_sessions WHERE chat_id = ? AND user_id = ? AND topic_id = ?')
      .get(key.chatId, key.userId, key.topicId) as { data: string; updated_at: number } | null;
    if (!row) return null;
    const result = DialogueV3SessionCodec.safeParse(row.data);
    if (!result.success) return null;
    if (result.data.status !== 'executed' && isExpired(row.updated_at, Date.now())) {
      this.delete(key);
      return null;
    }
    return result.data;
  }

  /**
   * Compare-and-swap write. `expectedRevision: null` means "insert a brand-new session — fail
   * if one already exists for this key" (starting a fresh draft must never silently resurrect
   * or overwrite an existing one). `expectedRevision: N` means "update only if the stored row
   * is still at revision N". The written session's own `revision` field is ignored and always
   * set to the actually-persisted value (`1` for a fresh insert, `N + 1` for an update) so a
   * caller can never desync the in-band revision from the one the CAS check used.
   */
  set(
    key: DialogueSessionKey,
    session: DialogueV3Session,
    expectedRevision: number | null,
  ): DialogueSessionWriteResult {
    if (expectedRevision === null) {
      const newRevision = 1;
      const payload = JSON.stringify({ ...session, revision: newRevision });
      const result = this.db
        .prepare(
          `INSERT INTO dialogue_v3_sessions (chat_id, user_id, topic_id, data, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (chat_id, user_id, topic_id) DO NOTHING`,
        )
        .run(key.chatId, key.userId, key.topicId, payload, newRevision, session.createdAt, session.updatedAt);
      if (result.changes === 0) return { ok: false, reason: 'already_exists' };
      return { ok: true, revision: newRevision };
    }
    const newRevision = expectedRevision + 1;
    const payload = JSON.stringify({ ...session, revision: newRevision });
    const result = this.db
      .prepare(
        `UPDATE dialogue_v3_sessions SET data = ?, revision = ?, updated_at = ?
         WHERE chat_id = ? AND user_id = ? AND topic_id = ? AND revision = ?`,
      )
      .run(payload, newRevision, session.updatedAt, key.chatId, key.userId, key.topicId, expectedRevision);
    if (result.changes === 0) return { ok: false, reason: 'revision_mismatch' };
    return { ok: true, revision: newRevision };
  }

  delete(key: DialogueSessionKey): void {
    this.db
      .prepare('DELETE FROM dialogue_v3_sessions WHERE chat_id = ? AND user_id = ? AND topic_id = ?')
      .run(key.chatId, key.userId, key.topicId);
  }

  /**
   * Compare-and-swap delete — deletes only if the row is still at exactly `expectedRevision`.
   * Used to finalize a fully-reconciled `executed` session (session-runtime.ts's
   * `runDurableEffects`/`executeDraft`/`resumeExecutedSession`): a stale writer that lost a CAS
   * race earlier must never be able to delete the row a concurrent winner is still using, even
   * if the stale writer's own (never-actually-persisted) in-memory ledger looks fully applied.
   * Returns whether the delete actually happened.
   */
  deleteIfRevision(key: DialogueSessionKey, expectedRevision: number): boolean {
    const result = this.db
      .prepare('DELETE FROM dialogue_v3_sessions WHERE chat_id = ? AND user_id = ? AND topic_id = ? AND revision = ?')
      .run(key.chatId, key.userId, key.topicId, expectedRevision);
    return result.changes > 0;
  }

  /** See `get()`'s doc comment: an `executed` row with unresolved durable effects survives its normal TTL. */
  cleanup(): void {
    const cutoff = Date.now() - DIALOGUE_V3_SESSION_TTL_MS;
    const staleRows = this.db
      .prepare('SELECT chat_id, user_id, topic_id, data FROM dialogue_v3_sessions WHERE updated_at <= ?')
      .all(cutoff) as { chat_id: number; user_id: number; topic_id: number; data: string }[];
    for (const row of staleRows) {
      const parsed = DialogueV3SessionCodec.safeParse(row.data);
      if (parsed.success && parsed.data.status === 'executed') continue;
      this.db
        .prepare('DELETE FROM dialogue_v3_sessions WHERE chat_id = ? AND user_id = ? AND topic_id = ?')
        .run(row.chat_id, row.user_id, row.topic_id);
    }
  }
}
