# Birthday Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add birthday event type with automatic MTProto discovery, `/birthdays` command, AI tool for creation, and birthday filter in `search_events`.

**Architecture:** Three new DB tables (event_type column on events, birth_event_metadata, birthday_sync_state), a BirthdayService that wraps MTProto fetch + event upsert + reminder creation logic, a daily BullMQ cron job, and a new Python batch script. Display title enrichment (🎁 emoji, age suffix) happens at read time, never stored.

**Tech Stack:** TypeScript/Bun, bun:sqlite, BullMQ, Pyrogram (Python), GramIO

**Spec:** `docs/specs/2026-03-20-birthdays-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/database/migrations.ts` | Modify | Add 3 migrations: 036 event_type, 037 birth_event_metadata, 038 birthday_sync_state |
| `src/database/types.ts` | Modify | Add `event_type` to `CalendarEvent` + `CreateEventData`; add `BirthEventMetadata`, `BirthdaySyncState` types |
| `src/database/repositories/birthday-metadata.repository.ts` | Create | CRUD for birth_event_metadata + birthday_sync_state |
| `src/database/repositories/event.repository.ts` | Modify | Add `event_type` to `create()` SQL; add `getBirthdays`, `getBirthdaysForGroup`, `searchWithEventType` |
| `src/database/index.ts` | Modify | Wire up BirthdayMetadataRepository |
| `src/services/birthday/birthday-service.ts` | Create | fetchAndSync, upsertBirthdayEvent (+ reminder creation), getDisplayTitle, getBirthdaysForDisplay, dedup logic |
| `src/services/event/event-service.ts` | Modify | Add `searchWithEventType` delegate |
| `scripts/fetch-birthdays.py` | Create | Pyrogram batch birthday fetch (stdin: user_id[], stdout: JSON map) |
| `src/worker/bot-tasks-queue.ts` | Modify | Add `cron-birthday-sync` job type + `setupBirthdaySyncCron()` |
| `src/bot/handlers/message.handler.ts` | Modify | Fire-and-forget birthday sync after `groupMemberRepo.upsert` |
| `src/bot/commands/birthdays.ts` | Create | `/birthdays` command handler + `formatBirthdayLine` helper |
| `src/bot/index.ts` | Modify | Register /birthdays, wire BirthdayService into deps |
| `src/config/constants.ts` | Modify | Add `aiTools.birthdays.*` strings in `MSG.en` / `MSG.ru` |
| `src/services/ai/tools.ts` | Modify | Add `event_type` param to `search_events`; add `create_birthday_event` tool definition |
| `src/services/ai/tool-handlers/birthdays.ts` | Create | `handleCreateBirthdayEvent` |
| `src/services/ai/tool-executor.ts` | Modify | Route `create_birthday_event` to new handler |
| `src/services/ai/tool-handlers/events.ts` | Modify | `handleSearchEvents`: pass `event_type` filter through |
| `src/services/ai/types.ts` | Modify | Add `birthdayService?: BirthdayService` to `AgentContext` |
| `test/database/repositories/birthday-metadata.repository.test.ts` | Create | Repo unit tests |
| `test/services/birthday/birthday-service.test.ts` | Create | BirthdayService unit tests |
| `test/bot/commands/birthdays.test.ts` | Create | `/birthdays` command format tests |
| `test/services/ai/tool-handlers/birthdays.test.ts` | Create | AI tool handler tests |

---

## Task 1: DB Migrations + Types

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/database/migrations.test.ts — add to existing file or create
import { test, expect } from 'bun:test';
import Database from 'bun:sqlite';
import { runMigrations } from '../../src/database/migrations.ts';

