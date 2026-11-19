---
migration: 071_ai_usage_native_cache
rollback-compatible: yes
data-deletion: no
---

# Migration 071: native Claude cache accounting

Refs #826. Adds nullable `fresh_input_tokens`, `cache_write_tokens` and `credential_id` to `ai_usage_events`.

`prompt_tokens` remains the full input total: native fresh input plus cache creation plus cache reads. `cached_tokens` is cache reads. A missing native count is unknown, not zero; historical rows are not backfilled. `credential_id` holds only the first 12 hexadecimal characters of SHA-256 of the selected credential. It cannot authenticate and carries no user, chat, prompt or account email.

The previous application ignores these additive columns, so an image rollback needs no database change. Keep the columns and migration record. Verification: confirm the migration row exists, then inspect the three numeric cache categories and the opaque credential id on new native attempts; old rows remain NULL.
