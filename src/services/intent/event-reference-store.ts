// src/services/intent/event-reference-store.ts
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import type { AgentContext, ToolResult } from '../ai/types.ts';
import type { EventSummary } from './variable-resolver.ts';

/**
 * Conversational event references ("delete it", "the second one", "the one I just created")
 * kept per actor, chat and forum topic. A reference only nominates a candidate: every
 * consumer re-reads the event through an access-checked lookup before showing, confirming
 * or writing anything. Evidence comes solely from successful tool results' structured data,
 * never from tool input, so an ID a model invented cannot become a reference.
 */

export interface ReferenceScope {
  actorId: number;
  chatId: number;
  threadId?: number;
}

type ReferenceKind = 'created' | 'mentioned' | 'list';
type ReferenceSource = 'ai_tool' | 'intent';

export type EventReferenceEvidence =
  | { kind: ReferenceKind; tool: string; eventIds: number[] }
  | { kind: 'deleted'; tool: string; eventIds: number[] };

export type ResolvedReference =
  | { status: 'one'; event: EventSummary }
  | { status: 'choices'; events: EventSummary[] }
  | { status: 'gone' };

/** What a workflow may select from; every event here was re-read through `verify`. */
export interface ReferenceContext {
  /** "it" / "this": the reply target when the user replied to a mapped bot message, else the latest evidence. */
  it?: ResolvedReference;
  /** The latest event this actor created in this chat. */
  created?: ResolvedReference;
  /** The latest presented list, by position; null where the event is gone or no longer visible. */
  list?: (EventSummary | null)[];
  /** The user replied to a bot message this store knows nothing about; "it" is then unknown, never guessed. */
  replyUnmapped?: boolean;
}

export const REFERENCE_LIMITS = {
  singularTtlMs: 24 * 60 * 60 * 1000,
  listTtlMs: 2 * 60 * 60 * 1000,
  replyTtlMs: 7 * 24 * 60 * 60 * 1000,
  rowsPerScope: 50,
  idsPerRow: 20,
  choices: 10,
} as const;

const SummaryShape = z.object({ id: z.number().int().positive(), date: z.string(), all_day: z.boolean() });
const EventIdsCodec = jsonCodec(z.array(z.number().int().positive()).max(REFERENCE_LIMITS.idsPerRow));

/** Classify one tool result; null when it carries no structured event evidence. */
export function referenceEvidenceFrom(tool: string, result: ToolResult): EventReferenceEvidence | null {
  if (!result.success || result.data === undefined) return null;
  const data: unknown = result.data;
  if (Array.isArray(data)) {
    if (data.length === 0 || result.effect?.kind === 'event_deleted') return null;
    const ids: number[] = [];
    for (const item of data) {
      const parsed = SummaryShape.safeParse(item);
      if (!parsed.success) return null;
      ids.push(parsed.data.id);
    }
    return { kind: 'list', tool, eventIds: ids.slice(0, REFERENCE_LIMITS.idsPerRow) };
  }
  const single = SummaryShape.safeParse(data);
  if (!single.success) return null;
  if (result.effect?.kind === 'event_deleted') return { kind: 'deleted', tool, eventIds: [single.data.id] };
  return { kind: tool === 'create_event' ? 'created' : 'mentioned', tool, eventIds: [single.data.id] };
}

interface ReferenceRow {
  id: number;
  kind: ReferenceKind;
  event_ids: string;
  recorded_at: number;
}

export class EventReferenceStore {
  constructor(private readonly db: Database) {
    EventReferenceStore.ensureTable(db);
  }