test('birthday migrations create expected tables and columns', () => {
  const db = new Database(':memory:');
  runMigrations(db);

  const cols = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
  expect(cols.some(c => c.name === 'event_type')).toBe(true);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  expect(tables.some(t => t.name === 'birth_event_metadata')).toBe(true);
  expect(tables.some(t => t.name === 'birthday_sync_state')).toBe(true);

  const metaCols = db.prepare('PRAGMA table_info(birth_event_metadata)').all() as { name: string }[];
  const names = metaCols.map(c => c.name);
  expect(names).toContain('event_id');
  expect(names).toContain('celebrant_id');
  expect(names).toContain('birth_year');
  expect(names).toContain('auto_created');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test test/database/migrations.test.ts -t 'birthday migrations'
```
Expected: FAIL

- [ ] **Step 3: Append 3 migrations to `src/database/migrations.ts`** (after `035_event_mention_store`)

```ts
{
  name: '036_event_type',
  up: (db) => {
    db.exec(`ALTER TABLE events ADD COLUMN event_type TEXT`);
  },
},
{
  name: '037_birth_event_metadata',
  up: (db) => {
    db.exec(`
      CREATE TABLE birth_event_metadata (
        event_id     INTEGER PRIMARY KEY,
        celebrant_id INTEGER,
        birth_year   INTEGER,
        auto_created INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_birth_meta_celebrant ON birth_event_metadata(celebrant_id)
        WHERE celebrant_id IS NOT NULL;
    `);
  },
},
{
  name: '038_birthday_sync_state',
  up: (db) => {
    db.exec(`
      CREATE TABLE birthday_sync_state (
        user_id   INTEGER PRIMARY KEY,
        synced_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );
    `);
  },
},
```

- [ ] **Step 4: Update `src/database/types.ts`**

In `CalendarEvent`, add after `created_by`:
```ts
event_type: string | null; // null = regular, 'birthday' = birthday
```

In `CreateEventData`, add optional field:
```ts
event_type?: string;
```

Add new interfaces:
```ts
export interface BirthEventMetadata {
  event_id: number;
  celebrant_id: number | null;
  birth_year: number | null;
  auto_created: number; // 0 | 1
}

export interface BirthdaySyncState {
  user_id: number;
  synced_at: string;
}
```

- [ ] **Step 5: Run test to verify pass**

```bash
bun test test/database/migrations.test.ts -t 'birthday migrations'
```

- [ ] **Step 6: Full suite regression check**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/database/migrations.ts src/database/types.ts test/database/migrations.test.ts
git commit -m "feat(db): add birthday event_type, birth_event_metadata, birthday_sync_state"
```

---

## Task 2: Update `EventRepository.create()` + Birthday Queries

**Files:**
- Modify: `src/database/repositories/event.repository.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/database/repositories/event.repository.test.ts`:

```ts
test('create stores event_type when provided', () => {
  const event = eventRepo.create({
    user_id: 1,
    title: 'Д/р Ivan',
    start_at: '2026-05-10T00:00:00Z',
    all_day: true,
    timezone: 'UTC',
    event_type: 'birthday',
  });
  expect(event.event_type).toBe('birthday');
});

test('getBirthdays returns only birthday events for personal calendar', () => {
  eventRepo.create({ user_id: 1, title: 'Д/р Ivan', start_at: '2026-06-15T00:00:00Z', all_day: true, timezone: 'UTC', event_type: 'birthday' });
  eventRepo.create({ user_id: 1, title: 'Meeting', start_at: '2026-06-16T00:00:00Z', all_day: false, timezone: 'UTC' });
  const results = eventRepo.getBirthdays(1);
  expect(results.length).toBe(1);
  expect(results[0]!.title).toBe('Д/р Ivan');
});

test('getBirthdaysForGroup returns birthday events in group calendar', () => {
  db.prepare("INSERT INTO group_chats (chat_id, title, added_by) VALUES (100, 'Team', 1)").run();
  eventRepo.create({ user_id: 1, title: 'Д/р Bob', start_at: '2026-07-01T00:00:00Z', all_day: true, timezone: 'UTC', event_type: 'birthday', owner_type: 'group', group_id: 100 });
  const results = eventRepo.getBirthdaysForGroup(100);
  expect(results.length).toBe(1);
});

test('searchWithEventType filters by event_type=birthday', () => {
  eventRepo.create({ user_id: 1, title: 'Д/р Ivan', start_at: '2026-05-10T00:00:00Z', all_day: true, timezone: 'UTC', event_type: 'birthday' });
  eventRepo.create({ user_id: 1, title: 'Meeting', start_at: '2026-05-11T00:00:00Z', all_day: false, timezone: 'UTC' });
  const results = eventRepo.searchWithEventType(1, null, 'birthday');
  expect(results.every(e => e.event_type === 'birthday')).toBe(true);
  expect(results.length).toBe(1);
});

test('searchWithEventType with query filters by title', () => {
  eventRepo.create({ user_id: 1, title: 'Д/р Ivan', start_at: '2026-05-10T00:00:00Z', all_day: true, timezone: 'UTC', event_type: 'birthday' });
  eventRepo.create({ user_id: 1, title: 'Д/р Anna', start_at: '2026-05-11T00:00:00Z', all_day: true, timezone: 'UTC', event_type: 'birthday' });
  const results = eventRepo.searchWithEventType(1, 'ivan', null);
  expect(results.length).toBe(1);
  expect(results[0]!.title).toBe('Д/р Ivan');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test test/database/repositories/event.repository.test.ts -t 'create stores event_type|getBirthdays|getBirthdaysForGroup|searchWithEventType'
```

- [ ] **Step 3: Update `EventRepository.create()` SQL in `src/database/repositories/event.repository.ts`**

Add `event_type` to the INSERT column list and params:
```ts
// Change INSERT to include event_type:
INSERT INTO events (user_id, title, description, category, start_at, end_at, all_day,
  timezone, location, recurrence_rule, recurrence_end_at, owner_type, group_id, created_by, event_type)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
// Add at end of .run() call:
data.event_type ?? null,
```

- [ ] **Step 4: Add 3 query methods to `EventRepository`**

```ts
getBirthdays(userId: number): CalendarEvent[] {
  return this.db
    .prepare(
      `SELECT * FROM events
       WHERE user_id = ? AND event_type = 'birthday' AND is_cancelled = 0
         AND (owner_type IS NULL OR owner_type = 'user')
       ORDER BY start_at`,
    )
    .all(userId) as CalendarEvent[];
}

getBirthdaysForGroup(groupId: number): CalendarEvent[] {
  return this.db
    .prepare(
      `SELECT * FROM events
       WHERE group_id = ? AND event_type = 'birthday' AND is_cancelled = 0
         AND owner_type = 'group'
       ORDER BY start_at`,
    )
    .all(groupId) as CalendarEvent[];
}

searchWithEventType(userId: number, query: string | null, eventType: string | null): CalendarEvent[] {
  const conditions: string[] = [
    'user_id = ?',
    'is_cancelled = 0',
    "(owner_type IS NULL OR owner_type = 'user')",
  ];
  const params: (string | number | null)[] = [userId];

  if (query) {
    conditions.push('title LIKE ?');
    params.push(`%${query}%`);
  }
  if (eventType) {
    conditions.push('event_type = ?');
    params.push(eventType);
  }

  return this.db
    .prepare(`SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY start_at`)
    .all(...params) as CalendarEvent[];
}
```

- [ ] **Step 5: Run tests**

```bash
bun test test/database/repositories/event.repository.test.ts
```

- [ ] **Step 6: Run full suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/database/repositories/event.repository.ts test/database/repositories/event.repository.test.ts
git commit -m "feat(db): event_type in create(), add getBirthdays/getBirthdaysForGroup/searchWithEventType"
```

---

## Task 3: BirthdayMetadataRepository

**Files:**
- Create: `src/database/repositories/birthday-metadata.repository.ts`
- Modify: `src/database/index.ts`
- Create: `test/database/repositories/birthday-metadata.repository.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/database/repositories/birthday-metadata.repository.test.ts
import { test, expect, beforeEach } from 'bun:test';
import Database from 'bun:sqlite';
import { runMigrations } from '../../../src/database/migrations.ts';
import { BirthdayMetadataRepository } from '../../../src/database/repositories/birthday-metadata.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';

let db: Database;
let repo: BirthdayMetadataRepository;
let eventRepo: EventRepository;
let eventId: number;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repo = new BirthdayMetadataRepository(db);
  eventRepo = new EventRepository(db);
  db.prepare("INSERT INTO users (telegram_id, first_name, language, timezone) VALUES (1, 'Alice', 'en', 'UTC')").run();
  const event = eventRepo.create({ user_id: 1, title: 'Д/р Bob', start_at: '2026-05-10T00:00:00Z', all_day: true, timezone: 'UTC', event_type: 'birthday' });
  eventId = event.id;
});

test('upsertMetadata creates and reads row', () => {
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: 1990, auto_created: 1 });
  const row = repo.findByEventId(eventId);
  expect(row?.celebrant_id).toBe(42);
  expect(row?.birth_year).toBe(1990);
  expect(row?.auto_created).toBe(1);
});

test('upsertMetadata updates on conflict', () => {
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: 1990, auto_created: 1 });
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: 1991, auto_created: 0 });
  const row = repo.findByEventId(eventId);
  expect(row?.birth_year).toBe(1991);
});

test('findByCelebrantAndOwner returns matching row', () => {
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: null, auto_created: 1 });
  const result = repo.findByCelebrantAndOwner(42, 1);
  expect(result?.event_id).toBe(eventId);
});

test('findByCelebrantAndOwner returns null for wrong owner', () => {
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: null, auto_created: 1 });
  const result = repo.findByCelebrantAndOwner(42, 999);
  expect(result).toBeNull();
});

test('upsertSyncState and getSyncState round-trip', () => {
  repo.upsertSyncState(1, '2026-03-20T10:00:00Z');
  const state = repo.getSyncState(1);
  expect(state?.synced_at).toBe('2026-03-20T10:00:00Z');
});

test('getUsersNeedingSync includes users with no sync state', () => {
  const users = repo.getUsersNeedingSync(7 * 24 * 60 * 60 * 1000);
  expect(users).toContain(1);
});

