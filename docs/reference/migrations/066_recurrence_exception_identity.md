---
migration: 066_recurrence_exception_identity
rollback-compatible: yes
data-deletion: no
---

# Migration 066: recurrence exception identity

`src/database/migrations.ts`, migration `066_recurrence_exception_identity`.
Backfill logic: `src/services/event/backfill-exception-identity.ts`.

## What it does

Two steps, in one transaction:

```sql
ALTER TABLE events ADD COLUMN identity_status TEXT DEFAULT NULL;
```

then `backfillExceptionIdentity(db)` scans every exception row (`parent_event_id IS NOT NULL AND
is_deleted = 0`) and, for each one with a live parent template that still has a
`recurrence_rule`:

1. Expands the parent's own occurrence set (via `expandRecurrence`, the same engine used at
   runtime) over a tight ±3-day window around the exception's stored `original_start_at`.
2. Finds every candidate occurrence whose local calendar date (in the parent's timezone) matches
   the exception's local calendar date.
3. **Exactly one candidate**: `original_start_at` is rewritten to that occurrence's exact
   instant — a no-op if it already matches exactly.
4. **Zero or more than one candidate**: `identity_status` is set to `'unresolved'` instead of
   guessing; `original_start_at` is left unchanged.
5. **No live parent, or the parent's rule is itself unsupported**: the row is left untouched
   entirely (neither the instant nor the status is written) — it cannot be validated.

## Why

Spec [`docs/superpowers/specs/2026-09-28-recurrence-semantics-583.md`](../../superpowers/specs/2026-09-28-recurrence-semantics-583.md)
§5/§10: exception identity moves from "local calendar date" to "exact original occurrence
instant" — a series that ever produces two occurrences on the same local date (a multi-time-of-day
rule, or an RDATE landing on the same day as a regular occurrence) could previously collide two
distinct exceptions onto one calendar-day key. `expandRecurrence` now matches exceptions by exact
instant only; this migration recovers that instant for every existing row where it is
unambiguous, and flags the rest for manual resolution rather than guessing.

## Declarations

- `rollback-compatible: yes`. `identity_status` is a new, nullable column that pre-066 code never
  reads or writes. Rolling back to pre-066 code with this migration already applied changes
  nothing observable — the old code path (matching by calendar date) is preserved verbatim as
  `expandLegacy()` behind the `RECURRENCE_LEGACY_ENGINE` capability flag (spec §10), independent
  of this migration having run.
- `data-deletion: no`. `original_start_at` is only ever replaced with a value that resolves to
  the exact same local calendar date it already pointed at (the runtime engine that computed the
  original value and the migration's own resolution use the identical `expandRecurrence` call).
  No exception row, and no other column on any row, is deleted.

## Risk: an exception the migration cannot resolve stays flagged, not repaired

A row flagged `identity_status = 'unresolved'` (case 4 above — its stored `original_start_at`
lands on a local date where the parent template now produces zero or multiple occurrences) is
never auto-matched to a specific occurrence by `expandRecurrence` after this migration:
`expandRecurrence` shows the exception at its own current `start_at` (never silently dropped)
but never lets it suppress or modify a specific template occurrence (never silently guessed onto
one of several candidates either). Resolving it requires a human or a follow-up tool to decide
which occurrence (if any) the row actually belongs to and rewrite `original_start_at`
accordingly; this migration does not attempt that decision.

## Verifying after deploy

```sql
SELECT count(*) FROM events WHERE parent_event_id IS NOT NULL AND identity_status = 'unresolved';
```

A nonzero count is not itself a bug — it names legacy rows genuinely ambiguous under the new
identity rule — but every row it returns needs the manual-resolution follow-up before its
exception can reliably apply to (or be told apart from) other occurrences on the same date.
