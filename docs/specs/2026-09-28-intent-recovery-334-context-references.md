# GH-334 Scope 1: contextual event references, revalidation and confirm-before-write

Status: draft for review (2026-09-28). Task: GH-334. Implemented by PR-5 (store, migration,
primitives; no wiring) and PR-6 (contextual seeds and wiring). Related: `docs/intents/engine.md`
sections on explicit confirmation, one object, write evidence; GH-509 (AI-path delete confirmation,
other owner); `docs/specs/2026-09-28-intent-recovery-334-revisions.md` (activation of new seeds); #554 (shared
calendar dialogue specification, separate owner) reuses this contextual-reference design and must not
redefine it.

## Problem

Users say "delete it", "move the second one to Friday", "the one I just created". On main the intent
path cannot resolve these: `seed-lineage.ts` retired every last-mentioned rule, and the only memory is
`event-mention-store.ts`, which has three backends (in-memory, Redis key per user with a 7-day TTL in
production, and `SqliteEventMentionStore` over the table of migration `035_event_mention_store`, used
in tests), all holding one event id per user with no chat scope, provenance, lists or staleness check. Such requests fall through to the AI agent, where the target choice is
not code-checked.

## Goals

- A reference nominates a candidate; it never authorizes a write.
- References are scoped by actor, chat and forum topic, persisted with provenance, and bounded.
- Every consumer re-reads the event through the actor's access-checked lookup and compares it with
  the snapshot taken when the reference was recorded.
- Writes show the exact target (title, number, local date/time) and require an explicit yes. The
  target is read again right before the write; any difference aborts.
- Ambiguous, stale, gone or changed targets produce a clarification, never a different event.
- A confirmed mutation that completed, or whose outcome is unknown, is never executed again.

## Decisions

- **Storage: main database, migration `066_event_references`** (next free number after PR-1's 065 at
  merge time; never renumber a merged migration). The 2026-09-19 code created the table with
  `CREATE TABLE IF NOT EXISTS` in a constructor, outside the migration list; that is not ported.
  Main-DB storage is chosen because references point at `events` rows, must survive restarts and
  are covered by the daily backup. Required doc: `docs/reference/migrations/066_event_references.md`.
- **Evidence only from structured tool results** (`ToolResult.data` shapes with `id`, `date`,
  `all_day`), never from tool input or model text, so an invented id cannot become a reference.
  Tool results carry display-shaped `EventSummary` data without timestamps or version, so the store
  builds each `EventSnapshot` itself: at record time it re-reads the event row for every structured id
  through the actor's access-checked repository lookup and snapshots `start_at`, `end_at`, `all_day`,
  `title` and `updated_at`/`sync_version`. Ids the actor cannot read are not recorded. No tool handler
  changes are needed.
- **Timezone primitives stay inside `src/services/intent/`** (`event-time.ts`, `wall-clock.ts`).
  `src/utils/date.ts` is being edited by PR #523 (#495) and is not touched.
- **`event-mention-store.ts` (all three backends and the migration 035 table) is not deleted.** PR-6
  moves the intent consumer to the new store; if no consumer remains, a tracking issue is filed for the
  dead-code investigation covering the three classes and the 035 table.

## Schema (migration 066_event_references)

```sql
CREATE TABLE event_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('created','mentioned','list')),
  event_ids TEXT NOT NULL,          -- JSON int array, 1..20 ids, list order preserved
  snapshots TEXT NOT NULL,          -- JSON array aligned with event_ids: {id, title, start_at, end_at, all_day, version}
  source TEXT NOT NULL CHECK (source IN ('ai_tool','intent')),
  tool TEXT NOT NULL,               -- producing tool name, <= 64 chars
  source_message_id INTEGER,        -- user message that produced it
  bot_message_id INTEGER,           -- bot message that presented it (reply mapping)
  recorded_at INTEGER NOT NULL
);
CREATE INDEX idx_event_references_scope ON event_references(actor_id, chat_id, thread_id, id);
CREATE INDEX idx_event_references_reply ON event_references(actor_id, chat_id, thread_id, bot_message_id);
```

`version` is the event's `updated_at` (and `sync_version` when present). No user text other than
the event title is stored. Retention: rows older than 7 days are deleted on write; at most 50 rows per
scope. TTLs: singular 24 h, list 2 h, reply mapping 7 days (from the 2026-09-19 design).

## Store API (`src/services/intent/event-reference-store.ts`)

`EventSummary` is the existing display-shaped type in `src/services/intent/variable-resolver.ts`
(reused, not redefined); `EventSnapshot` is the stored comparison shape and adds `version` for change
detection. `changedSinceReference` compares a fresh `EventSnapshot` built from the re-read event
row, never an `EventSummary`.

