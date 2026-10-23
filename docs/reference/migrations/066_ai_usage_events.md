---
migration: 066_ai_usage_events
rollback-compatible: yes
data-deletion: no
---

# Migration 066: AI usage ledger

`src/database/migrations.ts`, migration `066_ai_usage_events`. Tracked in #801.

## What it does

```sql
CREATE TABLE ai_usage_events (...);
CREATE INDEX idx_ai_usage_events_at ON ai_usage_events(at);
CREATE INDEX idx_ai_usage_events_provider_at ON ai_usage_events(provider, at);
```

One append-only row per provider attempt of an AI round (`aiStreamRound`): answered (`ok`), failed
(`error`) or passed over before any request was sent (`skipped`, with a `skip_reason`). Columns: `at`
(epoch ms UTC, attempt start), `provider`, `model`, `chain` (`smart` or `fast`), `purpose`
(`agent`, `history`, `validator`, `retry`, ...), `outcome`, `error_class` and `http_status` (from the
SDK error; the provider's error body is never stored), `duration_ms`, `prompt_tokens`,
`completion_tokens`, `reasoning_tokens`, `cached_tokens` and `request_id`.

The four token columns are NULL when the provider reported no usage. NULL is unknown, never zero;
the report counts such rows separately instead of adding them to the sums.

The table holds no prompt, completion, user id, chat id or credential. Rows older than 180 days are
deleted by the bot-tasks repeating job `ai-usage-cleanup-tick` (daily).

No existing table is read or changed.

## Order in the file

The entry is appended after `064_event_participant_source_group`, which itself sits after
`065_intent_revisions` (production applied 065 first). The schema gate needs new entries after the
shipped ones, so 066 is neither moved nor renumbered.

## Why it is safe to deploy automatically

- Additive DDL only: a new table and two indexes. No existing value changes and nothing is deleted.
- The image before this migration never reads or writes the table, so it keeps working on the
  migrated database (`test/database/migrations-066.test.ts`).
- Recording is best-effort: a failed insert is logged as a warning and never changes the answer a
  user receives.

## Rollback

An image rollback needs no schema step: the previous image ignores the table and applied migrations
it does not know. Keep the table and the `migrations` row; the data is a statistics ledger, not
calendar data.

Dropping the ledger is never required. If it ever is, it deletes the recorded statistics only:

```sql
BEGIN IMMEDIATE;
DROP TABLE ai_usage_events;
DELETE FROM migrations WHERE name = '066_ai_usage_events';
COMMIT;
```

## Verifying after deploy

```sql
SELECT name FROM migrations WHERE name = '066_ai_usage_events';
SELECT provider, model, outcome, count(*) FROM ai_usage_events GROUP BY 1, 2, 3;
```

Expect one migration row; the table fills as users talk to the bot. `bun scripts/report-ai-usage.ts`
prints the same data per provider, and the admin command `/ai_stats` answers in Telegram.
