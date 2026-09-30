# Birthday Events — Design Spec

**Date:** 2026-03-20
**Status:** Approved

---

## Overview

Automatically discover and create birthday events for Telegram group calendar members.
Birthday is a special event type with dedicated metadata, default reminders, and dynamic display logic.

---

## Data Model

### Migration 1 — `events.event_type`

```sql
ALTER TABLE events ADD COLUMN event_type TEXT;
-- NULL = regular event; 'birthday' = birthday event
```

### Migration 2 — `birth_event_metadata`

```sql
CREATE TABLE birth_event_metadata (
  event_id     INTEGER PRIMARY KEY,
  celebrant_id INTEGER,   -- telegram_id of the birthday person (NULL if non-TG)
  birth_year   INTEGER,   -- NULL if unknown (user hid year in TG privacy settings)
  auto_created INTEGER NOT NULL DEFAULT 0,  -- 1 = created by cron/sync, 0 = manual
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
CREATE INDEX idx_birth_meta_celebrant ON birth_event_metadata(celebrant_id)
  WHERE celebrant_id IS NOT NULL;
```

### Migration 3 — `birthday_sync_state`

Per-user MTProto sync throttle state. Kept separate because a user may have no birthday
event yet (birthday not visible), but still should not be re-fetched every day.

```sql
CREATE TABLE birthday_sync_state (
  user_id    INTEGER PRIMARY KEY,
  synced_at  TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
```

### Title storage

- Stored in `events.title`: `"Д/р Иван"` (RU) / `"Bday Ivan"` (EN) — prefix is language-aware,
  determined by the calendar owner's language at creation time and stored as-is.
- Display (dynamic, at query/render time): `"🎁 Д/р Иван — 30 лет"` / `"🎁 Bday Ivan — turns 30"`
- Emoji and age suffix are never stored — always computed.

---

## Birthday Discovery — Triggers

Three paths that call `BirthdayService.fetchAndSync(userId)`:

1. **Group activity** — `GroupMemberRepository.upsert()` adds a fire-and-forget sync call
2. **Explicit events** — sharing invite accepted, secretary access granted, onboarding completed
3. **Periodic cron** — `cron-birthday-sync` BullMQ job, daily, all bot users in batches

### Throttle

`fetchAndSync` reads `birthday_sync_state` for the user. If `synced_at < 7 days ago` → skip.
On every fetch attempt (success or null result): upsert `birthday_sync_state`.

---

## MTProto Fetching — `scripts/fetch-birthdays.py`

Batch script. Accepts user IDs via stdin, returns JSON on stdout.

```
stdin:  [12345, 67890, ...]
stdout: { "12345": { "day": 15, "month": 3, "year": 1990 }, "67890": null, ... }
```

- `null` = birthday not visible (privacy) or not set — this is expected for most users
- `year` key may be absent even when day/month present
- Uses `data/voice_caller.session` (same Pyrogram session as other scripts)

**Error contract:**
- Exit code 0 + partial results: allowed. Unresolved users are omitted from output (not set to null).
- Exit code 1 + stderr: hard failure (session expired, flood wait, API error). TS side logs and skips.
- Flood-wait: script sleeps and retries internally for up to 30s; if exceeded, exits with code 1.

---

## BirthdayService

### `fetchAndSync(userId: number): Promise<void>`

1. Read `birthday_sync_state` — if synced within 7 days → return
2. Call `fetch-birthdays.py` with `[userId]`
3. Upsert `birthday_sync_state.synced_at`
4. If result is `null` → done (no birthday visible)
5. If result has birthday:
   - Find existing `birth_event_metadata` row for this owner+celebrant
   - If none → create event + metadata + reminders
   - If exists with same date → no-op
   - If exists with different date → update event start_at + delete old reminders + rematerialize

### `upsertBirthdayEvent(params): Promise<void>`

- `start_at`: current year's occurrence (or next year's if the day has already passed this year)
- `all_day = 1`, `event_type = 'birthday'`, `recurrence_rule = 'FREQ=YEARLY'`
- `auto_created = 1` in metadata
- Creates 2 default reminders (see Reminders section)
- On date change: deletes existing `event_reminders` rows, creates new ones

### `getDisplayTitle(title: string, birthYear: number | null, eventDate: Date): string`

Called at: AI agent event queries, slash commands, calendar image render.

```ts
const prefix = "🎁 ";
const age = birthYear ? ` — ${eventDate.getFullYear() - birthYear} ${ageSuffix(lang)}` : "";
return prefix + title + age;
// RU: "🎁 Д/р Иван — 30 лет"
// EN: "🎁 Bday Ivan — turns 30"
```

---

## AI Tool — `create_birthday_event`

**Input:**
```ts
{
  celebrant_id: number,              // required
  date: { day: number, month: number }, // required
  year?: number,                     // birth year (optional)
  custom_name?: string,              // overrides auto-fetched name
  group_id?: number,                 // create in a group calendar; omit = personal
}
```

