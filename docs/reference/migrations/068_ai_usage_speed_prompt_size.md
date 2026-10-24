---
migration: 068_ai_usage_speed_prompt_size
rollback-compatible: yes
data-deletion: no
---

# Migration 068: response speed and estimated prompt size in the AI usage ledger

`src/database/migrations.ts`, migration `068_ai_usage_speed_prompt_size`. Tracked in #815.

## What it does

```sql
ALTER TABLE ai_usage_events ADD COLUMN first_token_ms INTEGER CHECK (first_token_ms IS NULL OR first_token_ms >= 0);
ALTER TABLE ai_usage_events ADD COLUMN generation_ms INTEGER CHECK (generation_ms IS NULL OR generation_ms >= 0);
ALTER TABLE ai_usage_events ADD COLUMN system_prompt_tokens INTEGER CHECK (system_prompt_tokens IS NULL OR system_prompt_tokens >= 0);
ALTER TABLE ai_usage_events ADD COLUMN tool_catalog_tokens INTEGER CHECK (tool_catalog_tokens IS NULL OR tool_catalog_tokens >= 0);
ALTER TABLE ai_usage_events ADD COLUMN history_tokens INTEGER CHECK (history_tokens IS NULL OR history_tokens >= 0);
ALTER TABLE ai_usage_events ADD COLUMN user_tokens INTEGER CHECK (user_tokens IS NULL OR user_tokens >= 0);
ALTER TABLE ai_usage_events ADD COLUMN tool_count INTEGER CHECK (tool_count IS NULL OR tool_count >= 0);
ALTER TABLE ai_usage_events ADD COLUMN message_count INTEGER CHECK (message_count IS NULL OR message_count >= 0);
```

Eight nullable integer columns on the ledger created by 066:

- `first_token_ms`: milliseconds from the request start to the first content or tool-call delta of the
  attempt. `generation_ms`: first to last such delta (the trailing usage-only chunk is not one). Written on
  answered attempts only; NULL on a failed or skipped attempt, where the stream timing is not a result, and
  on every row written before this migration. A measured 0 is 0.
- Tokens per second is **not stored**. It is computed at read time as
  `(completion_tokens - reasoning_tokens) * 1000 / generation_ms`: reasoning is billed inside the completion
  tokens but is not streamed, so it is not in the generation window. It is NULL when a side is unknown, when
  `generation_ms < 50`, or when no visible token is left.
- `system_prompt_tokens`, `tool_catalog_tokens`, `history_tokens`, `user_tokens`: the **estimated** size of the
  request by `src/services/ai/token-estimate.ts` (an upper bound within about 20 %; the provider's
  `prompt_tokens` stays the truth). System is the system and developer messages, tool catalog the serialized
  `tools`, user the last message when it is the user's (0 when the request ends otherwise), history every other
  message including assistant tool calls and tool results. Text only, no image bytes.
- `tool_count`, `message_count`: the number of tools and of messages sent.
- The prompt-size columns are written on answered and failed attempts (a request was sent) and are NULL on
  skipped attempts and on older rows. NULL is unknown, never zero.

The same columns, with the same names and meaning, exist in ExpenseSyncBot's `ai_usage_events`.

No prompt text, completion text, user id or chat id is stored. No existing column or row is read, changed or
deleted.

## Order in the file

Appended after `067_ai_usage_role_preset_cost`, the last entry. Nothing is moved or renumbered.

## Why it is safe to deploy automatically

- Additive DDL only: `ALTER TABLE ... ADD COLUMN` of nullable columns. Existing rows read back NULL.
- The image before this migration inserts into and reads `ai_usage_events` with explicit column lists, so it
  keeps working on the migrated database (`test/database/migrations-068.test.ts`).
- Recording stays best-effort: a failed insert is logged as a warning and never changes the answer a user
  receives. Nothing extra is sent to a provider; the sizes are computed from the request already assembled.

## Rollback

An image rollback needs no schema step: the previous image ignores the new columns and applied migrations it
does not know. Keep the columns and the `migrations` row; the data is a statistics ledger, not calendar data.

Dropping the columns is never required. If it ever is, it deletes the speed and size statistics only:

```sql
BEGIN IMMEDIATE;
ALTER TABLE ai_usage_events DROP COLUMN first_token_ms;
ALTER TABLE ai_usage_events DROP COLUMN generation_ms;
ALTER TABLE ai_usage_events DROP COLUMN system_prompt_tokens;
ALTER TABLE ai_usage_events DROP COLUMN tool_catalog_tokens;
ALTER TABLE ai_usage_events DROP COLUMN history_tokens;
ALTER TABLE ai_usage_events DROP COLUMN user_tokens;
ALTER TABLE ai_usage_events DROP COLUMN tool_count;
ALTER TABLE ai_usage_events DROP COLUMN message_count;
DELETE FROM migrations WHERE name = '068_ai_usage_speed_prompt_size';
COMMIT;
```

## Verifying after deploy

```sql
SELECT name FROM migrations WHERE name = '068_ai_usage_speed_prompt_size';
SELECT provider, model, count(*), count(first_token_ms), count(generation_ms), count(tool_catalog_tokens)
FROM ai_usage_events WHERE at > strftime('%s','now','-1 hour') * 1000 GROUP BY 1, 2;
```

Expect one migration row; rows written after the deploy carry `first_token_ms`, `generation_ms` and the
prompt-size columns, older rows stay NULL. `bun scripts/report-ai-usage.ts` and the admin command
`/ai_stats` show first-token, generation-speed and prompt-size statistics with their sample sizes.
