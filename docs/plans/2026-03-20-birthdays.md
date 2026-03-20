# Birthday Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add birthday event type with automatic MTProto discovery, `/birthdays` command, AI tool for creation, and birthday filter in `search_events`.

**Architecture:** Three new DB tables (event_type column on events, birth_event_metadata, birthday_sync_state), a BirthdayService that wraps MTProto fetch + event upsert logic, a daily BullMQ cron job, and a new Python batch script. Display title enrichment (🎁 emoji, age suffix) happens at read time, never stored.

**Tech Stack:** TypeScript/Bun, bun:sqlite, BullMQ, Pyrogram (Python), GramIO

**Spec:** `docs/specs/2026-03-20-birthdays-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/database/migrations.ts` | Modify | Add 3 migrations: event_type, birth_event_metadata, birthday_sync_state |
| `src/database/types.ts` | Modify | Add `BirthEventMetadata`, `BirthdaySyncState` types; add `event_type` to `CalendarEvent` |
| `src/database/repositories/birthday-metadata.repository.ts` | Create | CRUD for birth_event_metadata + birthday_sync_state |
| `src/database/repositories/event.repository.ts` | Modify | Add `getBirthdays(userId)`, `getBirthdaysForGroup(groupId)`, `searchByEventType()` |
| `src/database/index.ts` | Modify | Wire up BirthdayMetadataRepository |
| `src/services/birthday/birthday-service.ts` | Create | fetchAndSync, upsertBirthdayEvent, getDisplayTitle, getBirthdaysForDisplay, dedup logic |
| `scripts/fetch-birthdays.py` | Create | Pyrogram batch birthday fetch (stdin: user_id[], stdout: JSON map) |
| `src/worker/bot-tasks-queue.ts` | Modify | Add `cron-birthday-sync` job type + setupBirthdaySyncCron() |
| `src/bot/handlers/message.handler.ts` | Modify | Fire-and-forget birthday sync after groupMemberRepo.upsert |
| `src/bot/commands/birthdays.ts` | Create | `/birthdays` command handler |
| `src/bot/index.ts` | Modify | Register /birthdays command, wire BirthdayService into deps |
| `src/services/ai/tools.ts` | Modify | Add `event_type` param to `search_events`; add `create_birthday_event` tool definition |
| `src/services/ai/tool-handlers/birthdays.ts` | Create | handleCreateBirthdayEvent, handleSearchBirthdays |
| `src/services/ai/tool-executor.ts` | Modify | Route `create_birthday_event` to new handler |
| `src/services/ai/tool-handlers/events.ts` | Modify | handleSearchEvents: pass event_type filter through |
| `src/config/constants.ts` | Modify | Add `aiTools.birthdays.*` strings in MSG.en / MSG.ru |
| `test/services/birthday/birthday-service.test.ts` | Create | Unit tests for BirthdayService |
| `test/database/repositories/birthday-metadata.repository.test.ts` | Create | Repo tests |
| `test/bot/commands/birthdays.test.ts` | Create | Command output tests |
| `test/services/ai/tool-handlers/birthdays.test.ts` | Create | AI tool handler tests |

---

## Task 1: DB Migrations + Types

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`

- [ ] **Step 1: Write failing test for migration**

```ts
// test/database/migrations.test.ts — add to existing file or create new
import { test, expect } from 'bun:test';
import Database from 'bun:sqlite';
import { runMigrations } from '../../src/database/migrations.ts';

