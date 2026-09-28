---
migration: 067_event_reminders_identity_index
rollback-compatible: yes
data-deletion: no
---

# Migration 067: event_reminders identity index

`src/database/migrations.ts`, migration `067_event_reminders_identity_index`.

## What it does

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_reminders_identity
  ON event_reminders(event_id, user_id, occurrence_start, interval_minutes, interval_label);
```

A real database-level `UNIQUE` index on `(event_id, user_id, occurrence_start, interval_minutes,
interval_label)` — the reminder identity spec §7 defines. `interval_label` is part of the key
because the two all-day reminders ("day before" / "day of") legitimately share
`interval_minutes = -1`. No other statement runs in this migration — see "Revision" below for
why an earlier draft's backfill step was removed.

## Why

Spec [`docs/superpowers/specs/2026-09-28-recurrence-semantics-583.md`](../../superpowers/specs/2026-09-28-recurrence-semantics-583.md)
§7, corrected after #554 review: an earlier draft of this migration's acceptance criteria (task
#657) proposed `UNIQUE(event_id, remind_at_utc)`. That key is wrong and was never created —
two different recipients of the same event/occurrence legitimately share `remind_at_utc`, and so
do two different occurrences of a multi-time-of-day series (`BYHOUR=10,14`) whose independently
configured reminder intervals happen to compute the same `remind_at_utc`. The application-level
dedup check this index backs (`EventReminderRepository.existsForOccurrence`, replacing the old
`existsForEventAt`, which filtered only by `event_id, remind_at_utc` and did not even consider
`user_id`) already moved to this key before this migration; the index makes it a real
constraint instead of only a check-then-insert race.

## Revision: the backfill step was removed after review

An earlier draft of this migration also ran:

```sql
UPDATE event_reminders
SET occurrence_start = (SELECT start_at FROM events WHERE events.id = event_reminders.event_id)
WHERE occurrence_start IS NULL
  AND event_id IN (SELECT id FROM events WHERE recurrence_rule IS NOT NULL);
```

intending a best-effort backfill of legacy `occurrence_start = NULL` rows (from before
migration 046 added the column) so they would be queryable by occurrence like every row
materialized after 046. Independent review (security pass) found this unsafe: a recurring
template can have **multiple** already-sent legacy rows sharing
`(event_id, user_id, interval_minutes, interval_label)` — one per historical occurrence that had
already fired before 046 (046 only deleted **unsent** rows). The backfill set every one of those
NULLs to the *same* value (the template's current `start_at`), collapsing genuinely distinct
historical rows onto one identical key and violating the very index this migration creates —
aborting the whole migration transaction on data the pre-flight query below could not have
caught (it only looks at non-NULL duplicates). There is no way to reconstruct each such row's
true original `occurrence_start` from the row alone, so the correct fix is not to guess: the
backfill step is removed entirely. SQLite treats every `NULL` as distinct from every other
`NULL` in a `UNIQUE` index, so leaving these rows as `NULL` is both correct and safe — they are
already sent and are never re-queried by occurrence.

## Declarations

- `rollback-compatible: yes`. Pre-067 code never queries or assumes this index exists; it is
  purely an added constraint.
- `data-deletion: no`. No row is deleted and no column is written.

## Risk: this migration cannot verify production data before creating the index

Every current insert path was reviewed and cannot produce a true duplicate under this key:
`ReminderMaterializer.materialize()` always deletes and recreates a event's reminders within one
call (so at most one row per `(event_id, user_id, interval_minutes, interval_label)` — all with
`occurrence_start = NULL`, and SQLite treats every `NULL` as distinct from every other `NULL` in
a `UNIQUE` index, so these rows can never conflict with each other regardless);
`materializeForOccurrence()` (the recurring path) already checks
`existsForOccurrence(event_id, user_id, occurrence_start, interval_minutes, interval_label)`
before every insert. This is a code-path review, not a query against real production data — this
migration cannot see production data from here. **Before this migration runs in production, run
the verification query below against the live database once as a pre-flight check**; if it
returns any row, `CREATE UNIQUE INDEX` will fail the whole migration transaction (fails closed —
no partial state, no data loss) and the duplicate must be resolved by hand before retrying.

## Verifying after deploy

Pre-flight (run once, before this migration, against production):

```sql
SELECT event_id, user_id, occurrence_start, interval_minutes, interval_label, count(*)
FROM event_reminders
GROUP BY event_id, user_id, occurrence_start, interval_minutes, interval_label
HAVING count(*) > 1 AND occurrence_start IS NOT NULL;
```

Expected: zero rows, per the code-path review above (this check cannot see NULL-occurrence_start
duplicates, which is exactly why the backfill that would have exposed them to the unique index
was removed — see "Revision" above). A nonzero result must be resolved (keep one row, decide
what to do with the rest) before this migration is allowed to run.

Post-deploy: the migration either applied (index exists) or the deploy failed outright with a
`UNIQUE constraint failed` error from `CREATE UNIQUE INDEX` — there is no partial/silent state to
check for.