test('getUsersNeedingSync excludes recently synced users', () => {
  repo.upsertSyncState(1, new Date().toISOString());
  const users = repo.getUsersNeedingSync(7 * 24 * 60 * 60 * 1000);
  expect(users).not.toContain(1);
});

test('getBirthdaysForGroup not in personal dedup set', () => {
  // celebrant 42 is in personal calendar
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: null, auto_created: 0 });
  const groupPersonalSet = new Set([42]);
  // Returns events from group, filtering out those in groupPersonalSet
  // (this test verifies the dedup query helper)
  const result = repo.findByCelebrantAndOwner(42, 1);
  expect(result).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test test/database/repositories/birthday-metadata.repository.test.ts
```

- [ ] **Step 3: Create `src/database/repositories/birthday-metadata.repository.ts`**

```ts
import type { Database } from 'bun:sqlite';
import type { BirthEventMetadata, BirthdaySyncState } from '../types.ts';

export interface UpsertMetadataParams {
  event_id: number;
  celebrant_id: number | null;
  birth_year: number | null;
  auto_created: number;
}

export class BirthdayMetadataRepository {
  constructor(private db: Database) {}

  upsertMetadata(params: UpsertMetadataParams): void {
    this.db
      .prepare(
        `INSERT INTO birth_event_metadata (event_id, celebrant_id, birth_year, auto_created)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (event_id) DO UPDATE SET
           celebrant_id = excluded.celebrant_id,
           birth_year   = excluded.birth_year,
           auto_created = excluded.auto_created`,
      )
      .run(params.event_id, params.celebrant_id ?? null, params.birth_year ?? null, params.auto_created);
  }

  findByEventId(eventId: number): BirthEventMetadata | null {
    return this.db
      .prepare('SELECT * FROM birth_event_metadata WHERE event_id = ?')
      .get(eventId) as BirthEventMetadata | null;
  }

  findByCelebrantAndOwner(
    celebrantId: number,
    ownerId: number,
  ): (BirthEventMetadata & { start_at: string; title: string }) | null {
    return this.db
      .prepare(
        `SELECT m.*, e.start_at, e.title
         FROM birth_event_metadata m
         JOIN events e ON e.id = m.event_id
         WHERE m.celebrant_id = ?
           AND e.user_id = ?
           AND (e.owner_type IS NULL OR e.owner_type = 'user')
           AND e.is_cancelled = 0`,
      )
      .get(celebrantId, ownerId) as (BirthEventMetadata & { start_at: string; title: string }) | null;
  }

  deleteByEventId(eventId: number): void {
    this.db.prepare('DELETE FROM birth_event_metadata WHERE event_id = ?').run(eventId);
  }

  upsertSyncState(userId: number, syncedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO birthday_sync_state (user_id, synced_at) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET synced_at = excluded.synced_at`,
      )
      .run(userId, syncedAt);
  }

  getSyncState(userId: number): BirthdaySyncState | null {
    return this.db
      .prepare('SELECT * FROM birthday_sync_state WHERE user_id = ?')
      .get(userId) as BirthdaySyncState | null;
  }

  getUsersNeedingSync(maxAgeMs: number): number[] {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT u.telegram_id FROM users u
         LEFT JOIN birthday_sync_state s ON s.user_id = u.telegram_id
         WHERE s.synced_at IS NULL OR s.synced_at < ?`,
      )
      .all(cutoff) as { telegram_id: number }[];
    return rows.map((r) => r.telegram_id);
  }
}
```

- [ ] **Step 4: Wire into `src/database/index.ts`**

```ts
import { BirthdayMetadataRepository } from './repositories/birthday-metadata.repository.ts';
// In the repos object / return value:
birthdayMeta: new BirthdayMetadataRepository(db),
```

- [ ] **Step 5: Run tests**

```bash
bun test test/database/repositories/birthday-metadata.repository.test.ts
```

- [ ] **Step 6: Full suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/database/repositories/birthday-metadata.repository.ts src/database/index.ts \
  test/database/repositories/birthday-metadata.repository.test.ts
git commit -m "feat(db): BirthdayMetadataRepository with sync state"
```

---

## Task 4: `scripts/fetch-birthdays.py`

**Files:**
- Create: `scripts/fetch-birthdays.py`

- [ ] **Step 1: Create the script**

```python
"""
Batch-fetch birthday info for Telegram user IDs via Pyrogram.
stdin:  JSON array of integer user IDs
stdout: JSON object { "<user_id>": {"day": N, "month": N, "year": N} | null, ... }
        null  = birthday not visible or not set
        year key absent if user hid birth year
Exit 0: success (partial results ok — unresolvable users omitted, not set to null)
Exit 1: hard failure (session error, flood wait exceeded limit)
"""
import sys
import os
import json
import asyncio

API_ID = int(os.environ.get("MTPROTO_API_ID", 0))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")
FLOOD_WAIT_MAX = 30


async def fetch(user_ids: list[int]) -> dict:
    from pyrogram import Client
    from pyrogram.errors import FloodWait

    results = {}
    app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
    await app.start()
    try:
        for uid in user_ids:
            for attempt in range(2):
                try:
                    user = await app.get_users(uid)
                    bd = getattr(user, 'birthday', None)
                    if bd is None:
                        results[str(uid)] = None
                    else:
                        entry: dict = {"day": bd.day, "month": bd.month}
                        if getattr(bd, 'year', None):
                            entry["year"] = bd.year
                        results[str(uid)] = entry
                    break
                except FloodWait as e:
                    if e.value > FLOOD_WAIT_MAX:
                        print(f"FloodWait {e.value}s exceeds limit", file=sys.stderr)
                        sys.exit(1)
                    await asyncio.sleep(e.value)
                except Exception:
                    break  # omit unresolvable users
    finally:
        await app.stop()
    return results


def main():
    raw = sys.stdin.read().strip()
    try:
        user_ids = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    results = asyncio.run(fetch(user_ids))
    print(json.dumps(results))


main()
```

- [ ] **Step 2: Verify syntax**

```bash
venv/bin/python -c "import ast; ast.parse(open('scripts/fetch-birthdays.py').read()); print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/fetch-birthdays.py
git commit -m "feat(scripts): fetch-birthdays.py — batch Pyrogram birthday fetch"
```

---

## Task 5: BirthdayService