test('birthday migrations create expected tables and columns', () => {
  const db = new Database(':memory:');
  runMigrations(db);

  // event_type column exists on events
  const cols = db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
  expect(cols.some(c => c.name === 'event_type')).toBe(true);

  // birth_event_metadata table exists
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  expect(tables.some(t => t.name === 'birth_event_metadata')).toBe(true);
  expect(tables.some(t => t.name === 'birthday_sync_state')).toBe(true);

  // birth_event_metadata has expected columns
  const metaCols = db.prepare("PRAGMA table_info(birth_event_metadata)").all() as { name: string }[];
  const metaColNames = metaCols.map(c => c.name);
  expect(metaColNames).toContain('event_id');
  expect(metaColNames).toContain('celebrant_id');
  expect(metaColNames).toContain('birth_year');
  expect(metaColNames).toContain('auto_created');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/database/migrations.test.ts -t 'birthday migrations'
```
Expected: FAIL — columns/tables not found

- [ ] **Step 3: Add 3 migrations to `src/database/migrations.ts`**

Append after the last existing migration:

```ts
{
  name: '027_event_type',
  up: (db) => {
    db.exec(`ALTER TABLE events ADD COLUMN event_type TEXT`);
  },
},
{
  name: '028_birth_event_metadata',
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
  name: '029_birthday_sync_state',
  up: (db) => {
    db.exec(`
      CREATE TABLE birthday_sync_state (
        user_id    INTEGER PRIMARY KEY,
        synced_at  TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );
    `);
  },
},
```

- [ ] **Step 4: Add types to `src/database/types.ts`**

Add after `CalendarEvent` interface — also add `event_type` field to `CalendarEvent`:

```ts
// In CalendarEvent, add after `created_by`:
event_type: string | null; // null = regular, 'birthday' = birthday

// New interfaces:
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

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test test/database/migrations.test.ts -t 'birthday migrations'
```
Expected: PASS

- [ ] **Step 6: Run full test suite to check for regressions**

```bash
bun test
```
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/database/migrations.ts src/database/types.ts test/database/migrations.test.ts
git commit -m "feat(db): add birthday event_type, birth_event_metadata, birthday_sync_state"
```

---

## Task 2: BirthdayMetadataRepository

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
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';

let db: Database;
let repo: BirthdayMetadataRepository;
let eventRepo: EventRepository;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repo = new BirthdayMetadataRepository(db);
  eventRepo = new EventRepository(db);
  // Insert a test user
  db.prepare("INSERT INTO users (telegram_id, first_name, language, timezone) VALUES (1, 'Alice', 'en', 'UTC')").run();
  // Insert a test event
  db.prepare(`INSERT INTO events (user_id, title, start_at, timezone, all_day, event_type, sync_status, sync_version, owner_type)
    VALUES (1, 'Д/р Bob', '2026-05-10T00:00:00Z', 'UTC', 1, 'birthday', 'local_only', 1, 'user')`).run();
});

test('upsertMetadata creates new row', () => {
  const eventId = (db.prepare('SELECT id FROM events LIMIT 1').get() as { id: number }).id;
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: 1990, auto_created: 1 });
  const row = repo.findByEventId(eventId);
  expect(row?.celebrant_id).toBe(42);
  expect(row?.birth_year).toBe(1990);
});

test('findByCelebrantAndOwner returns event owned by user with matching celebrant_id', () => {
  const eventId = (db.prepare('SELECT id FROM events LIMIT 1').get() as { id: number }).id;
  repo.upsertMetadata({ event_id: eventId, celebrant_id: 42, birth_year: null, auto_created: 1 });
  const result = repo.findByCelebrantAndOwner(42, 1);
  expect(result).not.toBeNull();
  expect(result?.event_id).toBe(eventId);
});

test('upsertSyncState sets synced_at', () => {
  repo.upsertSyncState(1, '2026-03-20T10:00:00Z');
  const state = repo.getSyncState(1);
  expect(state?.synced_at).toBe('2026-03-20T10:00:00Z');
});

test('getUsersNeedingSync returns users with stale or missing sync state', () => {
  // User 1 has no sync state yet
  const users = repo.getUsersNeedingSync(7 * 24 * 60 * 60 * 1000);
  expect(users).toContain(1);
});

