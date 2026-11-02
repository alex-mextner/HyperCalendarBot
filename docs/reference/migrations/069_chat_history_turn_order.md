---
migration: 069_chat_history_turn_order
rollback-compatible: yes
data-deletion: no
---

# Migration 069: where a queued user turn is read in the conversation

`src/database/migrations.ts`, migration `069_chat_history_turn_order`. Refs #929 (per-chat run
serialization) and #520.

## What it does

```sql
ALTER TABLE chat_history ADD COLUMN turn_order REAL;
```

One nullable column. Two messages of one chat used to run two agents on overlapping history; a run now
waits for the run ahead of it in its chat (`src/services/ai/chat-run-gate.ts`). The message that waited was
saved before everything the earlier run wrote, so by row order it sits in the middle of that run's output.
When its run starts, `ChatHistoryRepository.placeUserTurnAfterLatest` sets `turn_order` to the newest row's id
plus 0.5 and the history readers order a row by the time of the row it was placed behind and then by
`COALESCE(turn_order, id)`. The row keeps its id (the action log and the per-user row map hold ids) and its
`created_at` (the time the user sent it). A non-NULL `turn_order` also tells the reader that the turn was
sent before the rows it now follows, so the model is shown it as queued and never as the answer to a question
asked after it was sent.

NULL, which every row written before this migration has, means the row reads at its own id and time exactly
as before. No existing column or row is read, changed or deleted.

## Order in the file

Appended after `067_ai_usage_role_preset_cost`, the last entry. Nothing is moved or renumbered. The number
069 leaves 068 to the other open changes that claim it (the AI speed metrics and the image deliveries).

## Why it is safe to deploy automatically

- Additive DDL only: `ALTER TABLE ... ADD COLUMN` of one nullable column; existing rows read back NULL.
- The image before this migration names the columns it reads, or selects `*` and ignores the extra one, and
  inserts with an explicit column list, so it keeps working on the migrated database. It orders by
  `created_at, id`: for a queued turn that is the order the messages were sent in, which is only a different
  reading position, never a lost row.

## Rollback

An image rollback needs no schema step: the previous image ignores `turn_order` and applied migrations it does
not know. Keep the column and the `migrations` row.

Dropping the column is never required. If it ever is, it deletes only the reading positions of queued turns:

```sql
BEGIN IMMEDIATE;
ALTER TABLE chat_history DROP COLUMN turn_order;
DELETE FROM migrations WHERE name = '069_chat_history_turn_order';
COMMIT;
```

## Verifying after deploy

```sql
SELECT name FROM migrations WHERE name = '069_chat_history_turn_order';
SELECT count(*) FROM chat_history WHERE turn_order IS NOT NULL;
```

Expect one migration row. The count stays 0 until two messages of one chat arrive while an earlier agent run
of that chat is still working.
