---
migration: 066_action_log_reflection_indexes
rollback-compatible: yes
data-deletion: no
---

# Migration 066: action-log indexes for scoped reflection queries

`src/database/migrations.ts`, migration `066_action_log_reflection_indexes`. Part of #245.

## What it does

```sql
CREATE INDEX IF NOT EXISTS idx_action_log_recipient
  ON user_action_log (user_id, target_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_action_log_owner_chat
  ON user_action_log (user_id, chat_id, created_at DESC, id DESC);
```

`get_action_log` now filters one owner's entries by the affected recipient (`target_user_id`) and,
in a group chat, by that group's `chat_id`. Both queries order by `created_at DESC, id DESC` with a
`LIMIT` of at most 100. The composite indexes let SQLite seek straight to the matching rows in that
order instead of scanning all of the owner's entries and sorting them.

No row is inserted, updated or deleted. No other table is touched.

## Why it is safe to deploy automatically

- Additive DDL only (two indexes, `IF NOT EXISTS`).
- `user_action_log` is append-only audit data; building the indexes is a single pass over it.

## Rollback

The previous image never names these indexes; SQLite keeps them up to date on insert and the
older queries still run (the planner may or may not pick them). Nothing to undo. To drop them
anyway:

```sql
DROP INDEX IF EXISTS idx_action_log_recipient;
DROP INDEX IF EXISTS idx_action_log_owner_chat;
DELETE FROM migrations WHERE name = '066_action_log_reflection_indexes';
```
