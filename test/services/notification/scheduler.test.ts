import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { NotificationScheduler } from '../../../src/services/notification/scheduler.ts';

function setupDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
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
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Call', '2026-03-15T10:00:00Z')");
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T09:45:00Z', 15, '15 minutes')",
    );
    await scheduler.tick(new Date('2026-03-15T09:45:30Z'));
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.type).toBe('event_reminder');
  });

  test('tick does not double-enqueue (dedup)', async () => {
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
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
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2026-03-15T10:00:00Z')");
    await scheduler.tick(new Date('2026-03-15T08:00:30Z'));
    expect(enqueued.some((e) => e.type === 'morning_agenda')).toBe(true);
  });
});
