---
migration: 066_contact_directory
rollback-compatible: no
data-deletion: no
---

# Migration 066: contact directory (aliases and collective groups)

`src/database/migrations.ts`, migration `066_contact_directory`. Part of GH-654/GH-655.

## What it does

1. `DROP INDEX idx_contacts_user_name` — the unique index on `contacts(user_id, LOWER(name))`
   added in `010_create_contacts`. It blocked two different people from ever sharing a name in one
   user's address book. No row is touched; only the constraint is removed.
2. `CREATE TABLE contact_aliases` — every name/nickname a user calls a contact by. `contacts.name`
   remains the "primary alias" of record; `promote()` (application code) keeps the two in sync.
   Uniqueness is `UNIQUE (contact_id, LOWER(alias))` — scoped to the contact, not the user — so two
   different contacts of the same owner MAY share an alias/name (the real-world case this migration
   exists to unblock); disambiguation happens at lookup time
   (`ContactRepository.searchByName` / `ContactResolver`), never as a write-time rejection.
3. `CREATE TABLE contact_groups` and `contact_group_members` — explicit collective aliases (e.g.
   "грюковы" for a household) that resolve to every member at once. `contact_groups.alias` is
   unique per user and checked against `contact_aliases` at creation time, so an exact lookup is
   never ambiguous between "the person nicknamed X" and "the group named X". Membership is only
   ever written by an explicit application call — this migration inserts no membership rows.
4. Backfill: `INSERT INTO contact_aliases (user_id, contact_id, alias, is_primary, source) SELECT
   user_id, id, name, 1, 'primary_name' FROM contacts` — one primary alias per existing contact,
   copied from its current name. Because `idx_contacts_user_name` was still enforcing uniqueness
   for every row that existed before step 1 ran, this backfill can never collide with the new
   per-contact unique index in step 2 — it is safe by construction, not by a runtime check.

No `contacts` row is updated or deleted. No other table is touched.

## Declarations

- `rollback-compatible: no` (corrected 2026-09-29; the original draft declared `yes` and was
  wrong — see below). `data-deletion: no`. Every `contacts` row keeps its `id`, `name`, `username`,
  `telegram_id`, `preferred_name` and `created_at` exactly as before; the backfill only adds rows
  to a brand-new table.
- **Why rollback is unsafe once this migration has been live for any real time.** Step 1 drops
  `idx_contacts_user_name`, the unique index that made two contacts sharing a name structurally
  impossible. Every pre-066 exact-name lookup was written assuming that impossibility and is NOT
  ambiguity-safe: `ContactRepository.findByNameStrict` (pre-066, confirmed by reading
  `main`@`c5ab9786`) is `contacts.find(c => c.name.trim().toLowerCase() === lower) ?? null` — an
  unguarded first match, not a "no match on ambiguity" refusal — and `searchByName`'s tie-break
  (`localeCompare` on name, ascending) picks an arbitrary one of two exact-confidence duplicates the
  same way. `upsert()` uses `findByNameStrict` to decide which existing contact a new
  username/Telegram-ID patch attaches to. Once a second same-named contact exists (the entire point
  of #654/#655 shipping), rolling back to any pre-066 image makes that pick arbitrary instead of
  correct: `upsert()` can attach a real Telegram ID or username to the WRONG one of two duplicate
  contacts, silently. That is an identity-integrity fault, not the "no crash, no special case"
  the original draft of this doc claimed — the draft was checking only "does old code crash",
  not "does old code pick the right row".
- **What would have made rollback actually safe, and why this migration does not qualify.** The
  clean fix is two ordered deliveries: ship an ambiguity-safe legacy lookup FIRST (on the
  then-still-unique schema, so it is a no-op change in practice), let it run as the deployed
  image for a while, and only then remove the uniqueness constraint in a later migration — the
  rollback target at that point already handles duplicates safely. This migration bundles the
  lookup fix (`findByNameStrict` returning `null` on ambiguity, in the CURRENT code, not the
  rolled-back image) and the constraint removal in the same release, which does not satisfy that
  bar: the image being rolled back TO is exactly the unsafe one described above.

## Rollback

No schema step is needed to roll the running binary back: `runMigrations` ignores applied
records it does not know, and pre-066 code does not read `contact_aliases`, `contact_groups` or
`contact_group_members`. The unsafe part is what pre-066 code DOES with the `contacts` table once
it already contains duplicate names (see Declarations above) — that risk exists independent of
whether the three new tables are also dropped.

**Required activation/rollback procedure** (this is why the migration gate — see
`scripts/migration-gate.py` — refuses to auto-activate a `rollback-compatible: no` migration and
requires an explicit human-reviewed running/release SHA pair before it will run):

1. Before rolling back to any pre-066 image, check for duplicates the new schema allowed:
   ```sql
   SELECT user_id, LOWER(name), count(*) FROM contacts GROUP BY user_id, LOWER(name) HAVING count(*) > 1;
   ```
2. If that query returns no rows, the rollback is safe as-is (no duplicate name exists for old
   code to pick between) — proceed with a reviewed override.
3. If it returns rows, deduplicate FIRST: for each group, keep one contact and either delete or
   rename the other(s) so no two contacts owned by the same user share a name, THEN roll back.
   Never let the rollback run against a database with existing duplicates — the old binary's
   `upsert()` can attach new identity metadata to the wrong one of them.
4. Only after step 2 or 3, optionally remove the new tables entirely (harmless to keep otherwise):
   ```sql
   BEGIN IMMEDIATE;
   DROP TABLE contact_group_members;
   DROP TABLE contact_groups;
   DROP TABLE contact_aliases;
   CREATE UNIQUE INDEX idx_contacts_user_name ON contacts(user_id, LOWER(name));
   DELETE FROM migrations WHERE name = '066_contact_directory';
   COMMIT;
   ```
   Re-creating `idx_contacts_user_name` only succeeds if step 1's query returned no rows at the
   time this runs — re-check immediately before, not just at initial diagnosis time.

## Verifying after deploy

```sql
SELECT count(*) FROM contacts;
SELECT count(*) FROM contact_aliases WHERE source = 'primary_name';
```

The two counts match immediately after this migration runs — one backfilled primary alias per
existing contact. `SELECT count(*) FROM contact_aliases WHERE is_primary = 1 GROUP BY contact_id
HAVING count(*) <> 1` returns no rows (exactly one primary alias per contact, always).
