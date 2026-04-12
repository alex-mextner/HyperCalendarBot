import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import type { EventOccurrence } from '../../../src/database/types.ts';
import { NotificationScheduler } from '../../../src/services/notification/scheduler.ts';

function wrapGetEventsInRange(
  eventRepo: EventRepository,
): (userId: number, startUtc: string, endUtc: string) => EventOccurrence[] {
  return (userId, startUtc, endUtc) =>
    eventRepo.getInRange(userId, startUtc, endUtc).map((event) => ({
      event,
      occurrence_start: event.start_at,
      occurrence_end: event.end_at,
      is_exception: false,
    }));
}

function setupDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE users (
    telegram_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
    language TEXT NOT NULL DEFAULT 'en', timezone TEXT NOT NULL DEFAULT 'UTC',
    country_code TEXT, google_refresh_token_enc TEXT,
    voice_response_enabled INTEGER DEFAULT NULL,
    onboarding_completed INTEGER NOT NULL DEFAULT 0,
    timezone_updated_at TEXT,
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
    is_deleted INTEGER NOT NULL DEFAULT 0,
    owner_type TEXT NOT NULL DEFAULT 'user', group_id INTEGER, created_by INTEGER,
    reminder_overrides TEXT, google_event_id TEXT, google_calendar_id TEXT,
    resolved_address TEXT, latitude REAL, longitude REAL,
    google_maps_url TEXT, venue_name TEXT, location_verified INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE notification_preferences (
    user_id INTEGER PRIMARY KEY,
    morning_agenda_enabled INTEGER NOT NULL DEFAULT 1,
    morning_agenda_time TEXT NOT NULL DEFAULT '08:00',
    morning_agenda_format TEXT NOT NULL DEFAULT 'text',
    default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
    evening_review_enabled INTEGER NOT NULL DEFAULT 0,
    evening_review_time TEXT NOT NULL DEFAULT '21:00',
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
    occurrence_start TEXT, occurrence_end TEXT,
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
  db.run(`CREATE TABLE holiday_countries (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE holidays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    country_code TEXT NOT NULL, date TEXT NOT NULL,
    name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'public', year INTEGER NOT NULL,
    FOREIGN KEY (country_code) REFERENCES holiday_countries(code) ON DELETE CASCADE
  )`);
  db.run(`CREATE UNIQUE INDEX idx_holidays_unique ON holidays(country_code, date, name)`);
  db.run(`CREATE TABLE holiday_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, country_code TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    notify INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
    FOREIGN KEY (country_code) REFERENCES holiday_countries(code) ON DELETE CASCADE,
    UNIQUE(user_id, country_code)
  )`);
  db.run(`CREATE TABLE holiday_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL, date TEXT NOT NULL,
    is_day_off INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
    UNIQUE(user_id, date)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS group_members (
    chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    left_at TEXT,
    PRIMARY KEY (chat_id, user_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS event_participants (
    event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (event_id, user_id)
  )`);
  return db;
}

describe('NotificationScheduler – eve_holiday', () => {
  let db: Database;
  let scheduler: NotificationScheduler;
  let enqueued: { type: string; userId: number; logId: number }[];

  beforeEach(() => {
    db = setupDb();
    enqueued = [];
    const mockEnqueue = mock((type: string, userId: number, logId: number) => {
      enqueued.push({ type, userId, logId });
    });
    const eventRepo = new EventRepository(db);
    scheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo: new NotificationLogRepository(db),
      userRepo: new UserRepository(db),
      getEventsInRange: wrapGetEventsInRange(eventRepo),
      holidayRepo: new HolidayRepository(db),
      enqueue: mockEnqueue,
    });
  });

  test('sends eve_holiday when tomorrow is a holiday and notify=1 with evening_review_time set', async () => {
    // User 42, UTC timezone, evening_review_time = 21:00 (default)
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run("INSERT INTO holiday_countries (code, name, region) VALUES ('UA', 'Ukraine', 'Europe')");
    db.run(
      "INSERT INTO holidays (country_code, date, name, type, year) VALUES ('UA', '2026-03-19', 'Test Holiday', 'public', 2026)",
    );
    db.run("INSERT INTO holiday_subscriptions (user_id, country_code, is_primary, notify) VALUES (42, 'UA', 1, 1)");

    // Tick at 21:00 UTC on 2026-03-18 → tomorrow is 2026-03-19 which has a holiday
    await scheduler.tick(new Date('2026-03-18T21:00:30Z'));
    expect(enqueued.some((e) => e.type === 'eve_holiday' && e.userId === 42)).toBe(true);
  });

  test('does not send eve_holiday when notify=0', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run("INSERT INTO holiday_countries (code, name, region) VALUES ('UA', 'Ukraine', 'Europe')");
    db.run(
      "INSERT INTO holidays (country_code, date, name, type, year) VALUES ('UA', '2026-03-19', 'Test Holiday', 'public', 2026)",
    );
    // notify = 0
    db.run("INSERT INTO holiday_subscriptions (user_id, country_code, is_primary, notify) VALUES (42, 'UA', 1, 0)");

    await scheduler.tick(new Date('2026-03-18T21:00:30Z'));
    expect(enqueued.some((e) => e.type === 'eve_holiday')).toBe(false);
  });

  test('does not send eve_holiday when tomorrow has no holiday', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run("INSERT INTO holiday_countries (code, name, region) VALUES ('UA', 'Ukraine', 'Europe')");
    db.run("INSERT INTO holiday_subscriptions (user_id, country_code, is_primary, notify) VALUES (42, 'UA', 1, 1)");
    // No holiday inserted for tomorrow

    await scheduler.tick(new Date('2026-03-18T21:00:30Z'));
    expect(enqueued.some((e) => e.type === 'eve_holiday')).toBe(false);
  });

  test('deduplicates eve_holiday (does not send twice for same date)', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run("INSERT INTO holiday_countries (code, name, region) VALUES ('UA', 'Ukraine', 'Europe')");
    db.run(
      "INSERT INTO holidays (country_code, date, name, type, year) VALUES ('UA', '2026-03-19', 'Test Holiday', 'public', 2026)",
    );
    db.run("INSERT INTO holiday_subscriptions (user_id, country_code, is_primary, notify) VALUES (42, 'UA', 1, 1)");

    await scheduler.tick(new Date('2026-03-18T21:00:30Z'));
    await scheduler.tick(new Date('2026-03-18T21:00:30Z'));
    const holidayNotifs = enqueued.filter((e) => e.type === 'eve_holiday');
    expect(holidayNotifs.length).toBe(1);
  });

  test('fires at default 21:00 local when no notification_preferences row exists', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    // No notification_preferences row → scheduler must handle users without prefs
    db.run("INSERT INTO holiday_countries (code, name, region) VALUES ('UA', 'Ukraine', 'Europe')");
    db.run(
      "INSERT INTO holidays (country_code, date, name, type, year) VALUES ('UA', '2026-03-19', 'Test Holiday', 'public', 2026)",
    );
    db.run("INSERT INTO holiday_subscriptions (user_id, country_code, is_primary, notify) VALUES (42, 'UA', 1, 1)");

    // 21:00 UTC default
    await scheduler.tick(new Date('2026-03-18T21:00:30Z'));
    expect(enqueued.some((e) => e.type === 'eve_holiday' && e.userId === 42)).toBe(true);
  });

  test('payload contains holiday name', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run("INSERT INTO holiday_countries (code, name, region) VALUES ('UA', 'Ukraine', 'Europe')");
    db.run(
      "INSERT INTO holidays (country_code, date, name, type, year) VALUES ('UA', '2026-03-19', 'Test Holiday', 'public', 2026)",
    );
    db.run("INSERT INTO holiday_subscriptions (user_id, country_code, is_primary, notify) VALUES (42, 'UA', 1, 1)");

    await scheduler.tick(new Date('2026-03-18T21:00:30Z'));
    const logRow = db.prepare("SELECT * FROM notification_log WHERE type = 'eve_holiday'").get() as {
      payload: string;
    } | null;
    expect(logRow).not.toBeNull();
    const payload = JSON.parse(logRow!.payload);
    expect(payload.holidayName).toBe('Test Holiday');
    expect(payload.date).toBe('2026-03-19');
  });
});
