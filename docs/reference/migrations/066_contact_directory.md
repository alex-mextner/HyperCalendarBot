---
migration: 066_contact_directory
rollback-compatible: yes
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

- `rollback-compatible: yes`. Rolling the image back to pre-066 code after this migration ran
  changes nothing observable to that code: it never reads `contact_aliases`, `contact_groups` or
  `contact_group_members`, and neither `ContactRepository.add`/`upsert`/`findByName` requires
  `idx_contacts_user_name` to be present to run correctly — the index was a DB-level backstop for
  an invariant the application layer (`upsert`'s `findByNameStrict` dedup) already enforces in
  code, not a dependency of any query shape. The one behavior change visible to *old* code is that
  two contacts with the same name can now exist for one user (previously impossible); old code
  handles that the same way it already handles any two distinct rows — no crash, no special case.
- `data-deletion: no`. Every `contacts` row keeps its `id`, `name`, `username`, `telegram_id`,
  `preferred_name` and `created_at` exactly as before. The backfill only adds rows to a brand-new
  table.

## Rollback

An image rollback needs no schema step: `runMigrations` ignores applied records it does not know,
and pre-066 code does not read any of the three new tables. To remove them entirely (only if
required; harmless to keep otherwise):

```sql
BEGIN IMMEDIATE;
DROP TABLE contact_group_members;
DROP TABLE contact_groups;
DROP TABLE contact_aliases;
CREATE UNIQUE INDEX idx_contacts_user_name ON contacts(user_id, LOWER(name));
DELETE FROM migrations WHERE name = '066_contact_directory';
COMMIT;
```

Re-creating `idx_contacts_user_name` after 066 only succeeds if no user has since saved two
contacts with the same name — check first:

```sql
SELECT user_id, LOWER(name), count(*) FROM contacts GROUP BY user_id, LOWER(name) HAVING count(*) > 1;
```

## Verifying after deploy

```sql
SELECT count(*) FROM contacts;
SELECT count(*) FROM contact_aliases WHERE source = 'primary_name';
```

The two counts match immediately after this migration runs — one backfilled primary alias per
existing contact. `SELECT count(*) FROM contact_aliases WHERE is_primary = 1 GROUP BY contact_id
HAVING count(*) <> 1` returns no rows (exactly one primary alias per contact, always).