**Files:**
- Create: `src/services/birthday/birthday-service.ts`
- Create: `test/services/birthday/birthday-service.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/birthday/birthday-service.test.ts
import { test, expect, beforeEach } from 'bun:test';
import Database from 'bun:sqlite';
import { runMigrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { BirthdayMetadataRepository } from '../../../src/database/repositories/birthday-metadata.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { BirthdayService } from '../../../src/services/birthday/birthday-service.ts';

let db: Database;
let service: BirthdayService;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO users (telegram_id, first_name, language, timezone) VALUES (1, 'Alice', 'ru', 'UTC')").run();
  db.prepare("INSERT INTO users (telegram_id, first_name, username, language, timezone) VALUES (42, 'Ivan', 'ivan_t', 'ru', 'UTC')").run();

  service = new BirthdayService(
    new EventRepository(db),
    new BirthdayMetadataRepository(db),
    new EventReminderRepository(db),
    new NotificationPreferencesRepository(db),
  );
});

test('getDisplayTitle RU with birth_year uses ruPlural for age', () => {
  expect(service.getDisplayTitle('Д/р Иван', 1996, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван — 30 лет');
  expect(service.getDisplayTitle('Д/р Иван', 1995, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван — 31 год');
  expect(service.getDisplayTitle('Д/р Иван', 2004, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван — 22 года');
});

test('getDisplayTitle EN with birth_year', () => {
  expect(service.getDisplayTitle('Bday Ivan', 1996, new Date('2026-05-10'), 'en')).toBe('🎁 Bday Ivan — turns 30');
});

test('getDisplayTitle without birth_year omits age', () => {
  expect(service.getDisplayTitle('Д/р Иван', null, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван');
});

test('upsertBirthdayEvent creates event with correct fields and 2 reminders', () => {
  service.upsertBirthdayEvent({
    ownerId: 1, celebrantId: 42, celebrantName: 'Иван',
    day: 10, month: 5, year: 1996, lang: 'ru', timezone: 'UTC', autoCreated: true,
  });

  const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all() as { title: string; recurrence_rule: string; all_day: number }[];
  expect(events.length).toBe(1);
  expect(events[0]!.title).toBe('Д/р Иван');
  expect(events[0]!.recurrence_rule).toBe('FREQ=YEARLY');
  expect(events[0]!.all_day).toBe(1);

  const reminders = db.prepare('SELECT * FROM event_reminders').all();
  expect(reminders.length).toBeGreaterThanOrEqual(1); // at least day-of (7-days may be past)
});

test('shouldSkipSync returns true when recently synced', () => {
  const metaRepo = new BirthdayMetadataRepository(db);
  metaRepo.upsertSyncState(1, new Date().toISOString());
  expect(service.shouldSkipSync(1)).toBe(true);
});

test('shouldSkipSync returns false when never synced', () => {
  expect(service.shouldSkipSync(1)).toBe(false);
});

test('findExistingBirthday returns existing personal calendar entry', () => {
  service.upsertBirthdayEvent({ ownerId: 1, celebrantId: 42, celebrantName: 'Иван', day: 10, month: 5, year: null, lang: 'ru', timezone: 'UTC', autoCreated: false });
  const result = service.findExistingBirthday(42, 1);
  expect(result).not.toBeNull();
  expect(result!.celebrant_id).toBe(42);
});

test('getBirthdaysForDisplay returns personal entries sorted by next occurrence', () => {
  service.upsertBirthdayEvent({ ownerId: 1, celebrantId: 42, celebrantName: 'Иван', day: 10, month: 5, year: null, lang: 'ru', timezone: 'UTC', autoCreated: false });
  const { personal } = service.getBirthdaysForDisplay(1, 'ru', []);
  expect(personal.length).toBe(1);
  expect(personal[0]!.event.title).toBe('Д/р Иван');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test test/services/birthday/birthday-service.test.ts
```

- [ ] **Step 3: Create `src/services/birthday/birthday-service.ts`**

