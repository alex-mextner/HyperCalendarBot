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

## Why this is safe to deploy automatically

- **DML only, no DDL.** No column is added, renamed or dropped. The table shape is unchanged.
- **No data is deleted.** `location_verified` is the only column touched; the resolved venue,
  address, coordinates and map link on every row are kept exactly as they were.
- **Rollback-safe.** Rolling the container image back to the pre-#413 version after this
  migration ran changes nothing observable: pre-#413 code never read `location_verified` for
  Google Calendar, first-person invitations or ICS output in the first place, so those surfaces
  behave exactly as they did before this release regardless of the flag's value. No older code
  path breaks or crashes on `location_verified = 0`.
- **Idempotent.** Re-running the `UPDATE` is a no-op once no row has `location_verified = 1`
  from before a user re-confirms a place.

## Verifying after deploy

```sql
SELECT count(*) FROM events WHERE location_verified = 1;
```

Immediately after this migration runs, this should be `0`: the migration just zeroed every row
that was `1`. Over time the count will grow again as users confirm places (tap a geocode
candidate or drop a pin) after this deploy — that is the intended, correct behavior. What it
must never contain is a row whose flag was set by the pre-#382 auto-verification bug rather than
an explicit user confirmation; that is exactly what this migration cleared.