test('getUsersNeedingSync excludes recently synced users', () => {
  repo.upsertSyncState(1, new Date().toISOString());
  const users = repo.getUsersNeedingSync(7 * 24 * 60 * 60 * 1000);
  expect(users).not.toContain(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/database/repositories/birthday-metadata.repository.test.ts
```
Expected: FAIL — module not found

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

  // Find a birthday event for a given celebrant in a specific user's personal calendar
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

  // Returns user IDs that have no sync state OR were synced longer than maxAgeMs ago
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

Find where other repositories are instantiated. Add:
```ts
import { BirthdayMetadataRepository } from './repositories/birthday-metadata.repository.ts';
// In the DB object / factory:
birthdayMeta: new BirthdayMetadataRepository(db),
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test test/database/repositories/birthday-metadata.repository.test.ts
```
Expected: PASS

- [ ] **Step 6: Run full suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/database/repositories/birthday-metadata.repository.ts src/database/index.ts \
  test/database/repositories/birthday-metadata.repository.test.ts
git commit -m "feat(db): BirthdayMetadataRepository with sync state tracking"
```

---

## Task 3: EventRepository — Birthday Queries

**Files:**
- Modify: `src/database/repositories/event.repository.ts`

- [ ] **Step 1: Write failing tests**

Add to existing `test/database/repositories/event.repository.test.ts` (or create if absent):

```ts
test('getBirthdays returns only birthday events for user personal calendar', () => {
  // Insert birthday event
  db.prepare(`INSERT INTO events (user_id, title, start_at, timezone, all_day, event_type, sync_status, sync_version, owner_type)
    VALUES (1, 'Д/р Ivan', '2026-06-15T00:00:00Z', 'UTC', 1, 'birthday', 'local_only', 1, 'user')`).run();
  // Insert regular event
  db.prepare(`INSERT INTO events (user_id, title, start_at, timezone, all_day, sync_status, sync_version, owner_type)
    VALUES (1, 'Meeting', '2026-06-16T00:00:00Z', 'UTC', 0, 'local_only', 1, 'user')`).run();

  const results = eventRepo.getBirthdays(1);
  expect(results.length).toBe(1);
  expect(results[0]!.title).toBe('Д/р Ivan');
});

test('searchWithEventType filters by event_type', () => {
  db.prepare(`INSERT INTO events (user_id, title, start_at, timezone, all_day, event_type, sync_status, sync_version, owner_type)
    VALUES (1, 'Д/р Ivan', '2026-06-15T00:00:00Z', 'UTC', 1, 'birthday', 'local_only', 1, 'user')`).run();
  db.prepare(`INSERT INTO events (user_id, title, start_at, timezone, all_day, sync_status, sync_version, owner_type)
    VALUES (1, 'Meeting', '2026-06-16T00:00:00Z', 'UTC', 0, 'local_only', 1, 'user')`).run();

  const results = eventRepo.searchWithEventType(1, null, 'birthday');
  expect(results.every(e => e.event_type === 'birthday')).toBe(true);

  const allResults = eventRepo.searchWithEventType(1, 'ivan', null);
  expect(allResults.length).toBe(1);
  expect(allResults[0]!.title).toBe('Д/р Ivan');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/database/repositories/event.repository.test.ts -t 'getBirthdays\|searchWithEventType'
```

- [ ] **Step 3: Add methods to `src/database/repositories/event.repository.ts`**

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

// query=null means no text filter; eventType=null means all types
searchWithEventType(userId: number, query: string | null, eventType: string | null): CalendarEvent[] {
  const conditions: string[] = [
    "user_id = ?",
    "is_cancelled = 0",
    "(owner_type IS NULL OR owner_type = 'user')",
  ];
  const params: (string | number | null)[] = [userId];

  if (query) {
    conditions.push("title LIKE ?");
    params.push(`%${query}%`);
  }
  if (eventType) {
    conditions.push("event_type = ?");
    params.push(eventType);
  }

  return this.db
    .prepare(`SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY start_at`)
    .all(...params) as CalendarEvent[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/database/repositories/event.repository.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/event.repository.ts test/database/repositories/event.repository.test.ts
git commit -m "feat(db): add getBirthdays, getBirthdaysForGroup, searchWithEventType to EventRepository"
```

---

## Task 4: `scripts/fetch-birthdays.py`

**Files:**
- Create: `scripts/fetch-birthdays.py`

- [ ] **Step 1: Create the script**

```python
"""
Batch-fetch birthday info for Telegram user IDs via Pyrogram.
Usage: echo '[12345, 67890]' | python fetch-birthdays.py
stdin:  JSON array of integer user IDs
stdout: JSON object { "<user_id>": {"day": N, "month": N, "year": N} | null, ... }
        null = birthday not visible or not set
        year key may be absent if user hid it
Exit 0: success (partial results ok — unresolvable users omitted)
Exit 1: hard failure (session error, flood wait exceeded)
"""
import sys
import os
import json
import asyncio

API_ID = int(os.environ.get("MTPROTO_API_ID", 0))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")
FLOOD_WAIT_MAX = 30  # seconds


async def fetch_birthdays(user_ids: list[int]) -> dict:
    from pyrogram import Client
    from pyrogram.errors import FloodWait

    results = {}
    app = Client("voice_caller", api_id=API_ID, api_hash=API_HASH, workdir="data")
    await app.start()
    try:
        for uid in user_ids:
            try:
                user = await app.get_users(uid)
                bd = getattr(user, 'birthday', None)
                if bd is None:
                    results[str(uid)] = None
                else:
                    entry: dict = {"day": bd.day, "month": bd.month}
                    if bd.year:
                        entry["year"] = bd.year
                    results[str(uid)] = entry
            except FloodWait as e:
                if e.value > FLOOD_WAIT_MAX:
                    print(f"FloodWait {e.value}s exceeds limit, aborting", file=sys.stderr)
                    sys.exit(1)
                await asyncio.sleep(e.value)
                # retry once
                try:
                    user = await app.get_users(uid)
                    bd = getattr(user, 'birthday', None)
                    results[str(uid)] = None if bd is None else {"day": bd.day, "month": bd.month, **({"year": bd.year} if bd.year else {})}
                except Exception:
                    pass  # omit this user
            except Exception:
                pass  # omit unresolvable users
    finally:
        await app.stop()
    return results


def main():
    raw = sys.stdin.read().strip()
    try:
        user_ids = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(1)

    results = asyncio.run(fetch_birthdays(user_ids))
    print(json.dumps(results))


main()
```

- [ ] **Step 2: Verify script syntax**

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
import { test, expect, beforeEach, mock } from 'bun:test';
import Database from 'bun:sqlite';
import { runMigrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { BirthdayMetadataRepository } from '../../../src/database/repositories/birthday-metadata.repository.ts';
import { BirthdayService } from '../../../src/services/birthday/birthday-service.ts';

let db: Database;
let birthdayService: BirthdayService;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO users (telegram_id, first_name, language, timezone) VALUES (1, 'Alice', 'ru', 'Europe/Moscow')").run();
  db.prepare("INSERT INTO users (telegram_id, first_name, username, language, timezone) VALUES (42, 'Ivan', 'ivan_tg', 'ru', 'UTC')").run();

  const eventRepo = new EventRepository(db);
  const metaRepo = new BirthdayMetadataRepository(db);
  birthdayService = new BirthdayService(eventRepo, metaRepo, 'scripts/fetch-birthdays.py');
});

test('getDisplayTitle with birth_year returns age suffix', () => {
  const eventDate = new Date('2026-05-10T00:00:00Z');
  const result = birthdayService.getDisplayTitle('Д/р Иван', 1996, eventDate, 'ru');
  expect(result).toBe('🎁 Д/р Иван — 30 лет');
});

test('getDisplayTitle without birth_year returns no age', () => {
  const eventDate = new Date('2026-05-10T00:00:00Z');
  const result = birthdayService.getDisplayTitle('Bday Ivan', null, eventDate, 'en');
  expect(result).toBe('🎁 Bday Ivan');
});

test('getDisplayTitle EN with birth_year returns "turns N"', () => {
  const eventDate = new Date('2026-05-10T00:00:00Z');
  const result = birthdayService.getDisplayTitle('Bday Ivan', 2001, eventDate, 'en');
  expect(result).toBe('🎁 Bday Ivan — turns 25');
});

test('upsertBirthdayEvent creates event with correct fields', () => {
  birthdayService.upsertBirthdayEvent({
    ownerId: 1,
    celebrantId: 42,
    celebrantName: 'Иван',
    day: 10,
    month: 5,
    year: 1996,
    lang: 'ru',
    timezone: 'Europe/Moscow',
    autoCreated: true,
  });

  const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all() as { title: string; recurrence_rule: string; all_day: number }[];
  expect(events.length).toBe(1);
  expect(events[0]!.title).toBe('Д/р Иван');
  expect(events[0]!.recurrence_rule).toBe('FREQ=YEARLY');
  expect(events[0]!.all_day).toBe(1);
});

test('shouldSkipSync returns true when synced recently', () => {
  const metaRepo = new BirthdayMetadataRepository(db);
  metaRepo.upsertSyncState(1, new Date().toISOString());
  expect(birthdayService.shouldSkipSync(1)).toBe(true);
});

test('shouldSkipSync returns false when never synced', () => {
  expect(birthdayService.shouldSkipSync(1)).toBe(false);
});

test('formatBirthdaysCommand groups by calendar and returns deduplicated list', () => {
  // Create birthday in personal calendar
  birthdayService.upsertBirthdayEvent({
    ownerId: 1, celebrantId: 42, celebrantName: 'Иван', day: 10, month: 5, year: 1996,
    lang: 'ru', timezone: 'UTC', autoCreated: false,
  });

  // Insert a group chat
  db.prepare("INSERT INTO group_chats (chat_id, title, added_by) VALUES (100, 'Команда', 1)").run();

  const result = birthdayService.getBirthdaysForDisplay(1, 'ru', []);
  expect(result.personal.length).toBe(1);
  expect(result.personal[0]!.title).toBe('Д/р Иван');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test test/services/birthday/birthday-service.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/services/birthday/birthday-service.ts`**

```ts
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { BirthdayMetadataRepository } from '../../database/repositories/birthday-metadata.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';

const birthdayLogger = logger.child({ module: 'birthday-service' });

const SYNC_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
    private fetchScriptPath = 'scripts/fetch-birthdays.py',
  ) {}

  getDisplayTitle(title: string, birthYear: number | null, eventDate: Date, lang: 'en' | 'ru'): string {
    const prefix = '🎁 ';
    if (!birthYear) return prefix + title;
    const age = eventDate.getFullYear() - birthYear;
    const suffix = lang === 'ru' ? ` — ${age} лет` : ` — turns ${age}`;
    return prefix + title + suffix;
  }

  shouldSkipSync(userId: number): boolean {
    const state = this.metaRepo.getSyncState(userId);
    if (!state) return false;
    return Date.now() - new Date(state.synced_at).getTime() < SYNC_THROTTLE_MS;
  }

  upsertBirthdayEvent(params: UpsertBirthdayParams): void {
    const titlePrefix = params.lang === 'ru' ? 'Д/р ' : 'Bday ';
    const title = titlePrefix + params.celebrantName;

    // start_at: current year's occurrence, or next year if already passed
    const now = new Date();
    let year = now.getFullYear();
    const thisYearDate = new Date(year, params.month - 1, params.day);
    if (thisYearDate < now) year += 1;
    const startAt = new Date(year, params.month - 1, params.day).toISOString();

    // Check for existing event (by celebrant + owner + personal)
    const existing = params.celebrantId
      ? this.metaRepo.findByCelebrantAndOwner(params.celebrantId, params.ownerId)
      : null;

    let eventId: number;

    if (existing) {
      // Update start date if changed
      const existingMonth = new Date(existing.start_at).getMonth() + 1;
      const existingDay = new Date(existing.start_at).getDate();
      if (existingMonth !== params.month || existingDay !== params.day) {
        this.eventRepo.update(existing.event_id, params.ownerId, { start_at: startAt });
        // Reminders get deleted + recreated below
        birthdayLogger.info({ eventId: existing.event_id }, 'Birthday date changed, updating');
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
  }

  async fetchAndSync(userId: number, ownerId: number, lang: 'en' | 'ru', timezone: string): Promise<void> {
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

    // Need user's name — caller should pass it or we look it up externally
    birthdayLogger.info({ userId, birthday }, 'Birthday discovered');
    // Actual upsert requires celebrantName — handled by caller (BirthdaySyncJob)
  }

  getBirthdaysForDisplay(
    userId: number,
    lang: 'en' | 'ru',
    groupCalendars: { groupId: number; title: string }[],
  ): BirthdaysForDisplay {
    const personalEvents = this.eventRepo.getBirthdays(userId);
    const personalCelebrantIds = new Set(
      personalEvents.map((e) => {
        const meta = this.metaRepo.findByEventId(e.id);
        return meta?.celebrant_id ?? null;
      }),
    );

    const personal: BirthdayDisplayItem[] = personalEvents.map((e) => {
      const meta = this.metaRepo.findByEventId(e.id);
      return { event: e, celebrantId: meta?.celebrant_id ?? null, birthYear: meta?.birth_year ?? null, username: null };
    });

    const groups = groupCalendars.map(({ groupId, title }) => {
      const groupEvents = this.eventRepo.getBirthdaysForGroup(groupId);
      // Deduplicate: suppress group entries that exist in personal calendar
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

    // Sort each section by next occurrence from today
    const sortByNext = (a: BirthdayDisplayItem, b: BirthdayDisplayItem) => {
      const nextA = nextOccurrence(a.event.start_at);
      const nextB = nextOccurrence(b.event.start_at);
      return nextA - nextB;
    };

    personal.sort(sortByNext);
    for (const g of groups) g.items.sort(sortByNext);

    return { personal, groups };
  }
}

function nextOccurrence(startAt: string): number {
  const d = new Date(startAt);
  const now = new Date();
  const thisYear = new Date(now.getFullYear(), d.getMonth(), d.getDate());
  if (thisYear >= now) return thisYear.getTime();
  return new Date(now.getFullYear() + 1, d.getMonth(), d.getDate()).getTime();
}
```

- [ ] **Step 4: Run tests**

```bash
bun test test/services/birthday/birthday-service.test.ts
```
Expected: PASS

- [ ] **Step 5: Run full suite**

```bash
bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/services/birthday/birthday-service.ts test/services/birthday/birthday-service.test.ts
git commit -m "feat(birthday): BirthdayService — display titles, upsert, dedup, sync"
```

---

## Task 6: Cron Job + Message Handler Hook

**Files:**
- Modify: `src/worker/bot-tasks-queue.ts`
- Modify: `src/bot/handlers/message.handler.ts`

- [ ] **Step 1: Add `cron-birthday-sync` to bot-tasks-queue.ts**

In `BotTaskJobType`, add `'cron-birthday-sync'`.

In `BotTasksQueueDeps`, add `onBirthdaySync?: () => Promise<void>`.

In the worker handler, add:
```ts
if (job.data.type === 'cron-birthday-sync') {
  if (deps.onBirthdaySync) await deps.onBirthdaySync();
  return;
}
```

Add the setup function:
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

- [ ] **Step 2: Add fire-and-forget sync in `message.handler.ts`**

Find the block (line ~822):
```ts
if (deps.groupMemberRepo) {
  deps.groupMemberRepo.upsert(Number(chatId), user.telegram_id);
}
```

Add after:
```ts
if (deps.birthdayService && deps.groupMemberRepo) {
  deps.birthdayService.fetchAndSync(user.telegram_id, user.telegram_id, user.language as 'en' | 'ru', user.timezone)
    .catch((err) => birthdayLogger.error({ err, userId: user.telegram_id }, 'Birthday sync failed'));
}
```

Add `birthdayService?: BirthdayService` to the handler deps type.
Import logger for this module.

- [ ] **Step 3: Wire cron + service in `src/bot/index.ts`**

Instantiate `BirthdayService`, pass to `botTasksQueue` deps via `onBirthdaySync`, pass to message handler deps as `birthdayService`.

```ts
import { BirthdayService } from '../services/birthday/birthday-service.ts';
// After db init:
const birthdayService = new BirthdayService(db.events, db.birthdayMeta);
```

- [ ] **Step 4: Run full suite**

```bash
bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/worker/bot-tasks-queue.ts src/bot/handlers/message.handler.ts src/bot/index.ts
git commit -m "feat(birthday): cron job + group message hook for birthday discovery"
```

---

## Task 7: `/birthdays` Command

**Files:**
- Create: `src/bot/commands/birthdays.ts`
- Modify: `src/bot/index.ts`
- Create: `test/bot/commands/birthdays.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/bot/commands/birthdays.test.ts
import { test, expect } from 'bun:test';
import { formatBirthdayLine } from '../../../src/bot/commands/birthdays.ts';

test('formatBirthdayLine uses tg link when celebrant_id known', () => {
  const line = formatBirthdayLine({
    title: 'Д/р Иван',
    celebrantId: 12345,
    birthYear: 1996,
    username: null,
    eventDate: new Date('2026-05-10T00:00:00Z'),
    lang: 'ru',
  });
  expect(line).toContain('[Иван](tg://user?id=12345)');
  expect(line).toContain('30 лет');
  expect(line).not.toContain('Д/р');
  expect(line).toContain('🎁');
});

test('formatBirthdayLine uses @username when no celebrant_id', () => {
  const line = formatBirthdayLine({
    title: 'Д/р Маша',
    celebrantId: null,
    birthYear: null,
    username: 'masha_k',
    eventDate: new Date('2026-06-22T00:00:00Z'),
    lang: 'ru',
  });
  expect(line).toContain('@masha_k');
  expect(line).toContain('Маша');
  expect(line).not.toContain('Д/р');
});

test('formatBirthdayLine plain name when no id or username', () => {
  const line = formatBirthdayLine({
    title: 'Bday Pete',
    celebrantId: null,
    birthYear: null,
    username: null,
    eventDate: new Date('2026-09-07T00:00:00Z'),
    lang: 'en',
  });
  expect(line).toBe('🎁 Pete (7 Sep)');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test test/bot/commands/birthdays.test.ts
```

- [ ] **Step 3: Create `src/bot/commands/birthdays.ts`**

```ts
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

// Strips "Д/р " / "Bday " prefix and returns the bare name
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
  const ageSuffix = age ? (lang === 'ru' ? ` — ${age} лет` : ` — turns ${age}`) : '';
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
  const today = new Date();

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

- [ ] **Step 4: Register command in `src/bot/index.ts`**

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
Expected: PASS

- [ ] **Step 6: Run full suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/birthdays.ts src/bot/index.ts test/bot/commands/birthdays.test.ts
git commit -m "feat(bot): /birthdays command with grouped display and tg links"
```

---

## Task 8: AI Tools — `create_birthday_event` + `search_events` filter

**Files:**
- Modify: `src/services/ai/tools.ts`
- Create: `src/services/ai/tool-handlers/birthdays.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/tool-handlers/events.ts`
- Modify: `src/services/ai/types.ts`
- Modify: `src/config/constants.ts`
- Create: `test/services/ai/tool-handlers/birthdays.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/ai/tool-handlers/birthdays.test.ts
import { test, expect, beforeEach } from 'bun:test';
import Database from 'bun:sqlite';
import { runMigrations } from '../../../../src/database/migrations.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { BirthdayMetadataRepository } from '../../../../src/database/repositories/birthday-metadata.repository.ts';
import { BirthdayService } from '../../../../src/services/birthday/birthday-service.ts';
import { handleCreateBirthdayEvent } from '../../../../src/services/ai/tool-handlers/birthdays.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

let db: Database;
let birthdayService: BirthdayService;
let ctx: Partial<AgentContext>;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO users (telegram_id, first_name, username, language, timezone) VALUES (1, 'Alice', null, 'ru', 'UTC')").run();
  db.prepare("INSERT INTO users (telegram_id, first_name, username, language, timezone) VALUES (42, 'Ivan', 'ivan_t', 'ru', 'UTC')").run();

  const eventRepo = new EventRepository(db);
  const metaRepo = new BirthdayMetadataRepository(db);
  birthdayService = new BirthdayService(eventRepo, metaRepo);

  ctx = {
    user: { telegram_id: 1, language: 'ru', timezone: 'UTC', first_name: 'Alice' } as any,
    birthdayService,
    eventService: { searchWithEventType: (uid: number, q: string | null, type: string | null) => eventRepo.searchWithEventType(uid, q, type) } as any,
  };
});

test('handleCreateBirthdayEvent creates birthday event', () => {
  const result = handleCreateBirthdayEvent(ctx as AgentContext, {
    celebrant_id: 42,
    date: { day: 10, month: 5 },
    year: 1996,
  });
  expect(result.success).toBe(true);
  const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all();
  expect(events.length).toBe(1);
});

test('handleCreateBirthdayEvent returns error when date conflicts in personal calendar', () => {
  // Create existing birthday
  handleCreateBirthdayEvent(ctx as AgentContext, {
    celebrant_id: 42, date: { day: 10, month: 5 }, year: 1996,
  });

  // Try different date
  const result = handleCreateBirthdayEvent(ctx as AgentContext, {
    celebrant_id: 42, date: { day: 11, month: 5 }, year: 1996,
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain('уже есть');
});

test('handleCreateBirthdayEvent no-ops on same date', () => {
  handleCreateBirthdayEvent(ctx as AgentContext, {
    celebrant_id: 42, date: { day: 10, month: 5 },
  });
  const result = handleCreateBirthdayEvent(ctx as AgentContext, {
    celebrant_id: 42, date: { day: 10, month: 5 },
  });
  expect(result.success).toBe(true);
  const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all();
  expect(events.length).toBe(1); // no duplicate
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test test/services/ai/tool-handlers/birthdays.test.ts
```

- [ ] **Step 3: Add tool definition to `src/services/ai/tools.ts`**

After the `search_events` definition, add:

```ts
{
  name: 'create_birthday_event',
  description: 'Create a birthday event for a Telegram user. Auto-fetches name from profile.',
  input_schema: {
    type: 'object' as const,
    properties: {
      celebrant_id: { type: 'number', description: 'Telegram user ID of the birthday person' },
      date: {
        type: 'object',
        properties: {
          day: { type: 'number' },
          month: { type: 'number' },
        },
        required: ['day', 'month'],
        description: 'Birthday day and month',
      },
      year: { type: 'number', description: 'Birth year (optional)' },
      custom_name: { type: 'string', description: 'Override auto-fetched name' },
      group_id: { type: 'number', description: 'Group calendar ID. Omit for personal calendar.' },
    },
    required: ['celebrant_id', 'date'],
  },
},
```

Add `event_type` to `search_events` input:

```ts
// In search_events.input_schema.properties, add:
event_type: {
  type: 'string',
  enum: ['birthday', 'regular'],
  description: "Filter by event type. 'birthday' returns only birthday events.",
},
// Remove 'query' from required (make it optional):
required: [],  // both query and event_type are optional but at least one should be provided
```

- [ ] **Step 4: Create `src/services/ai/tool-handlers/birthdays.ts`**

```ts
import type { AgentContext } from '../types.ts';
import type { ToolResult } from '../types.ts';

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
  const metaRepo = ctx.birthdayService.metaRepo;

  // Resolve name: custom_name → DB → fallback
  let celebrantName = input.custom_name;
  if (!celebrantName) {
    const dbUser = ctx.userRepo?.findByTelegramId(input.celebrant_id);
    celebrantName = dbUser?.first_name ?? String(input.celebrant_id);
  }

  // Dedup check — personal calendar only
  if (!input.group_id) {
    const existing = metaRepo.findByCelebrantAndOwner(input.celebrant_id, ctx.user.telegram_id);
    if (existing) {
      const existingDate = new Date(existing.start_at);
      const existingDay = existingDate.getDate();
      const existingMonth = existingDate.getMonth() + 1;

      if (existingDay === input.date.day && existingMonth === input.date.month) {
        return { success: true, output: lang === 'ru'
          ? `День рождения ${celebrantName} уже есть: ${existing.title} (${existingDay}.${String(existingMonth).padStart(2, '0')})`
          : `Birthday for ${celebrantName} already exists: ${existing.title} (${existingDay}.${String(existingMonth).padStart(2, '0')})`,
        };
      }

      // Different date — error with existing info
      return {
        success: false,
        error: lang === 'ru'
          ? `Уже есть день рождения для ${celebrantName}: дата ${existingDay}.${String(existingMonth).padStart(2, '0')}. Хочешь обновить? Если да — вызови снова с правильной датой и я обновлю.`
          : `Birthday for ${celebrantName} already exists on ${existingDay}.${String(existingMonth).padStart(2, '0')}. To update, call again with the correct date.`,
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

  const titlePrefix = lang === 'ru' ? 'Д/р ' : 'Bday ';
  return {
    success: true,
    output: lang === 'ru'
      ? `День рождения создан: ${titlePrefix}${celebrantName} (${input.date.day}.${String(input.date.month).padStart(2, '0')})`
      : `Birthday created: ${titlePrefix}${celebrantName} (${input.date.day}.${String(input.date.month).padStart(2, '0')})`,
  };
}
```

- [ ] **Step 5: Update `handleSearchEvents` in `tool-handlers/events.ts`**

Find `handleSearchEvents`. Change the search call to use `searchWithEventType` when `event_type` is present:

```ts
// Add to SearchEventsInput type:
event_type?: 'birthday' | 'regular';

// In handleSearchEvents, replace:
const events = scope === 'group'
  ? ctx.eventService.searchEventsForGroup(ctx.groupChatId!, input.query)
  : ctx.eventService.searchEvents(userId, input.query);

// With:
const events = scope === 'group'
  ? ctx.eventService.searchEventsForGroup(ctx.groupChatId!, input.query ?? '')
  : ctx.eventService.searchWithEventType(userId, input.query ?? null, input.event_type ?? null);
```

Add `searchWithEventType` to `EventService` (delegate to `eventRepo.searchWithEventType`):

```ts
// In src/services/event/event-service.ts:
searchWithEventType(userId: number, query: string | null, eventType: string | null): CalendarEvent[] {
  return this.eventRepo.searchWithEventType(userId, query, eventType);
}
```

- [ ] **Step 6: Wire `create_birthday_event` in `tool-executor.ts`**

```ts
import { handleCreateBirthdayEvent } from './tool-handlers/birthdays.ts';
// In the switch/if chain:
case 'create_birthday_event':
  return handleCreateBirthdayEvent(ctx, input as CreateBirthdayInput);
```

- [ ] **Step 7: Add `birthdayService` to `AgentContext` type in `src/services/ai/types.ts`**

```ts
import type { BirthdayService } from '../birthday/birthday-service.ts';
// In AgentContext:
birthdayService?: BirthdayService;
```

Wire it when constructing agent context in `src/bot/index.ts`.

- [ ] **Step 8: Run tests**

```bash
bun test test/services/ai/tool-handlers/birthdays.test.ts
```
Expected: PASS

- [ ] **Step 9: Run full suite**

```bash
bun test
```

- [ ] **Step 10: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-handlers/birthdays.ts \
  src/services/ai/tool-executor.ts src/services/ai/tool-handlers/events.ts \
  src/services/ai/types.ts src/services/event/event-service.ts \
  test/services/ai/tool-handlers/birthdays.test.ts
git commit -m "feat(ai): create_birthday_event tool + event_type filter in search_events"
```

---

## Task 9: Final Integration Check

- [ ] **Run full test suite**

```bash
bun test --coverage
```
Expected: all tests pass, no new coverage drop below 80%

- [ ] **Run linter**

```bash
bun run lint
```
Expected: zero warnings, zero errors

- [ ] **Final commit if any lint fixes needed**

```bash
git add -A
git commit -m "fix(birthday): lint fixes"
```