```ts
import { TZDate } from '@date-fns/tz';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { BirthdayMetadataRepository } from '../../database/repositories/birthday-metadata.repository.ts';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';
import type { BirthEventMetadata, CalendarEvent } from '../../database/types.ts';
import { ruPlural } from '../event/formatters.ts';
import { logger } from '../../utils/logger.ts';

const birthdayLogger = logger.child({ module: 'birthday-service' });

const SYNC_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ALL_DAY_TIME = '09:00';

function allDayReminderUtc(dateStr: string, localTime: string, timezone: string): Date {
  const [h, m] = localTime.split(':').map(Number);
  const local = new TZDate(new Date(dateStr), timezone);
  local.setHours(h!, m!, 0, 0);
  return new Date(local.getTime());
}

export interface UpsertBirthdayParams {
  ownerId: number;
  celebrantId: number | null;
  celebrantName: string;
  day: number;
  month: number;
  year: number | null;
  lang: 'en' | 'ru';
  timezone: string;
  autoCreated: boolean;
  groupId?: number;
}

export interface BirthdayDisplayItem {
  event: CalendarEvent;
  celebrantId: number | null;
  birthYear: number | null;
  username: string | null;
}

export interface BirthdaysForDisplay {
  personal: BirthdayDisplayItem[];
  groups: { groupId: number; title: string; items: BirthdayDisplayItem[] }[];
}

export class BirthdayService {
  constructor(
    private eventRepo: EventRepository,
    private metaRepo: BirthdayMetadataRepository,
    private reminderRepo: EventReminderRepository,
    private prefsRepo: NotificationPreferencesRepository,
    private fetchScriptPath = 'scripts/fetch-birthdays.py',
  ) {}

  getDisplayTitle(title: string, birthYear: number | null, eventDate: Date, lang: 'en' | 'ru'): string {
    const prefix = '🎁 ';
    if (!birthYear) return prefix + title;
    const age = eventDate.getFullYear() - birthYear;
    const suffix =
      lang === 'ru'
        ? ` — ${age} ${ruPlural(age, 'год', 'года', 'лет')}`
        : ` — turns ${age}`;
    return prefix + title + suffix;
  }

  shouldSkipSync(userId: number): boolean {
    const state = this.metaRepo.getSyncState(userId);
    if (!state) return false;
    return Date.now() - new Date(state.synced_at).getTime() < SYNC_THROTTLE_MS;
  }

  findExistingBirthday(celebrantId: number, ownerId: number): (BirthEventMetadata & { start_at: string; title: string }) | null {
    return this.metaRepo.findByCelebrantAndOwner(celebrantId, ownerId);
  }

  upsertBirthdayEvent(params: UpsertBirthdayParams): void {
    const titlePrefix = params.lang === 'ru' ? 'Д/р ' : 'Bday ';
    const title = titlePrefix + params.celebrantName;

    const now = new Date();
    let year = now.getFullYear();
    const thisYearDate = new Date(year, params.month - 1, params.day);
    if (thisYearDate < now) year += 1;

    const startDateStr = `${year}-${String(params.month).padStart(2, '0')}-${String(params.day).padStart(2, '0')}`;
    const startAt = `${startDateStr}T00:00:00Z`;

    const existing = params.celebrantId
      ? this.metaRepo.findByCelebrantAndOwner(params.celebrantId, params.ownerId)
      : null;

    let eventId: number;
    if (existing) {
      const existingMonth = new Date(existing.start_at).getUTCMonth() + 1;
      const existingDay = new Date(existing.start_at).getUTCDate();
      if (existingMonth !== params.month || existingDay !== params.day) {
        this.eventRepo.update(existing.event_id, params.ownerId, { start_at: startAt });
        this.reminderRepo.deleteForEvent(existing.event_id);
        birthdayLogger.info({ eventId: existing.event_id }, 'Birthday date updated');
      }
      eventId = existing.event_id;
    } else {
      const event = this.eventRepo.create({
        user_id: params.ownerId,
        title,
        start_at: startAt,
        all_day: true,
        timezone: params.timezone,
        recurrence_rule: 'FREQ=YEARLY',
        event_type: 'birthday',
        owner_type: params.groupId ? 'group' : 'user',
        group_id: params.groupId ?? null,
      });
      eventId = event.id;
    }

    this.metaRepo.upsertMetadata({
      event_id: eventId,
      celebrant_id: params.celebrantId ?? null,
      birth_year: params.year ?? null,
      auto_created: params.autoCreated ? 1 : 0,
    });

    this.createBirthdayReminders(eventId, params.ownerId, startDateStr, params.timezone);
  }

  private createBirthdayReminders(eventId: number, userId: number, startDateStr: string, timezone: string): void {
    const prefs = this.prefsRepo.get(userId);
    const localTime = prefs?.morning_agenda_time ?? DEFAULT_ALL_DAY_TIME;
    const now = Date.now();

    // 7 days before
    const [y, mo, d] = startDateStr.split('-').map(Number);
    const sevenBefore = new Date(Date.UTC(y!, mo! - 1, d! - 7)).toISOString().substring(0, 10);
    const sevenBeforeUtc = allDayReminderUtc(`${sevenBefore}T00:00:00Z`, localTime, timezone);
    if (sevenBeforeUtc.getTime() > now) {
      this.reminderRepo.insert({
        event_id: eventId,
        user_id: userId,
        remind_at_utc: sevenBeforeUtc.toISOString(),
        interval_minutes: 7 * 24 * 60,
        interval_label: '7 days before',
      });
    }

    // Day of
    const dayOfUtc = allDayReminderUtc(`${startDateStr}T00:00:00Z`, localTime, timezone);
    if (dayOfUtc.getTime() > now) {
      this.reminderRepo.insert({
        event_id: eventId,
        user_id: userId,
        remind_at_utc: dayOfUtc.toISOString(),
        interval_minutes: 0,
        interval_label: 'day of',
      });
    }
  }

  async fetchAndSyncUser(
    userId: number,
    firstName: string,
    ownerId: number,
    lang: 'en' | 'ru',
    timezone: string,
  ): Promise<void> {
    if (this.shouldSkipSync(userId)) return;

    let result: Record<string, { day: number; month: number; year?: number } | null>;
    try {
      const proc = Bun.spawn(['venv/bin/python', this.fetchScriptPath], {
        stdin: JSON.stringify([userId]),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      this.metaRepo.upsertSyncState(userId, new Date().toISOString());

      if (exitCode !== 0) {
        const err = await new Response(proc.stderr).text();
        birthdayLogger.warn({ userId, err }, 'fetch-birthdays.py failed');
        return;
      }
      const stdout = await new Response(proc.stdout).text();
      result = JSON.parse(stdout);
    } catch (err) {
      birthdayLogger.error({ userId, err }, 'Failed to spawn fetch-birthdays.py');
      return;
    }

    const birthday = result[String(userId)];
    if (!birthday) return;

    this.upsertBirthdayEvent({
      ownerId,
      celebrantId: userId,
      celebrantName: firstName,
      day: birthday.day,
      month: birthday.month,
      year: birthday.year ?? null,
      lang,
      timezone,
      autoCreated: true,
    });
  }

  async runBatchSync(
    users: { telegram_id: number; first_name: string | null; language: string; timezone: string }[],
  ): Promise<void> {
    const ids = users.map((u) => u.telegram_id);
    if (ids.length === 0) return;

    let result: Record<string, { day: number; month: number; year?: number } | null>;
    try {
      const proc = Bun.spawn(['venv/bin/python', this.fetchScriptPath], {
        stdin: JSON.stringify(ids),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const now = new Date().toISOString();
      for (const u of users) this.metaRepo.upsertSyncState(u.telegram_id, now);

      if (exitCode !== 0) {
        const err = await new Response(proc.stderr).text();
        birthdayLogger.warn({ err }, 'Batch fetch-birthdays.py failed');
        return;
      }
      const stdout = await new Response(proc.stdout).text();
      result = JSON.parse(stdout);
    } catch (err) {
      birthdayLogger.error({ err }, 'Failed to spawn batch fetch-birthdays.py');
      return;
    }

    for (const user of users) {
      const birthday = result[String(user.telegram_id)];
      if (!birthday) continue;
      this.upsertBirthdayEvent({
        ownerId: user.telegram_id,
        celebrantId: user.telegram_id,
        celebrantName: user.first_name ?? String(user.telegram_id),
        day: birthday.day,
        month: birthday.month,
        year: birthday.year ?? null,
        lang: (user.language as 'en' | 'ru') ?? 'en',
        timezone: user.timezone,
        autoCreated: true,
      });
    }
  }

  getBirthdaysForDisplay(
    userId: number,
    lang: 'en' | 'ru',
    groupCalendars: { groupId: number; title: string }[],
  ): BirthdaysForDisplay {
    const personalEvents = this.eventRepo.getBirthdays(userId);
    const personalCelebrantIds = new Set<number>();

    const personal: BirthdayDisplayItem[] = personalEvents.map((e) => {
      const meta = this.metaRepo.findByEventId(e.id);
      if (meta?.celebrant_id != null) personalCelebrantIds.add(meta.celebrant_id);
      return { event: e, celebrantId: meta?.celebrant_id ?? null, birthYear: meta?.birth_year ?? null, username: null };
    });

    const groups = groupCalendars.map(({ groupId, title }) => {
      const groupEvents = this.eventRepo.getBirthdaysForGroup(groupId);
      const items: BirthdayDisplayItem[] = groupEvents
        .filter((e) => {
          const meta = this.metaRepo.findByEventId(e.id);
          return meta?.celebrant_id == null || !personalCelebrantIds.has(meta.celebrant_id);
        })
        .map((e) => {
          const meta = this.metaRepo.findByEventId(e.id);
          return { event: e, celebrantId: meta?.celebrant_id ?? null, birthYear: meta?.birth_year ?? null, username: null };
        });
      return { groupId, title, items };
    });

    const sortByNext = (a: BirthdayDisplayItem, b: BirthdayDisplayItem) =>
      nextOccurrenceTs(a.event.start_at) - nextOccurrenceTs(b.event.start_at);

    personal.sort(sortByNext);
    for (const g of groups) g.items.sort(sortByNext);

    return { personal, groups };
  }
}

function nextOccurrenceTs(startAt: string): number {
  const d = new Date(startAt);
  const now = new Date();
  const thisYear = new Date(now.getFullYear(), d.getUTCMonth(), d.getUTCDate());
  return thisYear >= now
    ? thisYear.getTime()
    : new Date(now.getFullYear() + 1, d.getUTCMonth(), d.getUTCDate()).getTime();
}
```