  /** Auxiliary table outside the migration list; creating it is idempotent. */
  static ensureTable(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS event_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL CHECK (kind IN ('created', 'mentioned', 'list')),
      event_ids TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('ai_tool', 'intent')),
      tool TEXT NOT NULL,
      source_message_id INTEGER,
      bot_message_id INTEGER,
      recorded_at INTEGER NOT NULL
    )`);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_event_references_scope ON event_references (actor_id, chat_id, thread_id, id)',
    );
  }

  record(
    scope: ReferenceScope,
    evidence: EventReferenceEvidence,
    provenance: { source: ReferenceSource; sourceMessageId?: number },
    now = Date.now(),
  ): void {
    if (evidence.kind === 'deleted') {
      this.forget(scope, evidence.eventIds);
      return;
    }
    const key = [scope.actorId, scope.chatId, scope.threadId ?? 0] as const;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO event_references
             (actor_id, chat_id, thread_id, kind, event_ids, source, tool, source_message_id, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ...key,
          evidence.kind,
          EventIdsCodec.encode(evidence.eventIds.slice(0, REFERENCE_LIMITS.idsPerRow)),
          provenance.source,
          evidence.tool.slice(0, 64),
          provenance.sourceMessageId ?? null,
          now,
        );
      this.db
        .prepare(
          `DELETE FROM event_references WHERE actor_id = ? AND chat_id = ? AND thread_id = ?
             AND (recorded_at < ? OR id NOT IN (
               SELECT id FROM event_references WHERE actor_id = ? AND chat_id = ? AND thread_id = ?
               ORDER BY id DESC LIMIT ?))`,
        )
        .run(...key, now - REFERENCE_LIMITS.replyTtlMs, ...key, REFERENCE_LIMITS.rowsPerScope);
    })();
  }

  /** Map a bot message to the evidence recorded since `since`, so a reply to it names those events. */
  tagBotMessage(scope: ReferenceScope, botMessageId: number, since: number): void {
    this.db
      .prepare(
        `UPDATE event_references SET bot_message_id = ?
         WHERE actor_id = ? AND chat_id = ? AND thread_id = ? AND recorded_at >= ? AND bot_message_id IS NULL`,
      )
      .run(botMessageId, scope.actorId, scope.chatId, scope.threadId ?? 0, since);
  }

  /** Resolve every reference kind, re-reading each candidate through the caller's access check. */
  resolve(
    scope: ReferenceScope,
    verify: (eventId: number) => EventSummary | null,
    options: { replyToMessageId?: number; now?: number } = {},
  ): ReferenceContext {
    const now = options.now ?? Date.now();
    const rows = this.rows(scope, now - REFERENCE_LIMITS.replyTtlMs);
    const fresh = rows.filter((row) => now - row.recorded_at < ttlOf(row.kind));
    const context: ReferenceContext = {};
    const itRow = this.itRow(scope, rows, fresh, options.replyToMessageId);
    if (itRow === 'unmapped') context.replyUnmapped = true;
    else if (itRow) context.it = verifyRow(itRow, verify);
    const created = fresh.find((row) => row.kind === 'created');
    if (created) context.created = verifyRow(created, verify);
    const list = fresh.find((row) => row.kind === 'list');
    if (list) context.list = idsOf(list).map((id) => verify(id));
    return context;
  }

  private itRow(
    scope: ReferenceScope,
    rows: ReferenceRow[],
    fresh: ReferenceRow[],
    replyTo: number | undefined,
  ): ReferenceRow | 'unmapped' | undefined {
    if (replyTo === undefined) return fresh[0];
    const tagged = this.db
      .prepare(
        `SELECT id FROM event_references WHERE actor_id = ? AND chat_id = ? AND thread_id = ? AND bot_message_id = ?
         ORDER BY id DESC`,
      )
      .all(scope.actorId, scope.chatId, scope.threadId ?? 0, replyTo)
      .map((row) => z.object({ id: z.number() }).parse(row).id);
    if (tagged.length === 0) return 'unmapped';
    // A reply that names several rows (e.g. a search, then the chosen event) means the last one shown.
    return rows.find((row) => row.id === tagged[0]);
  }

  private rows(scope: ReferenceScope, cutoff: number): ReferenceRow[] {
    return this.db
      .prepare(
        `SELECT id, kind, event_ids, recorded_at FROM event_references
         WHERE actor_id = ? AND chat_id = ? AND thread_id = ? AND recorded_at >= ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(scope.actorId, scope.chatId, scope.threadId ?? 0, cutoff, REFERENCE_LIMITS.rowsPerScope)
      .flatMap((row) => {
        const parsed = RowSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
  }

  /** Singular references to a deleted event disappear; list positions stay and re-verify as gone. */
  private forget(scope: ReferenceScope, eventIds: number[]): void {
    const doomed = new Set(eventIds);
    for (const row of this.rows(scope, 0)) {
      if (row.kind !== 'list' && idsOf(row).some((id) => doomed.has(id)))
        this.db.prepare('DELETE FROM event_references WHERE id = ?').run(row.id);
    }
  }
}

const RowSchema = z.object({
  id: z.number(),
  kind: z.enum(['created', 'mentioned', 'list']),
  event_ids: z.string(),
  recorded_at: z.number(),
});

function ttlOf(kind: ReferenceKind): number {
  return kind === 'list' ? REFERENCE_LIMITS.listTtlMs : REFERENCE_LIMITS.singularTtlMs;
}

function idsOf(row: ReferenceRow): number[] {
  const parsed = EventIdsCodec.safeParse(row.event_ids);
  return parsed.success ? parsed.data : [];
}

function verifyRow(row: ReferenceRow, verify: (eventId: number) => EventSummary | null): ResolvedReference {
  const live = idsOf(row).flatMap((id) => {
    const event = verify(id);
    return event ? [event] : [];
  });
  if (live.length === 0) return { status: 'gone' };
  if (live.length === 1) return { status: 'one', event: live[0]! };
  return { status: 'choices', events: live.slice(0, REFERENCE_LIMITS.choices) };
}

/**
 * Route one run's successful tool results into the store. Recording failures are logged by
 * the caller-supplied `onError` and never fail the tool call that produced the evidence.
 */
export function captureReferences(
  ctx: Pick<AgentContext, 'onEventReference'>,
  store: EventReferenceStore,
  scope: ReferenceScope,
  provenance: { source: ReferenceSource; sourceMessageId?: number },
  onError: (err: unknown) => void,
): void {
  ctx.onEventReference = (evidence) => {
    try {
      store.record(scope, evidence, provenance);
    } catch (err) {
      onError(err);
    }
  };
}
