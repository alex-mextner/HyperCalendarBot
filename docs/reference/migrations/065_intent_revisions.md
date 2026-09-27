# Migration 065: intent revisions

`src/database/migrations.ts`, migration `065_intent_revisions`. Part of GH-334.

## What it does

1. `CREATE TABLE IF NOT EXISTS intent_basis_manifest (...)` with exactly the shape that
   `scripts/replace-intent-basis.ts` used to create ad hoc. On production the table already exists
   (one row, 52 rules), so this statement is a no-op there; on fresh databases the table now comes
   from the schema.
2. `CREATE TABLE intent_revisions (...)`: an append-only ledger of revisions of the managed intent
   catalogue (kind, status, parent, base revision and fingerprint, target fingerprint, the full
   target rule set, body and body hash, server-set author, decision fields), plus a partial unique
   index that allows at most one `active` revision and a `(status, id)` index.
3. Backfill (`backfillActiveRevision` in `src/services/intent/revision-ledger.ts`): when a manifest
   row exists and no revision is active, the approved `intents` rows are decoded and fingerprinted.
   Only if that fingerprint equals the live manifest is one row inserted:
   `kind='source_baseline', status='active', author='migration'`, target = the manifest
   fingerprint, target rules = the current approved rows. The build's source seed is never
   consulted, so the order in which this lands relative to seed edits (#426, #548) does not matter.
   If the rows are unparseable or differ from the manifest, nothing is inserted and nothing throws.
   On an unmanaged database (no manifest row) nothing is inserted.

No existing row is updated or deleted. `intents`, `events`, `users` and every other table are
untouched.

## Why it is safe to deploy automatically

- Additive DDL only; the only pre-existing table named is created with `IF NOT EXISTS` and the
  same columns.
- The backfill blesses nothing it cannot verify: a registry whose rows drift from the manifest
  stays exactly as fail-closed as before (`getApproved()` returns `[]` and logs
  `intent_registry_tampered`), and the operator repairs it with `scripts/replace-intent-basis.ts`,
  which now also records its result as the active revision (and repairs a lost or mismatched
  active revision even when the rows already equal the seed). That script requires this
  migration: on a database without `intent_revisions` it refuses before touching any row.
- With the new code, `getApproved()` loads the catalogue when rows, manifest and the active
  revision agree, independently of the build's source seed. The production catalogue (52 rules)
  therefore keeps loading after this deploy, and after later deploys that only change the seed.

## Rollback

Rolling the image back to a pre-065 build leaves `intent_revisions` in place; older code never
reads it. Older code compares the manifest with its own compiled seed:

- while the active revision is still the one backfilled from that seed, the older build loads the
  catalogue exactly as before;
- after any revision activated by the new code (a learned, manual or new source rule set), the
  older build loads `[]` (fail closed: the AI path answers everything). It never crashes.

To drop the ledger entirely (only if required; it is harmless to keep):

```sql
BEGIN IMMEDIATE;
DROP TABLE intent_revisions;
DELETE FROM migrations WHERE name = '065_intent_revisions';
COMMIT;
```

Do not drop `intent_basis_manifest`; production created it before this migration.

## Verifying after deploy

```sql
SELECT id, kind, status, author, target_fingerprint FROM intent_revisions;
SELECT fingerprint, rule_count FROM intent_basis_manifest;
```

Expect exactly one `active` row whose `target_fingerprint` equals the manifest fingerprint, and
`SELECT count(*) FROM intents WHERE status = 'approved'` equal to `rule_count` (52 on 2026-09-28).
If the revision table is empty on a managed database, the startup log contains
`intent_registry_tampered: approved rows differ from the manifest; no revision backfilled`; the
catalogue was then already disabled before the deploy.
