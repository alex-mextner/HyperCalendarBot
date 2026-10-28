> Part 1 of 3 of [Birthday Events Implementation Plan](../2026-03-20-birthdays.md) — next: [02-tasks-5-6.md](02-tasks-5-6.md)

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

- [ ] **Step 3: Verify 035 is the last migration**

```bash
grep "name: '" src/database/migrations.ts | tail -3
```
Expected: last entry is `035_event_mention_store`. If not — adjust numbers accordingly.

- [ ] **Step 4: Append 3 migrations to `src/database/migrations.ts`** (after `035_event_mention_store`)

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

Add import at top:
```ts
import { BirthdayMetadataRepository } from './repositories/birthday-metadata.repository.ts';
```

Add `readonly` field to `DatabaseService` class (after `eventMentions`):
```ts
readonly birthdayMeta: BirthdayMetadataRepository;
```

Add instantiation in constructor (after `this.eventMentions = ...`):
```ts
this.birthdayMeta = new BirthdayMetadataRepository(this.db);
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
                    bd = getattr(user, "birthday", None)
                    if bd is None:
                        results[str(uid)] = None
                    else:
                        entry: dict = {"day": bd.day, "month": bd.month}
                        if getattr(bd, "year", None):
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

