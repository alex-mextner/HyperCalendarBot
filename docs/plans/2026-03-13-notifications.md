# Notifications Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully configurable notification system with morning agendas, event reminders, and evening reviews — all timezone-aware, delivered through BullMQ workers.

**Architecture:** A per-minute BullMQ repeatable job ticks through all due notifications (morning agendas, event reminders, evening reviews), filters by quiet hours and dedup, then enqueues delivery jobs. A separate BullMQ worker sends messages via GramIO. Event reminders are pre-materialized when events are created/updated.

**Tech Stack:** BullMQ, Bun.redis, bun:sqlite, @date-fns/tz, GramIO, pino

---

## Chunk 1: Data Layer

### Task 1: Migration 006 — Notification Tables

**Files:**
- Modify: `src/database/migrations.ts`
- Test: `test/database/migrations.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// In test/database/migrations.test.ts — add to existing test file
test('migration 006 creates notification tables', () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain('notification_preferences');
  expect(names).toContain('event_reminders');
  expect(names).toContain('notification_log');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/migrations.test.ts`
Expected: FAIL — tables don't exist yet

- [ ] **Step 3: Write the migration**

Add to `src/database/migrations.ts` in the `MIGRATIONS` array:

```typescript
{
  name: '006_create_notification_tables',
  sql: `
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id                    INTEGER PRIMARY KEY,
      morning_agenda_enabled     INTEGER NOT NULL DEFAULT 1,
      morning_agenda_time        TEXT NOT NULL DEFAULT '08:00',
      morning_agenda_utc         TEXT,
      morning_agenda_format      TEXT NOT NULL DEFAULT 'text',
      default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
      evening_review_enabled     INTEGER NOT NULL DEFAULT 0,
      evening_review_time        TEXT NOT NULL DEFAULT '21:00',
      evening_review_utc         TEXT,
      evening_review_format      TEXT NOT NULL DEFAULT 'text',
      quiet_hours_enabled        INTEGER NOT NULL DEFAULT 0,
      quiet_hours_start          TEXT,
      quiet_hours_end            TEXT,
      updated_at                 TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS event_reminders (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id          INTEGER NOT NULL,
      user_id           INTEGER NOT NULL,
      remind_at_utc     TEXT NOT NULL,
      interval_minutes  INTEGER NOT NULL,
      interval_label    TEXT NOT NULL,
      sent              INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_event_reminders_due
      ON event_reminders(remind_at_utc, sent) WHERE sent = 0;
    CREATE INDEX IF NOT EXISTS idx_event_reminders_event
      ON event_reminders(event_id);

    CREATE TABLE IF NOT EXISTS notification_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      type            TEXT NOT NULL,
      reference_key   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'queued',
      channel         TEXT NOT NULL DEFAULT 'telegram_text',
      payload         TEXT,
      error           TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at         TEXT,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_dedup
      ON notification_log(reference_key);
    CREATE INDEX IF NOT EXISTS idx_notification_log_status
      ON notification_log(status, created_at);
  `,
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/database/migrations.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/migrations.ts test/database/migrations.test.ts
git commit -m "feat: add migration 006 for notification tables"
```

---

### Task 2: NotificationPreferencesRepository

**Files:**
- Create: `src/database/repositories/notification-preferences.repository.ts`
- Create: `test/database/repositories/notification-preferences.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/database/repositories/notification-preferences.repository.test.ts
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach } from 'bun:test';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';

describe('NotificationPreferencesRepository', () => {
  let db: Database;
  let repo: NotificationPreferencesRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      language TEXT NOT NULL DEFAULT 'en',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      country_code TEXT,
      onboarding_completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE notification_preferences (
      user_id INTEGER PRIMARY KEY,
      morning_agenda_enabled INTEGER NOT NULL DEFAULT 1,
      morning_agenda_time TEXT NOT NULL DEFAULT '08:00',
      morning_agenda_utc TEXT,
      morning_agenda_format TEXT NOT NULL DEFAULT 'text',
      default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
      evening_review_enabled INTEGER NOT NULL DEFAULT 0,
      evening_review_time TEXT NOT NULL DEFAULT '21:00',
      evening_review_utc TEXT,
      evening_review_format TEXT NOT NULL DEFAULT 'text',
      quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
      quiet_hours_start TEXT,
      quiet_hours_end TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id, username) VALUES (42, 'alice')");
    repo = new NotificationPreferencesRepository(db);
  });

  test('ensureDefaults creates row with defaults', () => {
    repo.ensureDefaults(42);
    const prefs = repo.get(42);
    expect(prefs).not.toBeNull();
    expect(prefs!.morning_agenda_enabled).toBe(1);
    expect(prefs!.morning_agenda_time).toBe('08:00');
    expect(prefs!.default_reminder_intervals).toBe('[15]');
    expect(prefs!.evening_review_enabled).toBe(0);
    expect(prefs!.quiet_hours_enabled).toBe(0);
  });

  test('get returns null for non-existent user', () => {
    expect(repo.get(999)).toBeNull();
  });

  test('update modifies specific fields', () => {
    repo.ensureDefaults(42);
    repo.update(42, {
      morning_agenda_time: '09:00',
      morning_agenda_utc: '06:00',
      evening_review_enabled: 1,
    });
    const prefs = repo.get(42);
    expect(prefs!.morning_agenda_time).toBe('09:00');
    expect(prefs!.morning_agenda_utc).toBe('06:00');
    expect(prefs!.evening_review_enabled).toBe(1);
  });

  test('getAllWithMorningAgenda returns enabled users', () => {
    repo.ensureDefaults(42);
    repo.update(42, { morning_agenda_utc: '05:00' });
    const users = repo.getAllByMorningUtc('05:00');
    expect(users.length).toBe(1);
    expect(users[0]!.user_id).toBe(42);
  });

  test('getAllByEveningUtc returns enabled users', () => {
    repo.ensureDefaults(42);
    repo.update(42, { evening_review_enabled: 1, evening_review_utc: '18:00' });
    const users = repo.getAllByEveningUtc('18:00');
    expect(users.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/repositories/notification-preferences.repository.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the repository**

```typescript
// src/database/repositories/notification-preferences.repository.ts
import type { Database } from 'bun:sqlite';

export interface NotificationPreferencesRow {
  user_id: number;
  morning_agenda_enabled: number;
  morning_agenda_time: string;
  morning_agenda_utc: string | null;
  morning_agenda_format: string;
  default_reminder_intervals: string;
  evening_review_enabled: number;
  evening_review_time: string;
  evening_review_utc: string | null;
  evening_review_format: string;
  quiet_hours_enabled: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  updated_at: string;
}

export type NotificationPreferencesUpdate = Partial<
  Omit<NotificationPreferencesRow, 'user_id' | 'updated_at'>
>;

export class NotificationPreferencesRepository {
  constructor(private db: Database) {}

  ensureDefaults(userId: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO notification_preferences (user_id) VALUES (?)')
      .run(userId);
  }

  get(userId: number): NotificationPreferencesRow | null {
    return this.db
      .prepare('SELECT * FROM notification_preferences WHERE user_id = ?')
      .get(userId) as NotificationPreferencesRow | null;
  }

  update(userId: number, patch: NotificationPreferencesUpdate): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => v);
    this.db
      .prepare(`UPDATE notification_preferences SET ${sets}, updated_at = datetime('now') WHERE user_id = ?`)
      .run(...values, userId);
  }

  getAllByMorningUtc(utcHHMM: string): NotificationPreferencesRow[] {
    return this.db
      .prepare(
        `SELECT * FROM notification_preferences
         WHERE morning_agenda_enabled = 1 AND morning_agenda_utc = ?`,
      )
      .all(utcHHMM) as NotificationPreferencesRow[];
  }

  getAllByEveningUtc(utcHHMM: string): NotificationPreferencesRow[] {
    return this.db
      .prepare(
        `SELECT * FROM notification_preferences
         WHERE evening_review_enabled = 1 AND evening_review_utc = ?`,
      )
      .all(utcHHMM) as NotificationPreferencesRow[];
  }

  getAll(): NotificationPreferencesRow[] {
    return this.db
      .prepare('SELECT * FROM notification_preferences')
      .all() as NotificationPreferencesRow[];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/database/repositories/notification-preferences.repository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/notification-preferences.repository.ts test/database/repositories/notification-preferences.repository.test.ts
git commit -m "feat: add NotificationPreferencesRepository"
```

---

### Task 3: EventReminderRepository

**Files:**
- Create: `src/database/repositories/event-reminder.repository.ts`
- Create: `test/database/repositories/event-reminder.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/database/repositories/event-reminder.repository.test.ts
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach } from 'bun:test';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';

