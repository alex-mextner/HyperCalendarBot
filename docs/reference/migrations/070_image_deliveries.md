---
migration: 070_image_deliveries
rollback-compatible: yes
data-deletion: no
---

# Migration 070: durable picture deliveries

`src/database/migrations.ts`, migration `070_image_deliveries`. Asynchronous AI pictures, tracked in #799 and #936.

## What it does

```sql
CREATE TABLE image_deliveries (
  id TEXT PRIMARY KEY,            -- deterministic delivery id (also the BullMQ job id suffix)
  chat_id INTEGER NOT NULL,
  language TEXT NOT NULL,
  kind TEXT NOT NULL,             -- day | week | month | table | conflict
  label TEXT NOT NULL,            -- what the user asked for; only ever shown back to that chat
  job_type TEXT NOT NULL,
  slot TEXT NOT NULL,             -- what the picture shows (kind, target, whose calendar; an AI picture's slot also ends with the user's language): a later request for the same slot is deduplicated or supersedes it, also after a restart
  payload_hash TEXT NOT NULL,     -- hash of the render data of job_json: the same slot with the same hash is the same picture
  rebuilds INTEGER NOT NULL DEFAULT 0, -- how many times the job was rebuilt after a calendar write; each rebuild is its own BullMQ job id
  job_json TEXT,                  -- the current render job (replaced by a rebuild), kept until the delivery is terminal, then NULL
  state TEXT NOT NULL CHECK (state IN ('queued','rendered','sending','delivered','failed','expired','unknown','superseded')),
  message_id INTEGER,             -- Telegram message id once delivered
  note_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_image_deliveries_state ON image_deliveries(state);
```

A new table that only this feature reads and writes. Terminal rows (delivered, failed, expired, unknown, superseded) carry no job payload and are pruned once they are 7 days old, at the next start of the bot (the start-up reconciliation is the only caller; a process that stays up keeps them until then).

## Order in the file

Appended after `069_chat_history_turn_order`, the last entry at the time of writing. It was written as 068 on its branch and renumbered to 070 before it was ever released, because main took 069 meanwhile; nothing has recorded the old name. If another branch appends first, this one is renamed before it ships, never after.

## Why it is safe to deploy automatically

Additive DDL: one new table and one index. The previous image does not know the table and ignores it.

## Rollback

An image rollback needs no schema step. Pending rows are then not recovered by the old image (the pictures are lost, as they were before this feature); the next start of this feature ends each of them as `expired`: recent ones (within 10 minutes of their bound) with the one "the bot was restarting, the picture did not arrive" note and no alert (the cause was downtime, not a slow render), older ones silently (their note is claimed unsent) and without an alert, because the user stopped waiting long ago. A row stuck in `sending` ends `unknown` and raises its one `UncertainSend` alert only when its last update is less than 10 minutes old; an older one ends `unknown` silently. Keep the table and the `migrations` row. If the table ever has to go, it holds only delivery bookkeeping:

```sql
BEGIN IMMEDIATE;
DROP TABLE image_deliveries;
DELETE FROM migrations WHERE name = '070_image_deliveries';
COMMIT;
```

## Verifying after deploy

```sql
SELECT name FROM migrations WHERE name = '070_image_deliveries';
SELECT state, count(*) FROM image_deliveries GROUP BY state;
```

Expect one migration row; `queued`/`rendered`/`sending` rows older than the 150 s bound mean a delivery that was never reconciled.