- [ ] **Step 4: Add `searchWithEventType` to `EventService` in `src/services/event/event-service.ts`**

```ts
searchWithEventType(userId: number, query: string | null, eventType: string | null): CalendarEvent[] {
  return this.eventRepo.searchWithEventType(userId, query, eventType);
}
```

- [ ] **Step 5: Run tests**

```bash
bun test test/services/birthday/birthday-service.test.ts
```

- [ ] **Step 6: Full suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/services/birthday/birthday-service.ts src/services/event/event-service.ts \
  test/services/birthday/birthday-service.test.ts
git commit -m "feat(birthday): BirthdayService — display, upsert, reminders, dedup, batch sync"
```

---

## Task 6: Cron Job + Message Handler Hook

**Files:**
- Modify: `src/worker/bot-tasks-queue.ts`
- Modify: `src/bot/handlers/message.handler.ts`
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Write failing tests for cron setup**

```ts
// test/worker/bot-tasks-queue.test.ts — add to existing or create
import { test, expect } from 'bun:test';

test('BotTaskJobType includes cron-birthday-sync', async () => {
  const { setupBirthdaySyncCron } = await import('../../src/worker/bot-tasks-queue.ts');
  expect(typeof setupBirthdaySyncCron).toBe('function');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test test/worker/bot-tasks-queue.test.ts -t 'cron-birthday-sync'
```

- [ ] **Step 3: Update `src/worker/bot-tasks-queue.ts`**

In `BotTaskJobType` union, add `'cron-birthday-sync'`.

In `BotTasksQueueDeps`, add:
```ts
onBirthdaySync?: () => Promise<void>;
```

In the worker handler, add:
```ts
if (job.data.type === 'cron-birthday-sync') {
  if (deps.onBirthdaySync) await deps.onBirthdaySync();
  return;
}
```

Add exported function:
```ts
export async function setupBirthdaySyncCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'birthday-sync-tick',
    { type: 'cron-birthday-sync' },
    { repeat: { every: 24 * 60 * 60_000 }, removeOnComplete: true, jobId: 'birthday-sync-tick' },
  );
  botTasksLogger.info('Birthday sync cron scheduled (daily)');
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun test test/worker/bot-tasks-queue.test.ts -t 'cron-birthday-sync'
```

- [ ] **Step 5: Update `src/bot/handlers/message.handler.ts`**

Add `BirthdayService` to deps type:
```ts
import type { BirthdayService } from '../../services/birthday/birthday-service.ts';
// In deps interface:
birthdayService?: BirthdayService;
```

After the `groupMemberRepo.upsert(...)` call (around line 822), add:
```ts
if (deps.birthdayService) {
  deps.birthdayService
    .fetchAndSyncUser(user.telegram_id, user.first_name ?? '', user.telegram_id, user.language as 'en' | 'ru', user.timezone)
    .catch((err) => logger.error({ err, userId: user.telegram_id }, 'Birthday sync failed'));
}
```

- [ ] **Step 6: Wire everything in `src/bot/index.ts`**

```ts
import { BirthdayService } from '../services/birthday/birthday-service.ts';
import { setupBirthdaySyncCron } from '../worker/bot-tasks-queue.ts';

// After db init:
const birthdayService = new BirthdayService(db.events, db.birthdayMeta, db.eventReminders, db.notificationPrefs);

// In botTasksQueue deps, add:
onBirthdaySync: async () => {
  const allUsers = db.users.findAll(); // add findAll() to UserRepository if missing
  // process in batches of 100
  const BATCH = 100;
  const needing = db.birthdayMeta.getUsersNeedingSync(7 * 24 * 60 * 60 * 1000);
  const batch = allUsers.filter(u => needing.includes(u.telegram_id));
  for (let i = 0; i < batch.length; i += BATCH) {
    await birthdayService.runBatchSync(batch.slice(i, i + BATCH));
  }
},

// Pass birthdayService to message handler deps:
// birthdayService,
```

> **Note:** If `UserRepository` has no `findAll()` method, add it:
> ```ts
> findAll(): User[] {
>   return this.db.prepare('SELECT * FROM users').all() as User[];
> }
> ```

- [ ] **Step 7: Run full suite**

```bash
bun test
```

- [ ] **Step 8: Commit**

```bash
git add src/worker/bot-tasks-queue.ts src/bot/handlers/message.handler.ts src/bot/index.ts \
  src/database/repositories/user.repository.ts test/worker/bot-tasks-queue.test.ts
git commit -m "feat(birthday): cron job + group message hook for birthday discovery"
```

---

## Task 7: `/birthdays` Command

**Files:**
- Create: `src/bot/commands/birthdays.ts`
- Modify: `src/bot/index.ts`
- Create: `test/bot/commands/birthdays.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/bot/commands/birthdays.test.ts
import { test, expect } from 'bun:test';
import { formatBirthdayLine } from '../../../src/bot/commands/birthdays.ts';

test('RU: uses tg link when celebrant_id known, strips Д/р prefix', () => {
  const line = formatBirthdayLine({ title: 'Д/р Иван', celebrantId: 12345, birthYear: 1996, username: null, eventDate: new Date('2026-05-10T00:00:00Z'), lang: 'ru' });
  expect(line).toContain('[Иван](tg://user?id=12345)');
  expect(line).toContain('30 лет');
  expect(line).not.toContain('Д/р');
  expect(line).toContain('🎁');
});

test('RU: age 31 uses correct plural "год"', () => {
  const line = formatBirthdayLine({ title: 'Д/р Иван', celebrantId: 12345, birthYear: 1995, username: null, eventDate: new Date('2026-05-10T00:00:00Z'), lang: 'ru' });
  expect(line).toContain('31 год');
});

test('RU: age 22 uses correct plural "года"', () => {
  const line = formatBirthdayLine({ title: 'Д/р Иван', celebrantId: 12345, birthYear: 2004, username: null, eventDate: new Date('2026-05-10T00:00:00Z'), lang: 'ru' });
  expect(line).toContain('22 года');
});

test('RU: uses @username when no celebrant_id', () => {
  const line = formatBirthdayLine({ title: 'Д/р Маша', celebrantId: null, birthYear: null, username: 'masha_k', eventDate: new Date('2026-06-22T00:00:00Z'), lang: 'ru' });
  expect(line).toContain('@masha_k');
  expect(line).toContain('Маша');
  expect(line).not.toContain('Д/р');
});

test('EN: strips Bday prefix, uses tg link', () => {
  const line = formatBirthdayLine({ title: 'Bday Ivan', celebrantId: 42, birthYear: 2001, username: null, eventDate: new Date('2026-05-10T00:00:00Z'), lang: 'en' });
  expect(line).toContain('[Ivan](tg://user?id=42)');
  expect(line).toContain('turns 25');
  expect(line).not.toContain('Bday');
});

test('plain name when no id or username', () => {
  const line = formatBirthdayLine({ title: 'Bday Pete', celebrantId: null, birthYear: null, username: null, eventDate: new Date('2026-09-07T00:00:00Z'), lang: 'en' });
  expect(line).toContain('Pete');
  expect(line).not.toContain('Bday');
  expect(line).toContain('🎁');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test test/bot/commands/birthdays.test.ts
```

- [ ] **Step 3: Create `src/bot/commands/birthdays.ts`**

```ts
import { ruPlural } from '../../services/event/formatters.ts';
import type { BirthdayService } from '../../services/birthday/birthday-service.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { User } from '../../database/types.ts';
import type { BotCommandContext } from '../types.ts';
import { getGroupId, isGroup } from '../group-context.ts';

export interface FormatBirthdayLineParams {
  title: string;
  celebrantId: number | null;
  birthYear: number | null;
  username: string | null;
  eventDate: Date;
  lang: 'en' | 'ru';
}

function extractName(title: string): string {
  return title.replace(/^(Д\/р |Bday )/, '').trim();
}

function formatDate(date: Date, lang: 'en' | 'ru'): string {
  return date.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short' });
}

export function formatBirthdayLine(params: FormatBirthdayLineParams): string {
  const { title, celebrantId, birthYear, username, eventDate, lang } = params;
  const name = extractName(title);
  const age = birthYear ? eventDate.getFullYear() - birthYear : null;
  const ageSuffix = age
    ? lang === 'ru'
      ? ` — ${age} ${ruPlural(age, 'год', 'года', 'лет')}`
      : ` — turns ${age}`
    : '';
  const dateStr = formatDate(eventDate, lang);

  let nameStr: string;
  if (celebrantId) {
    nameStr = `[${name}](tg://user?id=${celebrantId})`;
  } else if (username) {
    nameStr = `${name} @${username}`;
  } else {
    nameStr = name;
  }

  return `🎁 ${nameStr}${ageSuffix} (${dateStr})`;
}

export async function handleBirthdays(
  ctx: BotCommandContext,
  birthdayService: BirthdayService,
  groupChatRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  let groupCalendars: { groupId: number; title: string }[] = [];
  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx);
    if (groupId === null) return;
    const group = groupChatRepo?.findByChatId(groupId);
    groupCalendars = group ? [{ groupId, title: group.title ?? String(groupId) }] : [];
  }

  const { personal, groups } = birthdayService.getBirthdaysForDisplay(user.telegram_id, lang, groupCalendars);

  if (personal.length === 0 && groups.every((g) => g.items.length === 0)) {
    await ctx.send(lang === 'ru' ? 'Дней рождения пока нет 🎂' : 'No birthdays yet 🎂');
    return;
  }

  const lines: string[] = [lang === 'ru' ? '🎂 *Дни рождения*' : '🎂 *Birthdays*', ''];

  if (personal.length > 0) {
    lines.push(lang === 'ru' ? '👤 *Личный календарь*' : '👤 *Personal calendar*');
    for (const item of personal) {
      const eventDate = new Date(item.event.start_at);
      lines.push('• ' + formatBirthdayLine({ title: item.event.title, celebrantId: item.celebrantId, birthYear: item.birthYear, username: item.username, eventDate, lang }));
    }
  }

  for (const group of groups) {
    if (group.items.length === 0) continue;
    lines.push('');
    lines.push(`👥 *${group.title}*`);
    for (const item of group.items) {
      const eventDate = new Date(item.event.start_at);
      lines.push('• ' + formatBirthdayLine({ title: item.event.title, celebrantId: item.celebrantId, birthYear: item.birthYear, username: item.username, eventDate, lang }));
    }
  }

  await ctx.send(lines.join('\n'), { parse_mode: 'Markdown' });
}
```

- [ ] **Step 4: Register in `src/bot/index.ts`**

```ts
import { handleBirthdays } from './commands/birthdays.ts';
// In command chain:
.command('birthdays', (ctx) =>
  handleBirthdays(ctx as unknown as BotCommandContext, birthdayService, db.groupChats)
)
```

- [ ] **Step 5: Run tests**

```bash
bun test test/bot/commands/birthdays.test.ts
```

- [ ] **Step 6: Full suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/birthdays.ts src/bot/index.ts test/bot/commands/birthdays.test.ts
git commit -m "feat(bot): /birthdays command with grouped display, tg links, ruPlural age"
```

---

## Task 8: AI Tools + Constants

**Files:**
- Modify: `src/config/constants.ts`
- Modify: `src/services/ai/tools.ts`
- Create: `src/services/ai/tool-handlers/birthdays.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/tool-handlers/events.ts`
- Modify: `src/services/ai/types.ts`
- Create: `test/services/ai/tool-handlers/birthdays.test.ts`

- [ ] **Step 1: Add strings to `src/config/constants.ts`**

In `MSG.ru.aiTools`, add:
```ts
birthdays: {
  created: (name: string, day: number, month: number) =>
    `День рождения создан: Д/р ${name} (${day}.${String(month).padStart(2, '0')})`,
  alreadyExists: (name: string, day: number, month: number) =>
    `День рождения ${name} уже есть: ${day}.${String(month).padStart(2, '0')}`,
  conflictError: (name: string, day: number, month: number) =>
    `Уже есть день рождения для ${name}: дата ${day}.${String(month).padStart(2, '0')}. Хочешь обновить?`,
},
```

In `MSG.en.aiTools`, add:
```ts
birthdays: {
  created: (name: string, day: number, month: number) =>
    `Birthday created: Bday ${name} (${day}.${String(month).padStart(2, '0')})`,
  alreadyExists: (name: string, day: number, month: number) =>
    `Birthday for ${name} already exists: ${day}.${String(month).padStart(2, '0')}`,
  conflictError: (name: string, day: number, month: number) =>
    `Birthday for ${name} already exists on ${day}.${String(month).padStart(2, '0')}. To update, call again with the correct date.`,
},
```

- [ ] **Step 2: Write failing tests**

```ts
// test/services/ai/tool-handlers/birthdays.test.ts
import { test, expect, beforeEach } from 'bun:test';
import Database from 'bun:sqlite';
import { runMigrations } from '../../../../src/database/migrations.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { BirthdayMetadataRepository } from '../../../../src/database/repositories/birthday-metadata.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationPreferencesRepository } from '../../../../src/database/repositories/notification-preferences.repository.ts';
import { BirthdayService } from '../../../../src/services/birthday/birthday-service.ts';
import { handleCreateBirthdayEvent } from '../../../../src/services/ai/tool-handlers/birthdays.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

let db: Database;
let birthdayService: BirthdayService;
let ctx: Partial<AgentContext>;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO users (telegram_id, first_name, language, timezone) VALUES (1, 'Alice', 'ru', 'UTC')").run();
  db.prepare("INSERT INTO users (telegram_id, first_name, username, language, timezone) VALUES (42, 'Ivan', 'ivan_t', 'ru', 'UTC')").run();

  birthdayService = new BirthdayService(
    new EventRepository(db),
    new BirthdayMetadataRepository(db),
    new EventReminderRepository(db),
    new NotificationPreferencesRepository(db),
  );

  ctx = {
    user: { telegram_id: 1, language: 'ru', timezone: 'UTC', first_name: 'Alice' } as any,
    birthdayService,
    userRepo: { findByTelegramId: (id: number) => db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(id) } as any,
  };
});

test('creates birthday event successfully', () => {
  const result = handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 10, month: 5 }, year: 1996 });
  expect(result.success).toBe(true);
  expect(result.output).toContain('Ivan');
  const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all();
  expect(events.length).toBe(1);
});

test('returns error when date conflicts in personal calendar', () => {
  handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 10, month: 5 } });
  const result = handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 11, month: 5 } });
  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
});

test('no-ops and reports existing when same date', () => {
  handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 10, month: 5 } });
  const result = handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 10, month: 5 } });
  expect(result.success).toBe(true);
  const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all();
  expect(events.length).toBe(1); // no duplicate
});

test('uses custom_name when provided', () => {
  const result = handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 10, month: 5 }, custom_name: 'Ваня' });
  expect(result.success).toBe(true);
  const event = db.prepare("SELECT title FROM events WHERE event_type = 'birthday'").get() as { title: string };
  expect(event.title).toBe('Д/р Ваня');
});
```

- [ ] **Step 3: Run to verify failure**

```bash
bun test test/services/ai/tool-handlers/birthdays.test.ts
```

- [ ] **Step 4: Create `src/services/ai/tool-handlers/birthdays.ts`**

```ts
import type { AgentContext, ToolResult } from '../types.ts';
import { t } from '../../../config/constants.ts';

interface CreateBirthdayInput {
  celebrant_id: number;
  date: { day: number; month: number };
  year?: number;
  custom_name?: string;
  group_id?: number;
}

export function handleCreateBirthdayEvent(ctx: AgentContext, input: CreateBirthdayInput): ToolResult {
  if (!ctx.birthdayService) return { success: false, error: 'Birthday service unavailable' };

  const lang = ctx.user.language as 'en' | 'ru';

  // Resolve name
  let celebrantName = input.custom_name;
  if (!celebrantName) {
    const dbUser = ctx.userRepo?.findByTelegramId(input.celebrant_id);
    celebrantName = dbUser?.first_name ?? String(input.celebrant_id);
  }

  // Dedup check — personal calendar only
  if (!input.group_id) {
    const existing = ctx.birthdayService.findExistingBirthday(input.celebrant_id, ctx.user.telegram_id);
    if (existing) {
      const existingDate = new Date(existing.start_at);
      const existingDay = existingDate.getUTCDate();
      const existingMonth = existingDate.getUTCMonth() + 1;

      if (existingDay === input.date.day && existingMonth === input.date.month) {
        return {
          success: true,
          output: t(lang).aiTools.birthdays.alreadyExists(celebrantName, existingDay, existingMonth),
        };
      }

      return {
        success: false,
        error: t(lang).aiTools.birthdays.conflictError(celebrantName, existingDay, existingMonth),
      };
    }
  }

  ctx.birthdayService.upsertBirthdayEvent({
    ownerId: ctx.user.telegram_id,
    celebrantId: input.celebrant_id,
    celebrantName,
    day: input.date.day,
    month: input.date.month,
    year: input.year ?? null,
    lang,
    timezone: ctx.user.timezone,
    autoCreated: false,
    groupId: input.group_id,
  });

  return {
    success: true,
    output: t(lang).aiTools.birthdays.created(celebrantName, input.date.day, input.date.month),
  };
}
```

- [ ] **Step 5: Add `birthdayService` to `AgentContext` in `src/services/ai/types.ts`**

```ts
import type { BirthdayService } from '../birthday/birthday-service.ts';
// In AgentContext interface:
birthdayService?: BirthdayService;
```

Wire in `src/bot/index.ts` when building agent context.

- [ ] **Step 6: Add tool definitions to `src/services/ai/tools.ts`**

After `search_events`, add `create_birthday_event`:

```ts
{
  name: 'create_birthday_event',
  description: 'Create a birthday event for a Telegram user. Auto-fetches their name from the database.',
  input_schema: {
    type: 'object' as const,
    properties: {
      celebrant_id: { type: 'number', description: 'Telegram user ID of the birthday person' },
      date: {
        type: 'object' as const,
        properties: {
          day: { type: 'number', description: 'Day of month' },
          month: { type: 'number', description: 'Month number (1-12)' },
        },
        required: ['day', 'month'],
      },
      year: { type: 'number', description: 'Birth year (optional)' },
      custom_name: { type: 'string', description: 'Override auto-fetched name' },
      group_id: { type: 'number', description: 'Group calendar ID. Omit for personal calendar.' },
    },
    required: ['celebrant_id', 'date'],
  },
},
```

In `search_events`, add optional `event_type` property and make `query` optional:

```ts
// In search_events.input_schema.properties add:
event_type: {
  type: 'string',
  enum: ['birthday', 'regular'],
  description: "Filter by event type. Use 'birthday' to list all birthday events.",
},
// Change required from ['query'] to []:
required: [],
```

- [ ] **Step 7: Route `create_birthday_event` in `src/services/ai/tool-executor.ts`**

```ts
import { handleCreateBirthdayEvent } from './tool-handlers/birthdays.ts';
// In the dispatcher:
if (toolName === 'create_birthday_event') {
  return handleCreateBirthdayEvent(ctx, input as Parameters<typeof handleCreateBirthdayEvent>[1]);
}
```

- [ ] **Step 8: Update `handleSearchEvents` in `src/services/ai/tool-handlers/events.ts`**

Add `event_type?: 'birthday' | 'regular'` to `SearchEventsInput`.

Replace the search call:
```ts
// Old:
ctx.eventService.searchEvents(userId, input.query)
// New (personal scope):
ctx.eventService.searchWithEventType(userId, input.query ?? null, input.event_type ?? null)
```

- [ ] **Step 9: Run tests**

```bash
bun test test/services/ai/tool-handlers/birthdays.test.ts
```

- [ ] **Step 10: Full suite + lint**

```bash
bun test
bun run lint
```

- [ ] **Step 11: Commit**

```bash
git add src/config/constants.ts src/services/ai/tools.ts \
  src/services/ai/tool-handlers/birthdays.ts src/services/ai/tool-executor.ts \
  src/services/ai/tool-handlers/events.ts src/services/ai/types.ts \
  test/services/ai/tool-handlers/birthdays.test.ts
git commit -m "feat(ai): create_birthday_event tool + event_type filter in search_events"
```

---

## Task 9: Final Validation

- [ ] **Run full test suite with coverage**

```bash
bun test --coverage
```
Expected: all tests pass, coverage ≥ 80%

- [ ] **Run linter — zero warnings**

```bash
bun run lint
```

- [ ] **Fix any lint issues and commit**

```bash
git add -A && git commit -m "fix(birthday): lint fixes"
```