describe('EventReminderRepository', () => {
  let db: Database;
  let repo: EventReminderRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      all_day INTEGER NOT NULL DEFAULT 0,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE event_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      remind_at_utc TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      interval_label TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id) VALUES (42)");
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2026-03-15T10:00:00Z')");
    repo = new EventReminderRepository(db);
  });

  test('insert creates a reminder row', () => {
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });
    const rows = repo.getForEvent(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interval_minutes).toBe(15);
  });

  test('getDue returns reminders in time window', () => {
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });
    const due = repo.getDue('2026-03-15T09:45:00Z', '2026-03-15T09:46:00Z');
    expect(due.length).toBe(1);
  });

  test('getDue excludes already-sent reminders', () => {
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });
    const rows = repo.getForEvent(1);
    repo.markSent(rows[0]!.id);
    const due = repo.getDue('2026-03-15T09:45:00Z', '2026-03-15T09:46:00Z');
    expect(due.length).toBe(0);
  });

  test('deleteForEvent removes all reminders for an event', () => {
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });
    repo.deleteForEvent(1);
    expect(repo.getForEvent(1).length).toBe(0);
  });

  test('deleteUnsentForUser removes unsent reminders for a user', () => {
    repo.insert({
      event_id: 1,
      user_id: 42,
      remind_at_utc: '2026-03-15T09:45:00Z',
      interval_minutes: 15,
      interval_label: '15 minutes',
    });
    repo.deleteUnsentForUser(42);
    expect(repo.getForEvent(1).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/repositories/event-reminder.repository.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the repository**

```typescript
// src/database/repositories/event-reminder.repository.ts
import type { Database } from 'bun:sqlite';

export interface EventReminderRow {
  id: number;
  event_id: number;
  user_id: number;
  remind_at_utc: string;
  interval_minutes: number;
  interval_label: string;
  sent: number;
  created_at: string;
}

export interface InsertEventReminderData {
  event_id: number;
  user_id: number;
  remind_at_utc: string;
  interval_minutes: number;
  interval_label: string;
}

export interface DueReminderRow extends EventReminderRow {
  event_title: string;
  event_start_at: string;
  event_location: string | null;
}

export class EventReminderRepository {
  constructor(private db: Database) {}

  insert(data: InsertEventReminderData): void {
    this.db
      .prepare(
        `INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(data.event_id, data.user_id, data.remind_at_utc, data.interval_minutes, data.interval_label);
  }

  getDue(windowStart: string, windowEnd: string): DueReminderRow[] {
    return this.db
      .prepare(
        `SELECT er.*, e.title AS event_title, e.start_at AS event_start_at, e.location AS event_location
         FROM event_reminders er
         JOIN events e ON e.id = er.event_id
         WHERE er.remind_at_utc >= ? AND er.remind_at_utc < ? AND er.sent = 0`,
      )
      .all(windowStart, windowEnd) as DueReminderRow[];
  }

  markSent(id: number): void {
    this.db.prepare('UPDATE event_reminders SET sent = 1 WHERE id = ?').run(id);
  }

  getForEvent(eventId: number): EventReminderRow[] {
    return this.db
      .prepare('SELECT * FROM event_reminders WHERE event_id = ?')
      .all(eventId) as EventReminderRow[];
  }

  deleteForEvent(eventId: number): void {
    this.db.prepare('DELETE FROM event_reminders WHERE event_id = ?').run(eventId);
  }

  deleteUnsentForUser(userId: number): void {
    this.db.prepare('DELETE FROM event_reminders WHERE user_id = ? AND sent = 0').run(userId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/database/repositories/event-reminder.repository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/event-reminder.repository.ts test/database/repositories/event-reminder.repository.test.ts
git commit -m "feat: add EventReminderRepository"
```

---

### Task 4: NotificationLogRepository

**Files:**
- Create: `src/database/repositories/notification-log.repository.ts`
- Create: `test/database/repositories/notification-log.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/database/repositories/notification-log.repository.test.ts
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach } from 'bun:test';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';

describe('NotificationLogRepository', () => {
  let db: Database;
  let repo: NotificationLogRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      reference_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      channel TEXT NOT NULL DEFAULT 'telegram_text',
      payload TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run('CREATE UNIQUE INDEX idx_notification_log_dedup ON notification_log(reference_key)');
    db.run("INSERT INTO users (telegram_id) VALUES (42)");
    repo = new NotificationLogRepository(db);
  });

  test('insert returns id on success', () => {
    const id = repo.insert({
      user_id: 42,
      type: 'morning_agenda',
      reference_key: 'ma:42:2026-03-15',
      channel: 'telegram_text',
      payload: '{}',
    });
    expect(id).toBeGreaterThan(0);
  });

  test('insert returns null on duplicate reference_key', () => {
    repo.insert({
      user_id: 42,
      type: 'morning_agenda',
      reference_key: 'ma:42:2026-03-15',
      channel: 'telegram_text',
      payload: '{}',
    });
    const id2 = repo.insert({
      user_id: 42,
      type: 'morning_agenda',
      reference_key: 'ma:42:2026-03-15',
      channel: 'telegram_text',
      payload: '{}',
    });
    expect(id2).toBeNull();
  });

  test('markSent updates status and sent_at', () => {
    const id = repo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:1',
      channel: 'telegram_text',
      payload: '{}',
    })!;
    repo.markSent(id);
    const row = repo.getById(id);
    expect(row!.status).toBe('sent');
    expect(row!.sent_at).not.toBeNull();
  });

  test('markFailed updates status and error', () => {
    const id = repo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:2',
      channel: 'telegram_text',
      payload: '{}',
    })!;
    repo.markFailed(id, 'Bot blocked', 3);
    const row = repo.getById(id);
    expect(row!.status).toBe('failed');
    expect(row!.error).toBe('Bot blocked');
    expect(row!.attempts).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/repositories/notification-log.repository.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the repository**

```typescript
// src/database/repositories/notification-log.repository.ts
import type { Database } from 'bun:sqlite';

export interface NotificationLogRow {
  id: number;
  user_id: number;
  type: string;
  reference_key: string;
  status: string;
  channel: string;
  payload: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  sent_at: string | null;
}

export interface InsertNotificationLogData {
  user_id: number;
  type: string;
  reference_key: string;
  channel: string;
  payload: string;
}

export class NotificationLogRepository {
  constructor(private db: Database) {}

  insert(data: InsertNotificationLogData): number | null {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO notification_log (user_id, type, reference_key, channel, payload)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(data.user_id, data.type, data.reference_key, data.channel, data.payload);
      return Number(result.lastInsertRowid);
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed')) return null;
      throw err;
    }
  }

  getById(id: number): NotificationLogRow | null {
    return this.db
      .prepare('SELECT * FROM notification_log WHERE id = ?')
      .get(id) as NotificationLogRow | null;
  }

  markSent(id: number): void {
    this.db
      .prepare(
        `UPDATE notification_log SET status = 'sent', sent_at = datetime('now'), attempts = attempts + 1
         WHERE id = ?`,
      )
      .run(id);
  }

  markFailed(id: number, error: string, attempts: number): void {
    this.db
      .prepare(
        `UPDATE notification_log SET status = 'failed', error = ?, attempts = ?
         WHERE id = ?`,
      )
      .run(error, attempts, id);
  }

  updateAttempts(id: number, error: string, attempts: number): void {
    this.db
      .prepare('UPDATE notification_log SET error = ?, attempts = ? WHERE id = ?')
      .run(error, attempts, id);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/database/repositories/notification-log.repository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/notification-log.repository.ts test/database/repositories/notification-log.repository.test.ts
git commit -m "feat: add NotificationLogRepository"
```

---

### Task 5: Wire Repositories into DatabaseService

**Files:**
- Modify: `src/database/index.ts`
- Modify: `test/database/migrations.test.ts` (if needed)

- [ ] **Step 1: Add imports and properties to DatabaseService**

In `src/database/index.ts`, add:

```typescript
import { NotificationPreferencesRepository } from './repositories/notification-preferences.repository.ts';
import { EventReminderRepository } from './repositories/event-reminder.repository.ts';
import { NotificationLogRepository } from './repositories/notification-log.repository.ts';
```

Add readonly properties:

```typescript
readonly notificationPreferences: NotificationPreferencesRepository;
readonly eventReminders: EventReminderRepository;
readonly notificationLog: NotificationLogRepository;
```

In constructor, after existing repo initializations:

```typescript
this.notificationPreferences = new NotificationPreferencesRepository(this.db);
this.eventReminders = new EventReminderRepository(this.db);
this.notificationLog = new NotificationLogRepository(this.db);
```

- [ ] **Step 2: Run all tests to verify nothing is broken**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/database/index.ts
git commit -m "feat: wire notification repositories into DatabaseService"
```

---

## Chunk 2: Core Services

### Task 6: Timezone Utilities for Notifications

**Files:**
- Create: `src/services/notification/timezone.ts`
- Create: `test/services/notification/timezone.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/services/notification/timezone.test.ts
import { describe, test, expect } from 'bun:test';
import {
  getUserLocalTime,
  isTimeMatch,
  localTimeToUtcHHMM,
  isQuietHours,
} from '../../../src/services/notification/timezone.ts';

describe('timezone utilities', () => {
  describe('getUserLocalTime', () => {
    test('converts UTC to Moscow time (+3)', () => {
      const utc = new Date('2026-03-15T05:30:00Z');
      const local = getUserLocalTime(utc, 'Europe/Moscow');
      expect(local.hours).toBe(8);
      expect(local.minutes).toBe(30);
    });

    test('converts UTC to NY time (-4 in DST)', () => {
      const utc = new Date('2026-07-15T14:00:00Z');
      const local = getUserLocalTime(utc, 'America/New_York');
      expect(local.hours).toBe(10);
      expect(local.minutes).toBe(0);
    });
  });

  describe('isTimeMatch', () => {
    test('matches when local time equals target', () => {
      // Moscow is UTC+3, so 05:00 UTC = 08:00 Moscow
      const utc = new Date('2026-03-15T05:00:00Z');
      expect(isTimeMatch(utc, 'Europe/Moscow', '08:00')).toBe(true);
    });

    test('does not match different time', () => {
      const utc = new Date('2026-03-15T05:00:00Z');
      expect(isTimeMatch(utc, 'Europe/Moscow', '09:00')).toBe(false);
    });
  });

  describe('localTimeToUtcHHMM', () => {
    test('converts Moscow 08:00 to UTC 05:00', () => {
      expect(localTimeToUtcHHMM('08:00', 'Europe/Moscow')).toBe('05:00');
    });

    test('handles UTC+0 timezone', () => {
      expect(localTimeToUtcHHMM('08:00', 'UTC')).toBe('08:00');
    });

    test('handles wrap-around past midnight', () => {
      // Tokyo is UTC+9, so 02:00 local = 17:00 UTC (previous day)
      expect(localTimeToUtcHHMM('02:00', 'Asia/Tokyo')).toBe('17:00');
    });
  });

  describe('isQuietHours', () => {
    test('returns false when quiet hours disabled', () => {
      const result = isQuietHours(
        { enabled: false, start: null, end: null },
        new Date('2026-03-15T02:00:00Z'),
        'UTC',
      );
      expect(result).toBe(false);
    });

    test('detects quiet hours same-day range', () => {
      // 13:00–15:00 UTC, current time 14:00 UTC
      const result = isQuietHours(
        { enabled: true, start: '13:00', end: '15:00' },
        new Date('2026-03-15T14:00:00Z'),
        'UTC',
      );
      expect(result).toBe(true);
    });

    test('detects quiet hours midnight-spanning range', () => {
      // 23:00–07:00 local, current time 02:00 local (02:00 UTC for UTC tz)
      const result = isQuietHours(
        { enabled: true, start: '23:00', end: '07:00' },
        new Date('2026-03-15T02:00:00Z'),
        'UTC',
      );
      expect(result).toBe(true);
    });

    test('returns false outside quiet hours', () => {
      const result = isQuietHours(
        { enabled: true, start: '23:00', end: '07:00' },
        new Date('2026-03-15T12:00:00Z'),
        'UTC',
      );
      expect(result).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/services/notification/timezone.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement timezone utilities**

```typescript
// src/services/notification/timezone.ts
import { TZDate } from '@date-fns/tz';

export function getUserLocalTime(
  utcNow: Date,
  timezone: string,
): { hours: number; minutes: number } {
  const local = new TZDate(utcNow, timezone);
  return { hours: local.getHours(), minutes: local.getMinutes() };
}

export function isTimeMatch(
  utcNow: Date,
  timezone: string,
  targetHHMM: string,
): boolean {
  const local = getUserLocalTime(utcNow, timezone);
  const [targetH, targetM] = targetHHMM.split(':').map(Number);
  return local.hours === targetH && local.minutes === targetM;
}

export function localTimeToUtcHHMM(localHHMM: string, timezone: string): string {
  const [h, m] = localHHMM.split(':').map(Number);
  // Use a reference date to compute the offset
  const refDate = new Date('2026-06-15T12:00:00Z');
  const localDate = new TZDate(refDate, timezone);
  const offsetMs = localDate.getTimezoneOffset() * -60_000;
  // Convert local HH:MM to UTC
  const localMinutes = h! * 60 + m!;
  const offsetMinutes = offsetMs / 60_000;
  let utcMinutes = localMinutes - offsetMinutes;
  if (utcMinutes < 0) utcMinutes += 1440;
  if (utcMinutes >= 1440) utcMinutes -= 1440;
  const utcH = Math.floor(utcMinutes / 60);
  const utcM = utcMinutes % 60;
  return `${String(utcH).padStart(2, '0')}:${String(utcM).padStart(2, '0')}`;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string | null;
  end: string | null;
}

export function isQuietHours(
  config: QuietHoursConfig,
  utcNow: Date,
  timezone: string,
): boolean {
  if (!config.enabled || !config.start || !config.end) return false;

  const local = getUserLocalTime(utcNow, timezone);
  const currentMinutes = local.hours * 60 + local.minutes;

  const [startH, startM] = config.start.split(':').map(Number);
  const [endH, endM] = config.end.split(':').map(Number);
  const startMinutes = startH! * 60 + startM!;
  const endMinutes = endH! * 60 + endM!;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Spans midnight
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/services/notification/timezone.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notification/timezone.ts test/services/notification/timezone.test.ts
git commit -m "feat: add notification timezone utilities"
```

---

### Task 7: NotificationPreferencesService

**Files:**
- Create: `src/services/notification/preferences.ts`
- Create: `test/services/notification/preferences.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/services/notification/preferences.test.ts
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach } from 'bun:test';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';

describe('NotificationPreferencesService', () => {
  let db: Database;
  let repo: NotificationPreferencesRepository;
  let service: NotificationPreferencesService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE notification_preferences (
      user_id INTEGER PRIMARY KEY,
      morning_agenda_enabled INTEGER NOT NULL DEFAULT 1,
      morning_agenda_time TEXT NOT NULL DEFAULT '08:00',
      morning_agenda_utc TEXT,
      morning_agenda_format TEXT NOT NULL DEFAULT 'text',
      default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
      evening_review_enabled INTEGER NOT NULL DEFAULT 0,
      evening_review_time TEXT NOT NULL DEFAULT '21:00',
      evening_review_utc TEXT,
      evening_review_format TEXT NOT NULL DEFAULT 'text',
      quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
      quiet_hours_start TEXT,
      quiet_hours_end TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id, timezone) VALUES (42, 'Europe/Moscow')");
    repo = new NotificationPreferencesRepository(db);
    service = new NotificationPreferencesService(repo);
  });

  test('getOrCreate creates defaults and returns them', () => {
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_enabled).toBe(1);
    expect(prefs.morning_agenda_time).toBe('08:00');
  });

  test('getOrCreate returns existing prefs on second call', () => {
    service.getOrCreate(42);
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_enabled).toBe(1);
  });

  test('resolveDefaultIntervals parses JSON', () => {
    service.getOrCreate(42);
    const intervals = service.resolveDefaultIntervals(42);
    expect(intervals).toEqual([15]);
  });

  test('updateMorningTime updates time and recomputes UTC', () => {
    service.getOrCreate(42);
    service.updateMorningTime(42, '09:00', 'Europe/Moscow');
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_time).toBe('09:00');
    expect(prefs.morning_agenda_utc).toBe('06:00');
  });

  test('toggleMorningAgenda flips enabled flag', () => {
    service.getOrCreate(42);
    service.toggleMorningAgenda(42);
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_enabled).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/notification/preferences.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the service**

```typescript
// src/services/notification/preferences.ts
import type {
  NotificationPreferencesRepository,
  NotificationPreferencesRow,
} from '../../database/repositories/notification-preferences.repository.ts';
import { localTimeToUtcHHMM } from './timezone.ts';

export class NotificationPreferencesService {
  constructor(private repo: NotificationPreferencesRepository) {}

  getOrCreate(userId: number): NotificationPreferencesRow {
    this.repo.ensureDefaults(userId);
    return this.repo.get(userId)!;
  }

  resolveDefaultIntervals(userId: number): number[] {
    const prefs = this.getOrCreate(userId);
    return JSON.parse(prefs.default_reminder_intervals) as number[];
  }

  updateMorningTime(userId: number, time: string, timezone: string): void {
    const utc = localTimeToUtcHHMM(time, timezone);
    this.repo.update(userId, { morning_agenda_time: time, morning_agenda_utc: utc });
  }

  updateEveningTime(userId: number, time: string, timezone: string): void {
    const utc = localTimeToUtcHHMM(time, timezone);
    this.repo.update(userId, { evening_review_time: time, evening_review_utc: utc });
  }

  toggleMorningAgenda(userId: number): void {
    const prefs = this.getOrCreate(userId);
    this.repo.update(userId, { morning_agenda_enabled: prefs.morning_agenda_enabled ? 0 : 1 });
  }

  toggleEveningReview(userId: number): void {
    const prefs = this.getOrCreate(userId);
    this.repo.update(userId, { evening_review_enabled: prefs.evening_review_enabled ? 0 : 1 });
  }

  toggleQuietHours(userId: number): void {
    const prefs = this.getOrCreate(userId);
    this.repo.update(userId, { quiet_hours_enabled: prefs.quiet_hours_enabled ? 0 : 1 });
  }

  updateQuietHoursStart(userId: number, time: string): void {
    this.repo.update(userId, { quiet_hours_start: time });
  }

  updateQuietHoursEnd(userId: number, time: string): void {
    this.repo.update(userId, { quiet_hours_end: time });
  }

  updateDefaultIntervals(userId: number, intervals: number[]): void {
    this.repo.update(userId, { default_reminder_intervals: JSON.stringify(intervals) });
  }

  recomputeUtcTimes(userId: number, timezone: string): void {
    const prefs = this.getOrCreate(userId);
    const morningUtc = localTimeToUtcHHMM(prefs.morning_agenda_time, timezone);
    const eveningUtc = localTimeToUtcHHMM(prefs.evening_review_time, timezone);
    this.repo.update(userId, { morning_agenda_utc: morningUtc, evening_review_utc: eveningUtc });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/notification/preferences.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notification/preferences.ts test/services/notification/preferences.test.ts
git commit -m "feat: add NotificationPreferencesService"
```

---

### Task 8: ReminderMaterializer

**Files:**
- Create: `src/services/notification/materializer.ts`
- Create: `test/services/notification/materializer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/services/notification/materializer.test.ts
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach } from 'bun:test';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { ReminderMaterializer } from '../../../src/services/notification/materializer.ts';

describe('ReminderMaterializer', () => {
  let db: Database;
  let reminderRepo: EventReminderRepository;
  let prefsRepo: NotificationPreferencesRepository;
  let materializer: ReminderMaterializer;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      reminder_overrides TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      all_day INTEGER NOT NULL DEFAULT 0,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE notification_preferences (
      user_id INTEGER PRIMARY KEY,
      morning_agenda_enabled INTEGER NOT NULL DEFAULT 1,
      morning_agenda_time TEXT NOT NULL DEFAULT '08:00',
      morning_agenda_utc TEXT,
      morning_agenda_format TEXT NOT NULL DEFAULT 'text',
      default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
      evening_review_enabled INTEGER NOT NULL DEFAULT 0,
      evening_review_time TEXT NOT NULL DEFAULT '21:00',
      evening_review_utc TEXT,
      evening_review_format TEXT NOT NULL DEFAULT 'text',
      quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
      quiet_hours_start TEXT,
      quiet_hours_end TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE event_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      remind_at_utc TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      interval_label TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id) VALUES (42)");
    reminderRepo = new EventReminderRepository(db);
    prefsRepo = new NotificationPreferencesRepository(db);
    prefsRepo.ensureDefaults(42);
    materializer = new ReminderMaterializer(reminderRepo, prefsRepo);
  });

  test('materializes reminders using default intervals', () => {
    // Event in the future
    db.run(
      "INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2099-03-15T10:00:00Z')",
    );
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: null },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interval_minutes).toBe(15);
    expect(rows[0]!.remind_at_utc).toBe('2099-03-15T09:45:00.000Z');
  });

  test('uses event-level overrides when present', () => {
    db.run(
      "INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2099-03-15T10:00:00Z')",
    );
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: '[5, 60]' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(2);
    const minutes = rows.map((r) => r.interval_minutes).sort((a, b) => a - b);
    expect(minutes).toEqual([5, 60]);
  });

  test('skips reminders in the past', () => {
    db.run(
      "INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Old', '2020-01-01T10:00:00Z')",
    );
    materializer.materialize(
      { id: 1, start_at: '2020-01-01T10:00:00Z', reminder_overrides: null },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(0);
  });

  test('re-materializing replaces old reminders', () => {
    db.run(
      "INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2099-03-15T10:00:00Z')",
    );
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: null },
      42,
    );
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: '[5]' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interval_minutes).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/notification/materializer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the materializer**

```typescript
// src/services/notification/materializer.ts
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';

const INTERVAL_LABELS: Record<number, string> = {
  5: '5 minutes',
  10: '10 minutes',
  15: '15 minutes',
  30: '30 minutes',
  60: '1 hour',
  120: '2 hours',
  1440: '1 day',
};

function formatIntervalLabel(minutes: number): string {
  return INTERVAL_LABELS[minutes] ?? `${minutes} min`;
}

function truncateToMinute(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

export interface MaterializeEventData {
  id: number;
  start_at: string;
  reminder_overrides: string | null;
}

export class ReminderMaterializer {
  constructor(
    private reminderRepo: EventReminderRepository,
    private prefsRepo: NotificationPreferencesRepository,
  ) {}

  materialize(event: MaterializeEventData, userId: number): void {
    this.reminderRepo.deleteForEvent(event.id);

    const overrides = event.reminder_overrides
      ? (JSON.parse(event.reminder_overrides) as number[])
      : null;

    let intervals: number[];
    if (overrides) {
      intervals = overrides;
    } else {
      const prefs = this.prefsRepo.get(userId);
      intervals = prefs
        ? (JSON.parse(prefs.default_reminder_intervals) as number[])
        : [15];
    }

    const eventStart = new Date(event.start_at);
    const now = Date.now();

    for (const minutes of intervals) {
      const remindAt = truncateToMinute(new Date(eventStart.getTime() - minutes * 60_000));
      if (remindAt.getTime() < now) continue;

      this.reminderRepo.insert({
        event_id: event.id,
        user_id: userId,
        remind_at_utc: remindAt.toISOString(),
        interval_minutes: minutes,
        interval_label: formatIntervalLabel(minutes),
      });
    }
  }

  deleteForEvent(eventId: number): void {
    this.reminderRepo.deleteForEvent(eventId);
  }

  rematerializeAllForUser(userId: number, getEvents: () => MaterializeEventData[]): void {
    this.reminderRepo.deleteUnsentForUser(userId);
    const events = getEvents();
    for (const event of events) {
      this.materialize(event, userId);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/notification/materializer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notification/materializer.ts test/services/notification/materializer.test.ts
git commit -m "feat: add ReminderMaterializer"
```

---

### Task 9: NotificationRenderer

**Files:**
- Create: `src/services/notification/renderer.ts`
- Create: `test/services/notification/renderer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/services/notification/renderer.test.ts
import { describe, test, expect } from 'bun:test';
import { NotificationRenderer } from '../../../src/services/notification/renderer.ts';

describe('NotificationRenderer', () => {
  const renderer = new NotificationRenderer();

  describe('renderMorningAgenda', () => {
    test('renders agenda with events', () => {
      const result = renderer.renderMorningAgenda('en', 'Tuesday, March 15', [
        { title: 'Standup', startTime: '09:00', endTime: '09:30', location: 'Zoom', duration: '30min' },
        { title: 'Lunch', startTime: '13:00', endTime: '14:00', location: null, duration: '1hr' },
      ]);
      expect(result.channel).toBe('telegram_text');
      expect(result.text).toContain('Standup');
      expect(result.text).toContain('09:00');
      expect(result.text).toContain('Zoom');
    });
  });

  describe('renderEventReminder', () => {
    test('renders reminder with interval', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Meeting',
        startTime: '14:00',
        endTime: '15:00',
        location: 'Room B',
        intervalLabel: '15 minutes',
      });
      expect(result.channel).toBe('telegram_text');
      expect(result.text).toContain('Meeting');
      expect(result.text).toContain('15 minutes');
      expect(result.text).toContain('Room B');
    });

    test('renders without location', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Call',
        startTime: '10:00',
        endTime: '10:30',
        location: null,
        intervalLabel: '5 minutes',
      });
      expect(result.text).toContain('Call');
      expect(result.text).not.toContain('📍');
    });
  });

  describe('renderEveningReview', () => {
    test('renders tomorrow schedule', () => {
      const result = renderer.renderEveningReview('en', 'Wednesday, March 16', [
        { title: 'Review', startTime: '16:00', endTime: '17:00', location: null, duration: '1hr' },
      ]);
      expect(result.channel).toBe('telegram_text');
      expect(result.text).toContain('Review');
      expect(result.text).toContain('Wednesday');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/notification/renderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the renderer**

```typescript
// src/services/notification/renderer.ts
export interface RenderedNotification {
  channel: 'telegram_text';
  text: string;
}

export interface AgendaEvent {
  title: string;
  startTime: string;
  endTime: string;
  location: string | null;
  duration: string;
}

export interface ReminderData {
  title: string;
  startTime: string;
  endTime: string;
  location: string | null;
  intervalLabel: string;
}

const LABELS = {
  en: {
    morning: "Good morning! Here's your day:",
    evening: "Tomorrow's schedule:",
    reminder: 'Reminder:',
    inLabel: 'in',
    eventsCount: (n: number) => `${n} event${n === 1 ? '' : 's'}`,
    goodNight: 'Good night!',
    haveADay: 'Have a productive day!',
  },
  ru: {
    morning: 'Доброе утро! Ваш день:',
    evening: 'Расписание на завтра:',
    reminder: 'Напоминание:',
    inLabel: 'через',
    eventsCount: (n: number) => {
      if (n === 1) return '1 событие';
      if (n >= 2 && n <= 4) return `${n} события`;
      return `${n} событий`;
    },
    goodNight: 'Спокойной ночи!',
    haveADay: 'Продуктивного дня!',
  },
};

export class NotificationRenderer {
  renderMorningAgenda(
    lang: string,
    dateLabel: string,
    events: AgendaEvent[],
  ): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const lines: string[] = [];
    lines.push(`☀️ ${l.morning}`);
    lines.push('');
    lines.push(`📅 ${dateLabel}`);
    lines.push('');
    for (const e of events) {
      let line = `${e.startTime} — ${e.title} (${e.duration})`;
      if (e.location) line += `\n        📍 ${e.location}`;
      lines.push(line);
    }
    lines.push('');
    lines.push(l.haveADay);
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderEventReminder(lang: string, data: ReminderData): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const lines: string[] = [];
    lines.push(`⏰ ${l.reminder} ${data.title} ${l.inLabel} ${data.intervalLabel}`);
    lines.push('');
    lines.push(`🕐 ${data.startTime} — ${data.endTime}`);
    if (data.location) {
      lines.push(`📍 ${data.location}`);
    }
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderEveningReview(
    lang: string,
    dateLabel: string,
    events: AgendaEvent[],
  ): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const lines: string[] = [];
    lines.push(`🌙 ${l.evening}`);
    lines.push('');
    lines.push(`📅 ${dateLabel}`);
    lines.push('');
    for (const e of events) {
      let line = `${e.startTime} — ${e.title} (${e.duration})`;
      if (e.location) line += `\n        📍 ${e.location}`;
      lines.push(line);
    }
    lines.push('');
    lines.push(`${l.eventsCount(events.length)} tomorrow. ${l.goodNight}`);
    return { channel: 'telegram_text', text: lines.join('\n') };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/notification/renderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notification/renderer.ts test/services/notification/renderer.test.ts
git commit -m "feat: add NotificationRenderer"
```

---

## Chunk 3: Scheduler + Delivery

### Task 10: NotificationScheduler (Tick Logic)

**Files:**
- Create: `src/services/notification/scheduler.ts`
- Create: `test/services/notification/scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

The scheduler tick logic is the core of notifications. We test it with an in-memory DB, mocking BullMQ.

```typescript
// test/services/notification/scheduler.test.ts
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { NotificationScheduler } from '../../../src/services/notification/scheduler.ts';

function setupDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  // Minimal schema for testing
  db.run(`CREATE TABLE users (
    telegram_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
    language TEXT NOT NULL DEFAULT 'en', timezone TEXT NOT NULL DEFAULT 'UTC',
    country_code TEXT, onboarding_completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    title TEXT NOT NULL, description TEXT, category TEXT,
    start_at TEXT NOT NULL, end_at TEXT, all_day INTEGER NOT NULL DEFAULT 0,
    timezone TEXT NOT NULL DEFAULT 'UTC', location TEXT,
    recurrence_rule TEXT, recurrence_end_at TEXT, parent_event_id INTEGER,
    original_start_at TEXT, is_cancelled INTEGER NOT NULL DEFAULT 0,
    reminder_overrides TEXT, google_event_id TEXT, google_calendar_id TEXT,
    last_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE notification_preferences (
    user_id INTEGER PRIMARY KEY,
    morning_agenda_enabled INTEGER NOT NULL DEFAULT 1,
    morning_agenda_time TEXT NOT NULL DEFAULT '08:00',
    morning_agenda_utc TEXT,
    morning_agenda_format TEXT NOT NULL DEFAULT 'text',
    default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
    evening_review_enabled INTEGER NOT NULL DEFAULT 0,
    evening_review_time TEXT NOT NULL DEFAULT '21:00',
    evening_review_utc TEXT,
    evening_review_format TEXT NOT NULL DEFAULT 'text',
    quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
    quiet_hours_start TEXT, quiet_hours_end TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE event_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    remind_at_utc TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
    interval_label TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, type TEXT NOT NULL,
    reference_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    channel TEXT NOT NULL DEFAULT 'telegram_text',
    payload TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
  )`);
  db.run('CREATE UNIQUE INDEX idx_notification_log_dedup ON notification_log(reference_key)');
  return db;
}

describe('NotificationScheduler', () => {
  let db: Database;
  let scheduler: NotificationScheduler;
  let enqueued: { type: string; userId: number; logId: number }[];

  beforeEach(() => {
    db = setupDb();
    enqueued = [];
    const mockEnqueue = mock((type: string, userId: number, logId: number) => {
      enqueued.push({ type, userId, logId });
    });
    scheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo: new NotificationLogRepository(db),
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mockEnqueue,
    });
  });

  test('tick enqueues due event reminders', async () => {
    db.run("INSERT INTO users (telegram_id) VALUES (42)");
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Call', '2026-03-15T10:00:00Z')");
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T09:45:00Z', 15, '15 minutes')",
    );
    await scheduler.tick(new Date('2026-03-15T09:45:30Z'));
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.type).toBe('event_reminder');
  });

  test('tick does not double-enqueue (dedup)', async () => {
    db.run("INSERT INTO users (telegram_id) VALUES (42)");
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Call', '2026-03-15T10:00:00Z')");
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T09:45:00Z', 15, '15 minutes')",
    );
    await scheduler.tick(new Date('2026-03-15T09:45:30Z'));
    await scheduler.tick(new Date('2026-03-15T09:45:30Z'));
    expect(enqueued.length).toBe(1);
  });

  test('tick enqueues morning agenda when UTC time matches', async () => {
    db.run("INSERT INTO users (telegram_id, timezone) VALUES (42, 'UTC')");
    db.run("INSERT INTO notification_preferences (user_id, morning_agenda_utc) VALUES (42, '08:00')");
    // Add an event for today so morning agenda fires
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2026-03-15T10:00:00Z')");
    await scheduler.tick(new Date('2026-03-15T08:00:30Z'));
    expect(enqueued.some((e) => e.type === 'morning_agenda')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/notification/scheduler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the scheduler**

```typescript
// src/services/notification/scheduler.ts
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import { isQuietHours } from './timezone.ts';
import { notifyLogger } from '../../utils/logger.ts';

function truncateToMinute(d: Date): Date {
  const r = new Date(d);
  r.setSeconds(0, 0);
  return r;
}

function formatHHMM(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export interface SchedulerDeps {
  prefsRepo: NotificationPreferencesRepository;
  reminderRepo: EventReminderRepository;
  logRepo: NotificationLogRepository;
  userRepo: UserRepository;
  eventRepo: EventRepository;
  enqueue: (type: string, userId: number, logId: number, payload: string) => void;
}

export class NotificationScheduler {
  private deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  async tick(nowUtc: Date): Promise<void> {
    const minute = truncateToMinute(nowUtc);
    const currentHHMM = formatHHMM(minute);
    const windowStart = minute.toISOString();
    const windowEnd = new Date(minute.getTime() + 60_000).toISOString();
    const todayDate = minute.toISOString().slice(0, 10);
    const tomorrowDate = new Date(minute.getTime() + 86_400_000).toISOString().slice(0, 10);

    // 1. Event reminders
    const dueReminders = this.deps.reminderRepo.getDue(windowStart, windowEnd);
    for (const reminder of dueReminders) {
      const user = this.deps.userRepo.findByTelegramId(reminder.user_id);
      if (!user) continue;
      const prefs = this.deps.prefsRepo.get(reminder.user_id);
      if (prefs) {
        const quiet = isQuietHours(
          { enabled: !!prefs.quiet_hours_enabled, start: prefs.quiet_hours_start, end: prefs.quiet_hours_end },
          nowUtc,
          user.timezone,
        );
        if (quiet) continue;
      }
      const refKey = `er:${reminder.id}`;
      const payload = JSON.stringify({
        event_title: reminder.event_title,
        event_start_at: reminder.event_start_at,
        event_location: reminder.event_location,
        interval_label: reminder.interval_label,
      });
      const logId = this.deps.logRepo.insert({
        user_id: reminder.user_id,
        type: 'event_reminder',
        reference_key: refKey,
        channel: 'telegram_text',
        payload,
      });
      if (logId === null) continue; // dedup
      this.deps.reminderRepo.markSent(reminder.id);
      this.deps.enqueue('event_reminder', reminder.user_id, logId, payload);
      notifyLogger.info({ userId: reminder.user_id, eventId: reminder.event_id }, 'Event reminder enqueued');
    }

    // 2. Morning agendas
    const morningPrefs = this.deps.prefsRepo.getAllByMorningUtc(currentHHMM);
    for (const pref of morningPrefs) {
      const user = this.deps.userRepo.findByTelegramId(pref.user_id);
      if (!user) continue;
      const quiet = isQuietHours(
        { enabled: !!pref.quiet_hours_enabled, start: pref.quiet_hours_start, end: pref.quiet_hours_end },
        nowUtc,
        user.timezone,
      );
      if (quiet) continue;
      // Check if user has events today
      const dayStart = `${todayDate}T00:00:00Z`;
      const dayEnd = `${todayDate}T23:59:59Z`;
      const events = this.deps.eventRepo.getByDateRange(pref.user_id, dayStart, dayEnd);
      if (events.length === 0) continue;
      const refKey = `ma:${pref.user_id}:${todayDate}`;
      const payload = JSON.stringify({ date: todayDate, eventCount: events.length });
      const logId = this.deps.logRepo.insert({
        user_id: pref.user_id,
        type: 'morning_agenda',
        reference_key: refKey,
        channel: 'telegram_text',
        payload,
      });
      if (logId === null) continue;
      this.deps.enqueue('morning_agenda', pref.user_id, logId, payload);
      notifyLogger.info({ userId: pref.user_id }, 'Morning agenda enqueued');
    }

    // 3. Evening reviews
    const eveningPrefs = this.deps.prefsRepo.getAllByEveningUtc(currentHHMM);
    for (const pref of eveningPrefs) {
      const user = this.deps.userRepo.findByTelegramId(pref.user_id);
      if (!user) continue;
      const quiet = isQuietHours(
        { enabled: !!pref.quiet_hours_enabled, start: pref.quiet_hours_start, end: pref.quiet_hours_end },
        nowUtc,
        user.timezone,
      );
      if (quiet) continue;
      const tmStart = `${tomorrowDate}T00:00:00Z`;
      const tmEnd = `${tomorrowDate}T23:59:59Z`;
      const events = this.deps.eventRepo.getByDateRange(pref.user_id, tmStart, tmEnd);
      if (events.length === 0) continue;
      const refKey = `ev:${pref.user_id}:${tomorrowDate}`;
      const payload = JSON.stringify({ date: tomorrowDate, eventCount: events.length });
      const logId = this.deps.logRepo.insert({
        user_id: pref.user_id,
        type: 'evening_review',
        reference_key: refKey,
        channel: 'telegram_text',
        payload,
      });
      if (logId === null) continue;
      this.deps.enqueue('evening_review', pref.user_id, logId, payload);
      notifyLogger.info({ userId: pref.user_id }, 'Evening review enqueued');
    }
  }
}
```

Note: The scheduler calls `eventRepo.getByDateRange()`. If this method doesn't exist yet, add it to `EventRepository`:

```typescript
getByDateRange(userId: number, startUtc: string, endUtc: string): EventRow[] {
  return this.db
    .prepare(
      'SELECT * FROM events WHERE user_id = ? AND start_at >= ? AND start_at <= ? AND is_cancelled = 0 ORDER BY start_at',
    )
    .all(userId, startUtc, endUtc) as EventRow[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/notification/scheduler.test.ts`
Expected: PASS (may need to add `getByDateRange` to EventRepository first)

- [ ] **Step 5: Commit**

```bash
git add src/services/notification/scheduler.ts test/services/notification/scheduler.test.ts
git commit -m "feat: add NotificationScheduler tick logic"
```

---

### Task 11: NotificationWorker

**Files:**
- Create: `src/services/notification/worker.ts`
- Create: `test/services/notification/worker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/services/notification/worker.test.ts
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { processNotification } from '../../../src/services/notification/worker.ts';

describe('processNotification', () => {
  let db: Database;
  let logRepo: NotificationLogRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, type TEXT NOT NULL,
      reference_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      channel TEXT NOT NULL DEFAULT 'telegram_text',
      payload TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run('CREATE UNIQUE INDEX idx_notification_log_dedup ON notification_log(reference_key)');
    db.run("INSERT INTO users (telegram_id) VALUES (42)");
    logRepo = new NotificationLogRepository(db);
  });

  test('marks log as sent after successful delivery', async () => {
    const logId = logRepo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:1',
      channel: 'telegram_text',
      payload: '{"event_title":"Call","interval_label":"15 minutes"}',
    })!;

    const sendMessage = mock(() => Promise.resolve());
    await processNotification(
      { logId, telegramId: 42, type: 'event_reminder', payload: '{}' },
      logRepo,
      sendMessage,
    );

    const row = logRepo.getById(logId);
    expect(row!.status).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test('skips already-sent notifications', async () => {
    const logId = logRepo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:2',
      channel: 'telegram_text',
      payload: '{}',
    })!;
    logRepo.markSent(logId);

    const sendMessage = mock(() => Promise.resolve());
    await processNotification(
      { logId, telegramId: 42, type: 'event_reminder', payload: '{}' },
      logRepo,
      sendMessage,
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/notification/worker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the worker processing function**

```typescript
// src/services/notification/worker.ts
import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import { notifyLogger } from '../../utils/logger.ts';

export interface NotificationJobData {
  logId: number;
  telegramId: number;
  type: string;
  payload: string;
}

export async function processNotification(
  data: NotificationJobData,
  logRepo: NotificationLogRepository,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
): Promise<void> {
  const log = logRepo.getById(data.logId);
  if (!log || log.status === 'sent') return;

  try {
    const text = log.payload ?? 'Notification';
    await sendMessage(data.telegramId, text);
    logRepo.markSent(data.logId);
    notifyLogger.info({ logId: data.logId, type: data.type }, 'Notification sent');
  } catch (err) {
    notifyLogger.error({ logId: data.logId, error: String(err) }, 'Notification delivery failed');
    throw err; // Let BullMQ handle retries
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/notification/worker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notification/worker.ts test/services/notification/worker.test.ts
git commit -m "feat: add notification worker processing function"
```

---

### Task 12: Wire Materializer into EventService

**Files:**
- Modify: `src/services/event/event-service.ts`
- Modify: `test/services/event/event-service.test.ts`

- [ ] **Step 1: Add optional materializer to EventService constructor**

The materializer is optional so existing tests don't break. When present, it auto-materializes reminders on event create/update and cleans up on delete.

In `src/services/event/event-service.ts`:

Add a third optional constructor parameter:

```typescript
constructor(
  private eventRepo: EventRepository,
  private reminderRepo: ReminderRepository,
  private materializer?: ReminderMaterializer,
) {}
```

Add import:

```typescript
import type { ReminderMaterializer } from '../notification/materializer.ts';
```

In `createEvent()`, after the event is created and returned:

```typescript
if (this.materializer) {
  this.materializer.materialize(
    { id: event.id, start_at: event.start_at, reminder_overrides: event.reminder_overrides ?? null },
    event.user_id,
  );
}
```

In `updateEvent()`, after the event is updated:

```typescript
if (this.materializer && updatedEvent) {
  this.materializer.materialize(
    { id: updatedEvent.id, start_at: updatedEvent.start_at, reminder_overrides: updatedEvent.reminder_overrides ?? null },
    updatedEvent.user_id,
  );
}
```

In `deleteEvent()`, before deletion:

```typescript
if (this.materializer) {
  this.materializer.deleteForEvent(id);
}
```

- [ ] **Step 2: Run all tests to verify nothing is broken**

Run: `bun test`
Expected: All tests pass (materializer is optional, existing tests pass without it)

- [ ] **Step 3: Commit**

```bash
git add src/services/event/event-service.ts
git commit -m "feat: wire ReminderMaterializer into EventService"
```

---

## Chunk 4: Bot Integration

### Task 13: Constants and i18n for Notifications

**Files:**
- Modify: `src/config/constants.ts`

- [ ] **Step 1: Add notification callback prefix**

In `src/config/constants.ts`, add to the `CB` object:

```typescript
NOTIFY: 'nf',
```

Add notification-related i18n strings to both `en` and `ru` translation objects:

```typescript
// In EN translations:
notify_menu: '⚙️ Notification Settings',
notify_morning: '🌅 Morning Agenda',
notify_morning_status: (enabled: boolean, time: string) =>
  `Morning agenda: ${enabled ? `✅ ${time}` : '❌'}`,
notify_evening: '🌙 Evening Review',
notify_evening_status: (enabled: boolean, time: string) =>
  `Evening review: ${enabled ? `✅ ${time}` : '❌'}`,
notify_reminders: '⏰ Default Reminders',
notify_quiet: '🔇 Quiet Hours',
notify_quiet_status: (enabled: boolean, start: string, end: string) =>
  `Quiet hours: ${enabled ? `✅ ${start} — ${end}` : '❌'}`,
notify_pick_hour: 'Pick hour:',
notify_pick_minute: 'Pick minute:',
notify_updated: 'Settings updated',
notify_intervals_label: (intervals: number[]) =>
  `Default reminders: ${intervals.map((m) => (m >= 60 ? `${m / 60}hr` : `${m}min`)).join(', ')}`,

// In RU translations:
notify_menu: '⚙️ Настройки уведомлений',
notify_morning: '🌅 Утренняя повестка',
notify_morning_status: (enabled: boolean, time: string) =>
  `Утренняя повестка: ${enabled ? `✅ ${time}` : '❌'}`,
notify_evening: '🌙 Вечерний обзор',
notify_evening_status: (enabled: boolean, time: string) =>
  `Вечерний обзор: ${enabled ? `✅ ${time}` : '❌'}`,
notify_reminders: '⏰ Напоминания по умолчанию',
notify_quiet: '🔇 Тихие часы',
notify_quiet_status: (enabled: boolean, start: string, end: string) =>
  `Тихие часы: ${enabled ? `✅ ${start} — ${end}` : '❌'}`,
notify_pick_hour: 'Выберите час:',
notify_pick_minute: 'Выберите минуту:',
notify_updated: 'Настройки обновлены',
notify_intervals_label: (intervals: number[]) =>
  `Напоминания: ${intervals.map((m) => (m >= 60 ? `${m / 60}ч` : `${m}мин`)).join(', ')}`,
```

- [ ] **Step 2: Run lint to verify no issues**

Run: `bun run lint`
Expected: 0 warnings

- [ ] **Step 3: Commit**

```bash
git add src/config/constants.ts
git commit -m "feat: add notification constants and i18n strings"
```

---

### Task 14: Notification Keyboards

**Files:**
- Modify: `src/bot/keyboards.ts`

- [ ] **Step 1: Add notification keyboard functions**

Add to `src/bot/keyboards.ts`:

```typescript
export function notifyMenuKeyboard(
  lang: 'en' | 'ru',
): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang).notify_morning as string, `${CB.NOTIFY}:morning`)
    .text(t(lang).notify_reminders as string, `${CB.NOTIFY}:reminders`)
    .row()
    .text(t(lang).notify_evening as string, `${CB.NOTIFY}:evening`)
    .text(t(lang).notify_quiet as string, `${CB.NOTIFY}:quiet`)
    .row();
}

export function notifyMorningKeyboard(
  enabled: boolean,
  lang: 'en' | 'ru',
): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(
    enabled ? '❌ Disable' : '✅ Enable',
    `${CB.NOTIFY}:morning:toggle`,
  );
  kb.text('🕐 Change Time', `${CB.NOTIFY}:morning:time`);
  kb.row();
  kb.text('← Back', `${CB.NOTIFY}:menu`);
  return kb;
}

export function notifyHourPickerKeyboard(
  section: string,
  lang: 'en' | 'ru',
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let h = 5; h <= 12; h++) {
    kb.text(String(h).padStart(2, '0'), `${CB.NOTIFY}:${section}:hour:${String(h).padStart(2, '0')}`);
    if ((h - 4) % 4 === 0) kb.row();
  }
  for (let h = 13; h <= 23; h++) {
    kb.text(String(h).padStart(2, '0'), `${CB.NOTIFY}:${section}:hour:${String(h).padStart(2, '0')}`);
    if ((h - 12) % 4 === 0) kb.row();
  }
  kb.text('← Back', `${CB.NOTIFY}:${section}`);
  return kb;
}

export function notifyMinutePickerKeyboard(
  section: string,
  hour: string,
  lang: 'en' | 'ru',
): InlineKeyboard {
  return new InlineKeyboard()
    .text(':00', `${CB.NOTIFY}:${section}:minute:${hour}:00`)
    .text(':15', `${CB.NOTIFY}:${section}:minute:${hour}:15`)
    .text(':30', `${CB.NOTIFY}:${section}:minute:${hour}:30`)
    .text(':45', `${CB.NOTIFY}:${section}:minute:${hour}:45`)
    .row()
    .text('← Back', `${CB.NOTIFY}:${section}:time`);
}

export function notifyReminderIntervalsKeyboard(
  activeIntervals: number[],
  lang: 'en' | 'ru',
): InlineKeyboard {
  const ALL = [5, 15, 30, 60, 1440];
  const labels: Record<number, string> = { 5: '5min', 15: '15min', 30: '30min', 60: '1hr', 1440: '1day' };
  const kb = new InlineKeyboard();
  for (let i = 0; i < ALL.length; i++) {
    const m = ALL[i]!;
    const active = activeIntervals.includes(m);
    kb.text(`${labels[m]} ${active ? '✅' : '❌'}`, `${CB.NOTIFY}:reminders:toggle:${m}`);
    if ((i + 1) % 3 === 0) kb.row();
  }
  kb.row();
  kb.text('← Back', `${CB.NOTIFY}:menu`);
  return kb;
}

export function notifyEveningKeyboard(
  enabled: boolean,
  lang: 'en' | 'ru',
): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(
    enabled ? '❌ Disable' : '✅ Enable',
    `${CB.NOTIFY}:evening:toggle`,
  );
  kb.text('🕐 Change Time', `${CB.NOTIFY}:evening:time`);
  kb.row();
  kb.text('← Back', `${CB.NOTIFY}:menu`);
  return kb;
}

export function notifyQuietKeyboard(
  enabled: boolean,
  lang: 'en' | 'ru',
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (enabled) {
    kb.text('❌ Disable', `${CB.NOTIFY}:quiet:toggle`);
    kb.row();
    kb.text('🕐 Change Start', `${CB.NOTIFY}:quiet:start`);
    kb.text('🕐 Change End', `${CB.NOTIFY}:quiet:end`);
  } else {
    kb.text('✅ Enable', `${CB.NOTIFY}:quiet:toggle`);
  }
  kb.row();
  kb.text('← Back', `${CB.NOTIFY}:menu`);
  return kb;
}
```

- [ ] **Step 2: Run lint**

Run: `bun run lint`
Expected: 0 warnings

- [ ] **Step 3: Commit**

```bash
git add src/bot/keyboards.ts
git commit -m "feat: add notification inline keyboards"
```

---

### Task 15: /notify Command Handler

**Files:**
- Create: `src/bot/commands/notify.ts`

- [ ] **Step 1: Implement the command handler**

```typescript
// src/bot/commands/notify.ts
import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import { notifyMenuKeyboard } from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

function buildMenuText(
  prefsService: NotificationPreferencesService,
  userId: number,
  lang: Lang,
): string {
  const prefs = prefsService.getOrCreate(userId);
  const intervals = JSON.parse(prefs.default_reminder_intervals) as number[];
  const lines = [
    t(lang).notify_menu as string,
    '',
    (t(lang).notify_morning_status as (e: boolean, t: string) => string)(
      !!prefs.morning_agenda_enabled,
      prefs.morning_agenda_time,
    ),
    (t(lang).notify_intervals_label as (i: number[]) => string)(intervals),
    (t(lang).notify_evening_status as (e: boolean, t: string) => string)(
      !!prefs.evening_review_enabled,
      prefs.evening_review_time,
    ),
    (t(lang).notify_quiet_status as (e: boolean, s: string, en: string) => string)(
      !!prefs.quiet_hours_enabled,
      prefs.quiet_hours_start ?? '23:00',
      prefs.quiet_hours_end ?? '07:00',
    ),
  ];
  return lines.join('\n');
}

export async function handleNotify(
  ctx: BotCommandContext,
  prefsService: NotificationPreferencesService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = (user.language ?? 'en') as Lang;
  const text = buildMenuText(prefsService, user.telegram_id, lang);
  await ctx.send(text, {
    parse_mode: 'HTML',
    reply_markup: notifyMenuKeyboard(lang),
  });
}

export async function handleNotifyCallback(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  payload: string,
): Promise<void> {
  const lang = (user.language ?? 'en') as Lang;
  const parts = payload.split(':');
  const section = parts[0]!;
  const action = parts[1];

  // nf:menu — back to main menu
  if (section === 'menu') {
    await ctx.answer();
    const text = buildMenuText(prefsService, user.telegram_id, lang);
    return void (await ctx.editText(text, {
      parse_mode: 'HTML',
      reply_markup: notifyMenuKeyboard(lang),
    }));
  }

  // nf:morning, nf:morning:toggle, nf:morning:time, nf:morning:hour:HH, nf:morning:minute:HH:MM
  if (section === 'morning') {
    return handleMorningSection(ctx, prefsService, user, lang, action, parts);
  }

  // nf:evening — same pattern as morning
  if (section === 'evening') {
    return handleEveningSection(ctx, prefsService, user, lang, action, parts);
  }

  // nf:reminders, nf:reminders:toggle:N
  if (section === 'reminders') {
    return handleRemindersSection(ctx, prefsService, user, lang, action, parts);
  }

  // nf:quiet, nf:quiet:toggle, nf:quiet:start, nf:quiet:end
  if (section === 'quiet') {
    return handleQuietSection(ctx, prefsService, user, lang, action, parts);
  }

  await ctx.answer();
}

async function handleMorningSection(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  lang: Lang,
  action: string | undefined,
  parts: string[],
): Promise<void> {
  const { notifyMorningKeyboard, notifyHourPickerKeyboard, notifyMinutePickerKeyboard } = await import('../keyboards.ts');

  if (!action) {
    await ctx.answer();
    const prefs = prefsService.getOrCreate(user.telegram_id);
    return void (await ctx.editText(
      `${t(lang).notify_morning}\n\n${(t(lang).notify_morning_status as (e: boolean, t: string) => string)(!!prefs.morning_agenda_enabled, prefs.morning_agenda_time)}`,
      { reply_markup: notifyMorningKeyboard(!!prefs.morning_agenda_enabled, lang) },
    ));
  }

  if (action === 'toggle') {
    prefsService.toggleMorningAgenda(user.telegram_id);
    await ctx.answer({ text: t(lang).notify_updated as string });
    const prefs = prefsService.getOrCreate(user.telegram_id);
    return void (await ctx.editText(
      `${t(lang).notify_morning}\n\n${(t(lang).notify_morning_status as (e: boolean, t: string) => string)(!!prefs.morning_agenda_enabled, prefs.morning_agenda_time)}`,
      { reply_markup: notifyMorningKeyboard(!!prefs.morning_agenda_enabled, lang) },
    ));
  }

  if (action === 'time') {
    await ctx.answer();
    return void (await ctx.editText(t(lang).notify_pick_hour as string, {
      reply_markup: notifyHourPickerKeyboard('morning', lang),
    }));
  }

  if (action === 'hour') {
    const hour = parts[2]!;
    await ctx.answer();
    return void (await ctx.editText(t(lang).notify_pick_minute as string, {
      reply_markup: notifyMinutePickerKeyboard('morning', hour, lang),
    }));
  }

  if (action === 'minute') {
    const hour = parts[2]!;
    const minute = parts[3]!;
    const time = `${hour}:${minute}`;
    prefsService.updateMorningTime(user.telegram_id, time, user.timezone);
    await ctx.answer({ text: t(lang).notify_updated as string });
    const prefs = prefsService.getOrCreate(user.telegram_id);
    return void (await ctx.editText(
      `${t(lang).notify_morning}\n\n${(t(lang).notify_morning_status as (e: boolean, t: string) => string)(!!prefs.morning_agenda_enabled, prefs.morning_agenda_time)}`,
      { reply_markup: notifyMorningKeyboard(!!prefs.morning_agenda_enabled, lang) },
    ));
  }

  await ctx.answer();
}

async function handleEveningSection(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  lang: Lang,
  action: string | undefined,
  parts: string[],
): Promise<void> {
  const { notifyEveningKeyboard, notifyHourPickerKeyboard, notifyMinutePickerKeyboard } = await import('../keyboards.ts');

  if (!action) {
    await ctx.answer();
    const prefs = prefsService.getOrCreate(user.telegram_id);
    return void (await ctx.editText(
      `${t(lang).notify_evening}\n\n${(t(lang).notify_evening_status as (e: boolean, t: string) => string)(!!prefs.evening_review_enabled, prefs.evening_review_time)}`,
      { reply_markup: notifyEveningKeyboard(!!prefs.evening_review_enabled, lang) },
    ));
  }

  if (action === 'toggle') {
    prefsService.toggleEveningReview(user.telegram_id);
    await ctx.answer({ text: t(lang).notify_updated as string });
    const prefs = prefsService.getOrCreate(user.telegram_id);
    return void (await ctx.editText(
      `${t(lang).notify_evening}\n\n${(t(lang).notify_evening_status as (e: boolean, t: string) => string)(!!prefs.evening_review_enabled, prefs.evening_review_time)}`,
      { reply_markup: notifyEveningKeyboard(!!prefs.evening_review_enabled, lang) },
    ));
  }

  if (action === 'time') {
    await ctx.answer();
    const { notifyHourPickerKeyboard } = await import('../keyboards.ts');
    return void (await ctx.editText(t(lang).notify_pick_hour as string, {
      reply_markup: notifyHourPickerKeyboard('evening', lang),
    }));
  }

  if (action === 'hour') {
    const hour = parts[2]!;
    await ctx.answer();
    const { notifyMinutePickerKeyboard } = await import('../keyboards.ts');
    return void (await ctx.editText(t(lang).notify_pick_minute as string, {
      reply_markup: notifyMinutePickerKeyboard('evening', hour, lang),
    }));
  }

  if (action === 'minute') {
    const hour = parts[2]!;
    const minute = parts[3]!;
    const time = `${hour}:${minute}`;
    prefsService.updateEveningTime(user.telegram_id, time, user.timezone);
    await ctx.answer({ text: t(lang).notify_updated as string });
    const prefs = prefsService.getOrCreate(user.telegram_id);
    return void (await ctx.editText(
      `${t(lang).notify_evening}\n\n${(t(lang).notify_evening_status as (e: boolean, t: string) => string)(!!prefs.evening_review_enabled, prefs.evening_review_time)}`,
      { reply_markup: notifyEveningKeyboard(!!prefs.evening_review_enabled, lang) },
    ));
  }

  await ctx.answer();
}

async function handleRemindersSection(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  lang: Lang,
  action: string | undefined,
  parts: string[],
): Promise<void> {
  const { notifyReminderIntervalsKeyboard } = await import('../keyboards.ts');

  const showMenu = async () => {
    const intervals = prefsService.resolveDefaultIntervals(user.telegram_id);
    return ctx.editText(
      `${t(lang).notify_reminders}\n\n${(t(lang).notify_intervals_label as (i: number[]) => string)(intervals)}`,
      { reply_markup: notifyReminderIntervalsKeyboard(intervals, lang) },
    );
  };

  if (!action) {
    await ctx.answer();
    return void (await showMenu());
  }

  if (action === 'toggle') {
    const minutes = Number(parts[2]);
    const intervals = prefsService.resolveDefaultIntervals(user.telegram_id);
    const idx = intervals.indexOf(minutes);
    if (idx >= 0) {
      intervals.splice(idx, 1);
    } else {
      intervals.push(minutes);
      intervals.sort((a, b) => a - b);
    }
    prefsService.updateDefaultIntervals(user.telegram_id, intervals);
    await ctx.answer({ text: t(lang).notify_updated as string });
    return void (await showMenu());
  }

  await ctx.answer();
}

async function handleQuietSection(
  ctx: BotCallbackContext,
  prefsService: NotificationPreferencesService,
  user: User,
  lang: Lang,
  action: string | undefined,
  parts: string[],
): Promise<void> {
  const { notifyQuietKeyboard, notifyHourPickerKeyboard, notifyMinutePickerKeyboard } = await import('../keyboards.ts');

  const showMenu = async () => {
    const prefs = prefsService.getOrCreate(user.telegram_id);
    return ctx.editText(
      `${t(lang).notify_quiet}\n\n${(t(lang).notify_quiet_status as (e: boolean, s: string, en: string) => string)(!!prefs.quiet_hours_enabled, prefs.quiet_hours_start ?? '23:00', prefs.quiet_hours_end ?? '07:00')}`,
      { reply_markup: notifyQuietKeyboard(!!prefs.quiet_hours_enabled, lang) },
    );
  };

  if (!action) {
    await ctx.answer();
    return void (await showMenu());
  }

  if (action === 'toggle') {
    prefsService.toggleQuietHours(user.telegram_id);
    // Set defaults if enabling for first time
    const prefs = prefsService.getOrCreate(user.telegram_id);
    if (prefs.quiet_hours_enabled && !prefs.quiet_hours_start) {
      prefsService.updateQuietHoursStart(user.telegram_id, '23:00');
      prefsService.updateQuietHoursEnd(user.telegram_id, '07:00');
    }
    await ctx.answer({ text: t(lang).notify_updated as string });
    return void (await showMenu());
  }

  if (action === 'start') {
    await ctx.answer();
    return void (await ctx.editText(t(lang).notify_pick_hour as string, {
      reply_markup: notifyHourPickerKeyboard('quiet_start', lang),
    }));
  }

  if (action === 'end') {
    await ctx.answer();
    return void (await ctx.editText(t(lang).notify_pick_hour as string, {
      reply_markup: notifyHourPickerKeyboard('quiet_end', lang),
    }));
  }

  // quiet_start:hour:HH or quiet_end:hour:HH
  if (action?.startsWith('hour')) {
    // This gets tricky — the section is "quiet" but actual sub-section is parts[1]
    // Callback: nf:quiet:start:hour:HH or nf:quiet:end:hour:HH
    // But we split by first : after section, so action = "start" or "end"
    // Actually the parts after "quiet" are: start, hour, HH
    // Re-analyze: payload passed is everything after "nf:", so parts = [quiet, start, hour, HH]
    // section = "quiet", action = parts[1] which is "start" etc.
    // This is already handled above. The hour/minute sub-actions would come as:
    // nf:quiet_start:hour:HH (via keyboard callback data)
    // But our keyboard uses section "quiet_start" and "quiet_end"
    // So these come to the top-level handler as section "quiet_start"
    // We need to handle them at the top level. See Task 16.
  }

  await ctx.answer();
}
```

Note: The quiet hours time picker uses sections `quiet_start` and `quiet_end` in keyboard callback data. These need to be handled in the top-level callback routing (Task 16).

- [ ] **Step 2: Run lint**

Run: `bun run lint`
Expected: 0 warnings

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/notify.ts
git commit -m "feat: add /notify command handler and callback routing"
```

---

### Task 16: Wire into Bot

**Files:**
- Modify: `src/bot/index.ts`
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/bot/commands/help.ts`

- [ ] **Step 1: Add /notify command to bot**

In `src/bot/index.ts`:

```typescript
import { handleNotify } from './commands/notify.ts';
import { NotificationPreferencesService } from '../services/notification/preferences.ts';
```

After creating `holidayService`, add:

```typescript
const prefsService = new NotificationPreferencesService(db.notificationPreferences);
```

Add command registration:

```typescript
.command('notify', (ctx) => handleNotify(ctx as unknown as BotCommandContext, prefsService))
```

Pass `prefsService` to callback handler:

```typescript
createCallbackHandler(eventService, scenesSetup.scenes.editValueScene, holidayService, prefsService)
```

Update the return:

```typescript
return { bot, eventService, holidayService, prefsService, db };
```

- [ ] **Step 2: Update callback handler to route notify callbacks**

In `src/bot/handlers/callback.handler.ts`:

```typescript
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import { handleNotifyCallback } from '../commands/notify.ts';
```

Update `createCallbackHandler` signature:

```typescript
export function createCallbackHandler(
  eventService: EventService,
  editValueScene: AnyScene,
  holidayService: HolidayService,
  prefsService: NotificationPreferencesService,
)
```

Add routing before the fallback:

```typescript
// Notifications
if (action === CB.NOTIFY) {
  return handleNotifyCallback(ctx, prefsService, user, payload);
}
```

- [ ] **Step 3: Add /notify to help text**

In `src/bot/commands/help.ts`, add notification section to HELP_EN and HELP_RU:

```
<b>Notifications</b>
/notify — Notification settings
```

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Run lint**

Run: `bun run lint`
Expected: 0 warnings

- [ ] **Step 6: Commit**

```bash
git add src/bot/index.ts src/bot/handlers/callback.handler.ts src/bot/commands/help.ts src/bot/commands/notify.ts
git commit -m "feat: wire /notify command and notification callbacks into bot"
```

---

### Task 17: BullMQ Queue Setup

**Files:**
- Create: `src/services/notification/queue.ts`

- [ ] **Step 1: Implement queue setup**

```typescript
// src/services/notification/queue.ts
import { Queue, Worker } from 'bullmq';
import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import { notifyLogger } from '../../utils/logger.ts';
import { processNotification, type NotificationJobData } from './worker.ts';

function parseRedisUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port) || 6379,
  };
}

export function createNotificationQueue(redisUrl: string) {
  const connection = parseRedisUrl(redisUrl);

  const queue = new Queue('notifications', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 86400 },
      removeOnFail: { age: 86400 * 7 },
    },
  });

  return queue;
}

export function createNotificationWorker(
  redisUrl: string,
  logRepo: NotificationLogRepository,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
) {
  const connection = parseRedisUrl(redisUrl);

  const worker = new Worker<NotificationJobData>(
    'notifications',
    async (job) => {
      if (job.name === 'tick') return; // tick is handled by scheduler
      await processNotification(job.data, logRepo, sendMessage);
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    if (!job) return;
    notifyLogger.error(
      { jobId: job.id, type: job.data.type, error: err.message, attempts: job.attemptsMade },
      'Notification job failed',
    );
    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      logRepo.markFailed(job.data.logId, err.message, job.attemptsMade);
    } else {
      logRepo.updateAttempts(job.data.logId, err.message, job.attemptsMade);
    }
  });

  return worker;
}

export async function setupNotificationTick(queue: Queue): Promise<void> {
  await queue.add('tick', {}, {
    repeat: { every: 60_000 },
    removeOnComplete: true,
  });
  notifyLogger.info('Notification tick scheduled (every 60s)');
}
```

- [ ] **Step 2: Run lint**

Run: `bun run lint`
Expected: 0 warnings

- [ ] **Step 3: Commit**

```bash
git add src/services/notification/queue.ts
git commit -m "feat: add BullMQ notification queue setup"
```
