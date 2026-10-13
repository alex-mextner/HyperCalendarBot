---
migration: 066_events_color
rollback-compatible: yes
data-deletion: no
---

# Migration 066: per-event color from Google Calendar

`src/database/migrations.ts`, migration `066_events_color`. Part of PR #214 (#29).

## What it does

```sql
ALTER TABLE events ADD COLUMN color TEXT;
```

Google Calendar events carry a `colorId` (1–11) for the color the user picked for that one event.
Google sync now maps it to the hex Google shows (`GCAL_EVENT_COLORS` in
`src/services/google/event-mapper.ts`) and stores it in `events.color` on every pull write: the
initial import, an incremental create and an incremental update (an event whose color was removed
in Google gets `NULL` back). The daily, weekly, monthly and event-card renders draw an event in its
own color when `color` is a `#RRGGBB` hex (on the dark theme mixed 40% toward white, so Basil,
Blueberry, Grape and Graphite stay readable), else in the theme's rotation as before; birthdays keep
their birthday color. When the bot pushes an edit of such an event back to Google, the full-event
update sends the matching `colorId`, so the edit does not reset the color in Google.

No row is updated or deleted. Every existing event has `color` NULL and renders exactly as before.
An already-synced Google event gets its color the next time Google reports it changed (an
incremental pull updates the row; the initial import's `INSERT OR IGNORE` never rewrites an existing
row); nothing is backfilled.

## Order in the file

Appended after `064_event_participant_source_group`, the last shipped entry. `065` is already taken
by `065_intent_revisions`, so this is `066`.

## Why it is safe to deploy automatically

- Additive DDL only: one nullable column without a default. No existing value changes.
- The image before this migration keeps working on the migrated table: every `INSERT INTO events`
  names its columns, its `UPDATE`s set named columns, and its `SELECT *` gets one extra field it
  never reads.

## Rollback

An image rollback needs no schema step: the old image ignores the column. Colors written meanwhile
stay in the column and are used again after the next forward deploy. Dropping the column is never
required.

## Verifying after deploy

```sql
SELECT name FROM migrations WHERE name = '066_events_color';
SELECT name, type, "notnull" FROM pragma_table_info('events') WHERE name = 'color';
SELECT count(*) FROM events WHERE color IS NOT NULL;
```

Expect one migration row, the nullable `TEXT` column, and a count of `0` right after the deploy that
grows as Google reports colored events. Then color an event in a connected Google Calendar (for
example Tomato), wait for the sync, and check that /today or /week draws it in that color.