```ts
export interface ReferenceScope { actorId: number; chatId: number; threadId?: number }
export interface EventSnapshot { id: number; title: string; start_at: string; end_at: string | null; all_day: boolean; version: string }
export type EventReferenceEvidence =
  | { kind: 'created' | 'mentioned'; tool: string; eventId: number }   // exactly one id
  | { kind: 'list'; tool: string; eventIds: number[] };                  // 1..20 ids, order kept
export type ToolReferenceEffect =
  | { type: 'record'; evidence: EventReferenceEvidence }
  | { type: 'forget'; eventIds: number[] };                              // from a successful delete
/** Access-checked read used at record and resolve time; null when missing or not visible to the actor. */
export type ReadEvent = (eventId: number) => { summary: EventSummary; snapshot: EventSnapshot } | null;
export type ResolvedTarget =
  | { status: 'one'; event: EventSummary; changedSinceReference: boolean }
  | { status: 'choices'; events: EventSummary[] }       // more than one live candidate: ask
  | { status: 'gone' }                                  // deleted or no longer visible to the actor
  | { status: 'stale' }                                 // older than TTL
  | { status: 'none' };                                 // nothing recorded in this scope
export interface ReferenceContext { it: ResolvedTarget; created: ResolvedTarget; list: (ResolvedTarget & { position: number })[]; replyUnmapped: boolean }

export function referenceEffectFrom(tool: string, result: ToolResult): ToolReferenceEffect | null;
export class EventReferenceStore {
  constructor(db: Database);
  /** Inserts one row; returns its id, or null when no id was readable by the actor. */
  record(scope: ReferenceScope, evidence: EventReferenceEvidence, read: ReadEvent, options: { source: 'ai_tool' | 'intent'; sourceMessageId?: number; now?: number }): number | null;
  /** Deletes singular rows naming these ids; list rows stay and resolve the position as gone. */
  forgetEvents(scope: ReferenceScope, eventIds: number[]): void;
  /** Tags exactly the rows this turn recorded (ids returned by record), never rows by time. */
  tagBotMessage(scope: ReferenceScope, botMessageId: number, referenceIds: number[]): void;
  resolve(scope: ReferenceScope, read: ReadEvent, options?: { replyToMessageId?: number; now?: number }): ReferenceContext;
}
```

Resolution rules:
- `it`: when the user replied to a bot message, the rows tagged with that message; a reply to an
  unmapped bot message sets `replyUnmapped` and `it = none` (never falls back to "latest"). Without a
  reply, the latest fresh row of any kind in the scope.
- Ordinals index the latest fresh `list` row by position (1-based). Out of range -> `none`.
- A successful delete produces a `forget` effect handled by `forgetEvents`, never by `record`: singular
  rows naming that id are deleted and list rows stay; the list position then resolves `gone` because
  `read` returns `null`. Singular kinds (`created`, `mentioned`) always store exactly one id; only `list`
  stores up to 20.
- `changedSinceReference` is true when the snapshot returned by `read` differs from the stored
  snapshot in title, start, end, all-day flag or version. The confirmation prompt then says the event changed and shows its current
  state; it is still a confirmation, not a silent choice.

## Primitives

- `event-time.ts`: shift an event by a relative duration in the event's local wall clock
  ("one hour later" across a DST change keeps the local clock arithmetic defined in tests for
  2026-10-25 and 2027-03-28 in Europe/Belgrade); move to a named weekday or date keeping local time
  and duration. Pure functions over ISO strings and IANA zones via `@date-fns/tz`, which the repo uses.
- `wall-clock.ts`: "now" in a zone, local day boundaries; used by the two above.
- Bounded title lookup: `EventRepository.findByTitleFolded(userId, needle, { limit })` scans the actor's
  events with a cursor (`WHERE user_id = ? AND id > ? ORDER BY id LIMIT 500`, columns `id, title`
  only) and folds case in JavaScript (SQLite `LOWER` does not fold Cyrillic). It stops fetching
  further batches once `limit + 1` matches are found; rows read are bounded by the batch size times the
  number of batches fetched before that early stop. This replaces the 2026-09-19 version that loaded all user events at once.

## Confirmation and no-replay (PR-6)

Contextual seeds (`seed-contextual.ts`, ported) follow this workflow for every write
(delete, move, rename, reschedule):
1. Resolve the target through `ReferenceContext`; any status other than `one` answers with a
   clarification (`choices` lists up to 10 with numbers) and performs no tool call.
