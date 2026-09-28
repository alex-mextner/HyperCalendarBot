---
migration: 063_unconfirm_legacy_verified_locations
rollback-compatible: yes
data-deletion: yes
---

# Migration 063: unconfirm legacy verified locations

`src/database/migrations.ts`, migration `063_unconfirm_legacy_verified_locations`.

## What it does

A single statement, no schema change:

```sql
UPDATE events SET location_verified = 0 WHERE location_verified = 1;
```

The migration's own code comment states the reason:

> location_verified = 1 now means the user confirmed the place (a candidate tap or a pin), and
> Google Calendar, first-person invitations, ICS and the assistant show it. Until 2026-09-27
> (#382) verification also set it on its own for a lone geocode or a remembered mapping, and
> such rows cannot be told from confirmed ones, so none counts as confirmed: those surfaces
> keep the typed text until the user confirms again. Only the flag changes; the resolved place
> stays, and updated_at / sync_version are untouched so no row looks edited to sync.

- **DML only, no DDL.** No column is added, renamed or dropped. The table shape is unchanged.
- The resolved venue, address, coordinates and map link on every row stay as they were.
- **Idempotent.** Running the `UPDATE` again changes nothing once no row has `location_verified = 1`.

## Declarations

- `rollback-compatible: yes`. Rolling the container image back to the pre-#413 version after
  this migration ran changes nothing observable. Pre-#413 code never read `location_verified` for
  Google Calendar, first-person invitations or ICS output, so those surfaces behave as they did
  before this release whatever the flag's value. No older code path breaks on
  `location_verified = 0`.
- `data-deletion: yes`. The migration overwrites the flag on every row that has it, and the
  earlier value survives only in a backup taken before 063 ran. See the risk below.

## Risk: real confirmations are cleared too

#408 (e20c405f) went live on 2026-09-27 at about 17:42Z. From then on, `location_verified = 1`
is written only when a user confirms a place (`applyResolvedLocation`, which also sets
`updated_at`). 063 cannot tell such a row from a legacy auto-verified one, so it clears both. A
place a user confirmed between #408's deploy and 063's therefore shows as unconfirmed again:
Google Calendar, ICS, first-person invitations and the assistant show the typed text until the
user confirms it once more. Its confirmed state can be restored only from a pre-063 backup, and
only for a row whose place has not changed since.

## Production run (2026-09-27)

063 was applied at 21:31:07Z by release a0980cee (hosted deploy run 36351556699).

- Before: 36 events had `location_verified = 1`. None had been updated after 2026-09-23 20:50:36,
  so none was a post-#408 confirmation.
- After: 0 events have the flag. The ids, `updated_at`, `sync_version` and resolved address of
  those 36 rows hash identically before and after. Nothing needed restoring.
- The pre-switch backup `calendar_2026-09-27_21-31-02.db.gz` (sha256
  `beb9b76f1ea9bba4bf7a7569335c76560c30ad8350121c12ff023140a896585f`) is the only snapshot taken
  before 063. A root-only copy, outside the 14-day backup sweep, is kept in
  `/opt/hypercal/releases/migration-063-evidence/`.

## Rollback

An image rollback needs no schema step: `runMigrations` ignores applied records it does not know,
and the older code does not depend on the flag. Do not reset `location_verified` by hand.
Restoring a confirmation that 063 cleared needs a reviewed procedure: take the row's flag from the
retained backup, and only where the place is unchanged since.

## Verifying after deploy

```sql
SELECT count(*) FROM events WHERE location_verified = 1;
```

Immediately after this migration runs the count is `0`. It grows again as users confirm places
(tap a geocode candidate or drop a pin), which is intended. It must never include a flag set by
the pre-#382 auto-verification.
