---
migration: 068_dialogue_v3_sessions
rollback-compatible: yes
data-deletion: no
---

# Migration 066: dialogue v3 sessions

`src/database/migrations.ts`, migration `068_dialogue_v3_sessions`. Part of GH-652.

## What it does

Pure additive DDL, one new table:

```sql
CREATE TABLE dialogue_v3_sessions (
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  topic_id   INTEGER NOT NULL DEFAULT 0,
  data       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id, topic_id)
)
```

No existing table, column, index or row is touched. `topic_id` defaults to `0` for chats with no
forum topics, matching how the rest of the codebase already normalizes an absent Telegram
`message_thread_id`.

## Why this table, not an existing one

Considered and rejected before writing this migration:

- **`workflow_sessions`** (`033_workflow_sessions`): its `data` column is validated against
  `WorkflowSessionSchema` (`src/database/repositories/workflow-session.repository.ts`), which
  *requires* `intentId`, `workflow` and `stepResults` — fields a v3 draft (title/schedule/
  people/place/description/recurrence) does not have. Storing a v3 session there would mean
  either corrupting that schema for the live regex-intent engine, or wrapping every v3 payload
  in a fake placeholder `Workflow` object just to satisfy validation. The two concepts also have
  no natural shared row identity: `workflow_sessions` is keyed by `(chat_id, user_id)` only, no
  topic axis, and a real chat can have both an active regex-intent suspension and an unrelated
  in-progress `/add` draft for the same user at once — sharing one primary key would let one
  silently clobber the other.
- **`gramio_scenes`** (`src/bot/scenes/storage.ts`, framework-owned): keyed by
  `@gramio/scenes:${userId}` with no chat/topic scoping of its own (`chat-scoped-storage.ts`
  exists only to bolt that on for the legacy wizard). Reusing it would mean either modifying
  `add-event.scene.ts`'s untouched storage contract or fighting the GramIO scene framework's own
  key format for a case it was never designed for (natural-text turns outside any scene).

This table follows the exact same idiom as `workflow_sessions` instead — same `Database`
instance, same TEXT-JSON-payload + `created_at`/`updated_at` + row-age TTL shape (see
`DialogueSessionRepository`, TTL enforced in application code, not SQL), its own repository
class registered on `DatabaseService` (`db.dialogueSessions`) — rather than a second database
file or a new migration engine.

## Rollback

Rolling the image back to a pre-068 build leaves `dialogue_v3_sessions` in place; older code
never references it (the whole v3 dialogue runtime is new code, gated off by default via
`DIALOGUE_V3_ENABLED`). No older code path reads or writes this table, so rollback is a no-op
for it.

To drop the table entirely (only if required; it is harmless to keep):

```sql
BEGIN IMMEDIATE;
DROP TABLE dialogue_v3_sessions;
DELETE FROM migrations WHERE name = '068_dialogue_v3_sessions';
COMMIT;
```

## Verifying after deploy

```sql
SELECT count(*) FROM dialogue_v3_sessions;
```

Expect `0` immediately after deploy (no v3 sessions have been created yet, and none can be
created while `DIALOGUE_V3_ENABLED` is unset/false). The count grows only once the flag is
turned on and users start an `/add` command or natural-text draft that needs a follow-up
question.