2. `get_event` by id through the actor's access check; show title, number, local date and time,
   and the change; ask yes/cancel.
3. On yes: the workflow session's confirmation record is marked `consumed` in the same SQLite
   transaction that reads it, before any tool runs. `workflow_sessions` is keyed by `(chat_id,
   user_id)` only, so PR-6 adds an optional `threadId` field to the session `data` schema
   (`WorkflowSessionRepository`, no migration) and the matcher layer refuses to resume a contextual
   confirmation from a different forum topic (it answers that the question is open in another topic and
   runs no tool). A newer question in another topic replaces the older session, so the older topic's
   yes can never execute it. A second yes, a button re-tap or a restart
   replay finds `consumed` and answers "already handled" without a tool call.
4. `get_event` again; `same(target, current) == false` aborts with "changed, nothing done".
5. Execute the write. Executor write outcome `applied` or `unknown` is terminal: no retry, no
   hand-off to the AI agent with the original request (this is the existing `engine.md` rule, now also
   enforced for resumed contextual workflows).

Interaction with GH-509: if #509's gate intercepts `delete_event` at the tool-executor level, the
intent-path confirmation must satisfy it through #509's public API, not bypass it. PR-6 is sequenced
after #509 and adapts to its merged interface.

## Wiring (PR-6)

- `tool-executor.ts`: after a successful tool result, call `ctx.onEventReference?.(evidence)`;
  a recording failure is logged (`{ err }`) and never fails the tool call.
- `message.handler.ts` / `ai-agent-layer.ts`: both the AI path and the intent path record evidence with
  the correct scope; the bot message id that presented results is tagged.
- `intent-matcher-layer.ts` / `intent-executor.ts`: expose `ReferenceContext` to typed `eventref`
  bindings (`context` option in `workflow-bindings.ts`), and `presentedEventIds` so a listed result
  becomes a list reference.
- `seed-lineage.ts`: the retirement of last-mentioned rules is reversed with a recorded reason.
- Activation: the seed change goes through the PR-1 source-baseline draft and an explicit
  administrator approval.

## Acceptance

PR-5 (store and primitives), real SQLite with `runMigrations`:
1. Scope isolation: a reference recorded for actor A in chat 1 resolves `none` for actor B in chat 1,
   for actor A in chat 2 and for actor A in topic 7 of chat 1.
2. Provenance: an evidence built from tool input without a structured result is not recorded.
3. `changedSinceReference` is true after the event's start time is updated.
4. A deleted event resolves `gone` at its list position and is removed from singular rows.
5. Reply to an unmapped bot message yields `replyUnmapped = true` and `it = none` even when a fresh row
   exists.
5a. Interleaved turns: turn A records event A, turn B records event B, then A's reply is tagged with
   A's reference ids; replying to A's message resolves `one` = event A.
6. TTL: a list row older than 2 h resolves `stale`.
7. Access: `read` returning `null` (event of another user) yields `gone`, never the event; recording
   an id the actor cannot read stores nothing.
8. DST: "one hour later" for a 01:30 event on 2026-10-25 in Europe/Belgrade yields the
   tested local result; moving to next Friday keeps local time and duration.
9. Title lookup returns at most `limit + 1` matches, selects only `id` and `title`, and fetches no
   further batch after `limit + 1` matches: with 1200 events and matches in the first batch it runs one
   batch query; with no match it runs three (counted through an injected batch-size and a query counter
   in the repository test).
10. Migration 066 test: table and indexes exist; migration doc present (deploy gate).
11. Handler-to-store integration: a real `get_event` result is recorded, the event is updated through
   the real repository, and `resolve` reports `changedSinceReference = true`.

PR-6 (seeds and wiring), real handlers with fake Telegram transport:
1. "delete it" after a created event shows that exact event and asks; "yes" deletes it once.
2. Second "yes" (or duplicate callback) after completion: no second `delete_event` call.
3. Transport or tool throws mid-write: outcome `unknown`, the user is told it cannot be confirmed, the
   next "yes" does nothing, the AI agent is not called with the original request.
4. Event edited between the question and "yes": no write, "changed" answer with current state.
5. Two events in the reply-mapped message: `choices`, no write.
6. Ordinal "the second one" after a list of three picks position 2; after a list of one: clarification.
7. Group chat: another member's "delete it" does not see the first member's references.
7a. Forum topics: a delete question asked in topic A and answered yes in topic B runs no tool; two
   questions in topics A and B leave only the later one resumable, and only from its own topic.
8. Corpus harness (PR-0) contextual bucket count reported before/after; no regression in other buckets.
