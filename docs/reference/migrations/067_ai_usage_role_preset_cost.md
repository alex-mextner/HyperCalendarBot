---
migration: 067_ai_usage_role_preset_cost
rollback-compatible: yes
data-deletion: no
---

# Migration 067: role, preset and cost in the AI usage ledger

`src/database/migrations.ts`, migration `067_ai_usage_role_preset_cost`. Stage B4 of #808.

## What it does

```sql
ALTER TABLE ai_usage_events ADD COLUMN role TEXT;
ALTER TABLE ai_usage_events ADD COLUMN preset TEXT;
ALTER TABLE ai_usage_events ADD COLUMN cost_micro_usd INTEGER
  CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0);
```

Three nullable columns on the ledger created by 066:

- `role`: the routing role (`planner`, `executor` or `repair`) of a role-routed attempt; NULL on a
  legacy-chain attempt and on every row written before this migration.
- `preset`: the model preset id (`src/services/ai/model-presets.ts`) the slot ran; NULL when none.
- `cost_micro_usd`: the cost of the attempt in micro-USD (1e-6 USD), taken from the cost OpenRouter
  reports in the response usage, else from the dated list-price table of the preset that names that
  provider and model, else NULL. NULL is unknown and is never written as 0; a stored 0 is a cost that
  is really zero.

The same three columns, with the same names and meaning, exist in ExpenseSyncBot's `ai_usage_events`
(its migration 054), so the two ledgers can be compared.

For role-routed attempts the existing `chain` column now reads `role:<role>` (for example
`role:executor`) instead of `smart`/`fast`. Rows written before stay as they were.

No existing column or row is read, changed or deleted.

## Order in the file

Appended after `066_ai_usage_events`, the last entry. Nothing is moved or renumbered.

## Why it is safe to deploy automatically

- Additive DDL only: `ALTER TABLE ... ADD COLUMN` of nullable columns. Existing rows read back NULL.
- The image before this migration inserts into `ai_usage_events` with an explicit column list and
  reads it with an explicit column list, so it keeps working on the migrated database
  (`test/database/migrations-067.test.ts`).
- Recording stays best-effort: a failed insert is logged as a warning and never changes the answer a
  user receives.

## Rollback

An image rollback needs no schema step: the previous image ignores the new columns and applied
migrations it does not know. Keep the columns and the `migrations` row; the data is a statistics
ledger, not calendar data.

Dropping the columns is never required. If it ever is, it deletes the role, preset and cost statistics
only:

```sql
BEGIN IMMEDIATE;
ALTER TABLE ai_usage_events DROP COLUMN role;
ALTER TABLE ai_usage_events DROP COLUMN preset;
ALTER TABLE ai_usage_events DROP COLUMN cost_micro_usd;
DELETE FROM migrations WHERE name = '067_ai_usage_role_preset_cost';
COMMIT;
```

## Verifying after deploy

```sql
SELECT name FROM migrations WHERE name = '067_ai_usage_role_preset_cost';
SELECT role, preset, count(*), sum(cost_micro_usd) FROM ai_usage_events GROUP BY 1, 2;
```

Expect one migration row; `role` and `preset` stay NULL until `AI_ROUTING=roles` serves traffic, and
`cost_micro_usd` is NULL for every provider that reports no cost and has no price. `bun
scripts/report-ai-usage.ts` and the admin command `/ai_stats` show cost and latency per role and
provider.
