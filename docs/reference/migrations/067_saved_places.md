---
migration: 067_saved_places
rollback-compatible: yes
data-deletion: no
---

# Migration 067: saved places (home/work/household links)

`src/database/migrations.ts`, migration `067_saved_places`. Part of GH-655 (#398, design §13/§24).

## What it does

Three brand-new tables — no existing table, column or index is touched.

1. `CREATE TABLE saved_places` — the owner-scoped persistent place directory: `label` (the
   user's own name for the place), optional `venue_name`/`address`/`latitude`/`longitude`/
   `provider`/`provider_place_id`/`map_url`/`notes`, `favorite`, `verification`
   (`unconfirmed`/`confirmed`), `provenance`, an optimistic-concurrency `revision`, and
   `deleted_at` for soft delete/restore. The Redis `AddressCache` stays a derived cache
   (frequency/recency hints) — nothing here reads or migrates its data; old `mappings`/`freq`
   entries are never imported as if the user had confirmed them.
2. `CREATE TABLE place_aliases` — owner-scoped search aliases ("Ушће" / `Ušće` / `Usce park` for
   one place). Unique per `(place_id, LOWER(alias))`, **not** per-user — the same reasoning as
   `contact_aliases` in migration 066: two different places may legitimately share an alias text
   (the design doc's own example: "дом", "офис" are personal labels a user reuses, not global
   places), so a lookup returning more than one holder is a disambiguation case for the caller,
   never a write-time conflict.
3. `CREATE TABLE place_roles` — home/work role bindings, one link mechanism for all three cases
   design §24 names: the owner's own `home`/`work` (`owner_type='self'`), a contact-bound place
   like "Lena's home" (`owner_type='contact'`, a private note of the requesting owner — never
   published, never requires the other person's consent), and a household's agreed shared home
   (`owner_type='group'`, e.g. the "Грюковы" collective alias from #654). Each row is a **link** to
   a `saved_places` row (`place_id`), never a copy of its address, matching the design doc's
   explicit "a link, not a copy" correction. `owner_ref_id` is `0` (not `NULL`) for `self` so the
   unique index `(user_id, role, owner_type, owner_ref_id)` actually enforces "at most one home per
   self/contact/group" — SQLite's multi-`NULL`-is-never-equal semantics would silently fail to
   enforce that with a nullable column instead.

No FK from `place_roles.owner_ref_id` to `contacts`/`contact_groups`: SQLite has no conditional FK,
and the two tables it could point to depend on `owner_type`. Ownership is validated in application
code (`PlaceRoleRepository`), the same pattern `contact_group_members` already uses for its
contact-vs-group polymorphism.

## Declarations

- `rollback-compatible: yes`. Pre-067 code never reads any of these three tables; rolling the
  image back after this migration ran changes nothing observable.
- `data-deletion: no`. Purely additive — three new tables, zero rows touched anywhere else.

## Rollback

```sql
BEGIN IMMEDIATE;
DROP TABLE place_roles;
DROP TABLE place_aliases;
DROP TABLE saved_places;
DELETE FROM migrations WHERE name = '067_saved_places';
COMMIT;
```

## Verifying after deploy

```sql
SELECT count(*) FROM saved_places;
SELECT count(*) FROM place_aliases;
SELECT count(*) FROM place_roles;
```

All three are `0` immediately after this migration runs (no backfill); they grow as users save
places and set home/work/household links.
