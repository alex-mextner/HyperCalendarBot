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
-- NULL = regular event, 'birthday' = birthday event
```

### Migration 2 — `birth_event_metadata`

```sql
CREATE TABLE birth_event_metadata (
  event_id     INTEGER PRIMARY KEY,
  celebrant_id INTEGER,   -- telegram_id of the birthday person (NULL if non-TG contact)
  birth_year   INTEGER,   -- NULL if unknown (user hid year in TG privacy settings)
  synced_at    TEXT,      -- last MTProto fetch timestamp (ISO 8601 UTC)
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
CREATE INDEX idx_birth_meta_celebrant ON birth_event_metadata(celebrant_id)
  WHERE celebrant_id IS NOT NULL;
```

### Title storage

- Stored in `events.title`: `"Д/р Иван"` (static prefix "Д/р " + name)
- Name source priority: custom_name arg → `users.first_name` → MTProto profile → fallback to telegram_id string
- Display (dynamic): `"🎁 Д/р Иван — 30 лет"` (emoji + age appended if `birth_year` known)

---

## Birthday Discovery — Triggers

Three paths that fire `BirthdayService.fetchAndSync(userId)`:

1. **Group activity** — `GroupMemberRepository.upsert()` triggers fire-and-forget sync
2. **Explicit events** — sharing invite accepted, secretary access granted, onboarding completed
3. **Periodic cron** — `cron-birthday-sync` BullMQ job, runs daily, processes all bot users in batches

### Throttle

`fetchAndSync` checks `synced_at`: if synced within last 7 days → skip. Prevents hammering MTProto.

---

## MTProto Fetching — `scripts/fetch-birthdays.py`

Batch script accepting user IDs via stdin, returning JSON:

```
stdin:  [12345, 67890, ...]
stdout: { "12345": { "day": 15, "month": 3, "year": 1990 }, "67890": null, ... }
```

- `null` = birthday not visible (privacy setting or not set)
- `year` may be absent even when day/month are present
- Uses `data/voice_caller.session` (same Pyrogram session as other scripts)

---

## BirthdayService

### `fetchAndSync(userId: number): Promise<void>`

1. Check `synced_at` — skip if < 7 days ago
2. Call `fetch-birthdays.py` with `[userId]`
3. If result is `null` → update `synced_at`, no event created
4. If birthday appeared or changed → upsert event + metadata

### `upsertBirthdayEvent(params): Promise<void>`

- Creates `event_type = 'birthday'` event with `RRULE:FREQ=YEARLY`, `all_day = 1`
- Inserts into `birth_event_metadata`
- Creates 2 default reminders: 7 days before + same day at 09:00 user timezone

### `getDisplayTitle(title: string, birthYear: number | null, eventDate: Date): string`

```ts
// Returns: "🎁 Д/р Иван — 30 лет" or "🎁 Д/р Иван"
const prefix = "🎁 ";
const age = birthYear ? ` — ${eventDate.getFullYear() - birthYear} лет` : "";
return prefix + title + age;
```

Called at: AI agent event queries, slash commands, calendar image render.

---

## AI Tool — `create_birthday_event`

**Input:**
```ts
{
  celebrant_id: number,       // required — Telegram user ID
  date: { day: number, month: number },  // required
  year?: number,              // optional birth year
  custom_name?: string,       // override auto-fetched name
  calendar_id?: number,       // which calendar; defaults to personal
}
```

**Logic:**
1. Fetch name: custom_name → `users.first_name` → MTProto
2. Check deduplication: query `birth_event_metadata` by `celebrant_id`
   - If exists with **same date** → no-op or confirm
   - If exists with **different date** → return error with existing date
3. Build title: `"Д/р " + name`
4. Call `upsertBirthdayEvent`

---

## Deduplication at Display

When querying events for display (agent, commands, image render):

- Group results by `celebrant_id`
- If same `celebrant_id` appears in both personal and group calendar → show personal, hide group duplicate
- Applied after event list is fetched, before formatting

---

## Cron Job — `cron-birthday-sync`

Added to `bot-tasks` BullMQ queue, runs daily.

1. Fetch all `users` from DB in batches of 100
2. Filter: `synced_at IS NULL OR synced_at < now - 7 days`
3. Pass batch to `fetch-birthdays.py`
4. For each result: call `upsertBirthdayEvent` or update `synced_at`

---

## Default Reminders

Created automatically when a birthday event is created:

| Reminder | Timing |
|----------|--------|
| Advance notice | 7 days before (`-7d`) |
| Day-of notice | 09:00 user local time on the day |

Reminder text is dynamic — includes age if `birth_year` known:
- `"Через 7 дней Д/р Иван — исполняется 30 лет"` (RU)
- `"In 7 days: Bday Ivan — turns 30"` (EN)

---

## Out of Scope

- Birthday events for non-Telegram contacts (future: manual entry covers this)
- Opt-out mechanism for users who don't want their birthday shared
- Birthday notifications via voice call
