---
migration: 067_dialogue_v3_sessions_revision
rollback-compatible: yes
data-deletion: no
---

# Migration 067: dialogue v3 sessions revision column

`src/database/migrations.ts`, migration `067_dialogue_v3_sessions_revision`. Part of GH-652
(correction pass — the parent runtime/source review required a durable revision identity for
compare-and-swap writes, not a plain upsert).

## What it does

Pure additive DDL, one new column on the existing `dialogue_v3_sessions` table (migration `066`):

```sql
ALTER TABLE dialogue_v3_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
```

No existing row, index or other column is touched.

## Why

A v3 draft session is mutated by every ordinary chat turn, and can also be reached by a late or
duplicate delivery — a retried Telegram webhook, or (once GH-656 wires the AI handoff) a slow AI
response that resolves after the user already answered the same question locally. The original
`DialogueSessionRepository.set()` was an unconditional upsert: whichever write lands last always
wins, so a late write can silently overwrite a newer answer, or a duplicate delivery can attempt
to execute (create the event for) the same draft twice.

`revision` turns every session write into a compare-and-swap: the repository only accepts a write
when the caller's `expectedRevision` still matches the row currently in the database (`null` for
"this must not already exist"), and increments the stored revision on every successful write. A
caller whose expected revision is stale gets `{ ok: false }` back and must re-read the current
session and decide what to do, instead of blindly clobbering it.

## Rollback

Rolling the image back to a pre-067 build leaves the `revision` column in place; older code never
reads or writes it, so its presence is harmless. No older code path breaks.

To drop the column (SQLite requires a full rebuild-and-copy in older engine versions; only do
this if truly required — it is harmless to keep):

```sql
BEGIN IMMEDIATE;
CREATE TABLE dialogue_v3_sessions_new (
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  topic_id   INTEGER NOT NULL DEFAULT 0,
  data       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id, topic_id)
);
INSERT INTO dialogue_v3_sessions_new SELECT chat_id, user_id, topic_id, data, created_at, updated_at FROM dialogue_v3_sessions;
DROP TABLE dialogue_v3_sessions;
ALTER TABLE dialogue_v3_sessions_new RENAME TO dialogue_v3_sessions;
DELETE FROM migrations WHERE name = '067_dialogue_v3_sessions_revision';
COMMIT;
```

## Verifying after deploy

```sql
SELECT revision FROM dialogue_v3_sessions LIMIT 1;
```

Expect either no rows (no v3 session has been created yet — `DIALOGUE_V3_ENABLED` is still off in
most environments) or every row's `revision` to be a positive integer.
