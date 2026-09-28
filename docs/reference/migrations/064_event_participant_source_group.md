---
migration: 064_event_participant_source_group
rollback-compatible: yes
data-deletion: no
---

# Migration 064: the group chat an answer came through

`src/database/migrations.ts`, migration `064_event_participant_source_group`. Part of PR #464
(#389 invitation-card roster) and #468.

## What it does

```sql
ALTER TABLE event_participants ADD COLUMN source_group_id INTEGER;
ALTER TABLE event_participants ADD COLUMN source_group_recorded_at TEXT;
```

A member who answers on a group chat's invitation card gets a row in `event_participants`. The new
code records that group chat's id in `source_group_id`, so a group's card and
`get_invitation_status` list an answer only while the group it came through is still invited, and
a group chat sees only its own members' answers (#468: before this, after group A was withdrawn and
group B invited, B's card listed A's answers).

`source_group_recorded_at` binds the origin to the write that recorded it: every new-code write that
records or keeps an origin sets it and `updated_at` from one `datetime('now')`, and the readers
(`sourceGroupSql` in `participant.repository.ts`) use `source_group_id` only while
`source_group_recorded_at = updated_at`. Any write that does not know the columns moves
`updated_at` and so voids the origin.

No row is updated or deleted. Every existing row has both columns NULL: its origin is unknown, and
nothing infers one from group membership or the last invited chat, which would recreate the leak.
An answer of unknown origin is never listed on any invitation card or in `get_invitation_status`
inside a group chat or for an invitee; a reader who sees the event itself (the organizer, or a
reader it is shared with) still sees it in a private chat. Members' answers reappear on their
group's card as they answer there again.

## Order in the file

The entry is appended after `065_intent_revisions`, which production already applied (2026-09-28).
`runMigrations` skips names the `migrations` table records, so 064 runs once and 065 is not
repeated; the schema gate requires new entries after the shipped ones, so the entry is neither
moved before 065 nor renamed.

No released image carried 064 before this one. An earlier, unreleased build of PR #464 had a 064
that added only `source_group_id`; a scratch database that ran that build records 064 without
`source_group_recorded_at`, and every participant read then fails with `no such column`. Repair
such a database with `ALTER TABLE event_participants ADD COLUMN source_group_recorded_at TEXT;`
(every origin it holds then stays void, which is the fail-closed state).

## Why it is safe to deploy automatically

- Additive DDL only: two nullable columns without defaults. No existing value changes.
- The image before this migration keeps working on the migrated table. Its `INSERT` names its
  columns, its `UPDATE` sets `status` and `updated_at`, and its `SELECT *` gets two extra fields it
  never reads (`test/database/migrations-064.test.ts` runs that `INSERT` and `UPDATE`).
- A rollback does not misattribute answers. An answer the old image stores is either a new row
  (no origin) or an update that moves `updated_at` without re-stamping (origin void), so after the
  next forward deploy it is not listed under the group recorded before it, including when the
  member answered on another group's card meanwhile (tested in `invitation-roster.test.ts` and
  `sharing.test.ts`). The void needs the old image's write to land in a different second than the
  row's last new-image write. A deploy or rollback replaces the container rather than running both
  images, so only a wall clock stepping back to exactly that second could defeat it; the answer
  would then keep its old group.
- The old image's own reads are its own behaviour, not a schema effect: while it runs,
  `get_invitation_status` lists every member answer in any chat that holds a live group invitation,
  as production did before this release, and cards carry no roster.

## Rollback

An image rollback needs no schema step: the old image ignores both columns and applied migrations
it does not know. Keep the columns and the `migrations` row; do not backfill `source_group_id` by
hand.

Dropping the columns is never required. If it ever is, it deletes every recorded origin, so after a
later upgrade reruns 064 all answers start again with an unknown origin:

```sql
BEGIN IMMEDIATE;
ALTER TABLE event_participants DROP COLUMN source_group_recorded_at;
ALTER TABLE event_participants DROP COLUMN source_group_id;
DELETE FROM migrations WHERE name = '064_event_participant_source_group';
COMMIT;
```

## Verifying after deploy

```sql
SELECT name FROM migrations WHERE name = '064_event_participant_source_group';
SELECT name, type, "notnull" FROM pragma_table_info('event_participants')
  WHERE name IN ('source_group_id', 'source_group_recorded_at');
SELECT count(*) FROM event_participants WHERE source_group_id IS NOT NULL;
```

Expect one migration row, the two nullable columns (`INTEGER`, `TEXT`), and a count of `0` right
after the deploy that grows as members answer on group cards. Then, in two test group chats: invite
group A, answer Going there, withdraw A and invite group B; B's card and `get_invitation_status` in
B must not list that answer, and existing RSVP buttons must still work.