**Logic:**
1. Fetch name: `custom_name` → `users.first_name` where `telegram_id = celebrant_id` → MTProto
2. Deduplication check — scoped to the owner's **personal** calendar only:
   - Query `birth_event_metadata JOIN events` where `celebrant_id = X AND events.user_id = owner AND events.group_id IS NULL`
   - If exists with **same date** → no-op, return "already exists" confirmation
   - If exists with **different date** → return error with full existing event description + offer to update
3. If conflict only in a **group** calendar → ignore, proceed with creation
4. Build title: `"Д/р " + name` (RU) or `"Bday " + name` (EN)
5. Call `upsertBirthdayEvent`

---

## Deduplication at Display

When querying events for a user (agent, commands, image render):

- Group results by `celebrant_id`
- If same `celebrant_id` appears in both personal and group calendar → show personal, suppress group duplicate
- Implemented as a post-fetch filter before formatting

---

## Cron Job — `cron-birthday-sync`

New job type `'cron-birthday-sync'` added to `bot-tasks` BullMQ queue. Runs daily.

1. Fetch all users from DB in batches of 100
2. Filter: not in `birthday_sync_state` OR `synced_at < now - 7 days`
3. Pass batch IDs to `fetch-birthdays.py`
4. For each result: call `fetchAndSync` logic (upsert event or skip)

**Manual deletion respect:** cron skips re-creating if `auto_created = 0` is absent or if no
`birth_event_metadata` row exists for this owner+celebrant but `birthday_sync_state.synced_at`
is recent. More precisely: if a user manually deletes a birthday event, the cron will not
recreate it on the next run because `synced_at` is already set and won't re-trigger within 7 days.
After 7 days, it would recreate. To permanently suppress: user must delete + cron will recreate
every 7 days. A future opt-out mechanism can use a `suppressed` flag — out of scope for now.

---

## Default Reminders

Created automatically when a birthday event is created. Uses the calendar owner's timezone
(not the celebrant's).

| Reminder | Timing |
|----------|--------|
| Advance notice | 7 days before start |
| Day-of notice | User's `morning_agenda_time` preference (default 09:00) on the day |

The "day-of" reminder is materialized using the same `ReminderMaterializer.materializeAllDay()`
logic used for all-day events — respects user's `morning_agenda_time` setting.

**Annual rematerialization:** when the cron syncs a birthday with an unchanged date, if
the day-of reminder's `remind_at_utc` is in the past (last year's), delete it and create
a new one for the next occurrence. This ensures reminders stay current without a separate job.

Reminder text is dynamic — includes age if `birth_year` known:
- RU: `"Через 7 дней Д/р Иван — исполняется 30 лет"` / `"Д/р Иван — исполняется 30 лет"`
- EN: `"In 7 days: Bday Ivan — turns 30"` / `"Bday Ivan — turns 30 today"`

---

## `/birthdays` Command

New bot command `/birthdays` — lists all birthday events accessible to the user, grouped by calendar.

**Output format:**

```
🎂 Дни рождения

👤 Личный календарь
• 🎁 [Иван](tg://user?id=12345) — 30 лет (15 марта)
• 🎁 Мария @masha_k (22 июня)
• 🎁 Петя (7 сентября)

👥 Команда (группа)
• 🎁 [Алексей](tg://user?id=67890) — 25 лет (3 апреля)
```

Name display priority (strip "Д/р" prefix for this command only):
1. If `celebrant_id` known → `[Имя](tg://user?id=<celebrant_id>)` (Telegram inline mention)
2. Else if `username` known (from `users` table or `contacts`) → `Имя @username`
3. Else → plain name

- Shows all `event_type = 'birthday'` events the user can see (personal + all group calendars they're in)
- Deduplication applied (personal takes priority over group)
- Sorted within each section by upcoming date (next occurrence from today)
- Age appended dynamically if `birth_year` known
- If no birthdays anywhere: `"Дней рождения пока нет"` / `"No birthdays yet"`
- Works in both private and group chat contexts (in group — shows only that group's birthdays + personal)
- Must use `parse_mode: 'Markdown'` or `'HTML'` to render links

---

## AI Tool — `search_events` — Birthday Filter

Existing `search_events` tool gets an optional `event_type` parameter:

```ts
{
  query?: string,       // existing text search
  event_type?: 'birthday' | 'regular',  // new filter
}
```

When `event_type = 'birthday'`:
- Returns only birthday events
- `query` optionally filters by name within results
- Results include dynamic display title with age (🎁 prefix + age suffix)
- Useful for AI queries like "покажи все дни рождения" or "есть ли у меня день рождения Ивана"

When `event_type` is omitted — existing behaviour unchanged (returns all event types).

---

## Out of Scope

- Birthday events for non-Telegram contacts (manual AI creation covers individual cases)
- Explicit opt-out mechanism (deletion suppresses for 7 days; permanent suppression is future work)
- Birthday notifications via voice call
- Backfilling birthday events for historical group members (only active/new members synced)
