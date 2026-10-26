> Part 1 of 4 of [Notifications Implementation Plan](../2026-03-13-notifications.md) — next: [02-tasks-6-9.md](02-tasks-6-9.md)

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

