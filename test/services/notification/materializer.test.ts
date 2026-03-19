import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
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
      morning_agenda_format TEXT NOT NULL DEFAULT 'text',
      default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
      evening_review_enabled INTEGER NOT NULL DEFAULT 0,
      evening_review_time TEXT NOT NULL DEFAULT '21:00',
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
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    reminderRepo = new EventReminderRepository(db);
    prefsRepo = new NotificationPreferencesRepository(db);
    prefsRepo.ensureDefaults(42);
    materializer = new ReminderMaterializer(reminderRepo, prefsRepo);
  });

  test('materializes reminders using default intervals', () => {
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2099-03-15T10:00:00Z')");
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: null, all_day: 0, user_timezone: 'UTC' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interval_minutes).toBe(15);
    expect(rows[0]!.remind_at_utc).toBe('2099-03-15T09:45:00.000Z');
  });

  test('uses event-level overrides when present', () => {
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2099-03-15T10:00:00Z')");
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: '[5, 60]', all_day: 0, user_timezone: 'UTC' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(2);
    const minutes = rows.map((r) => r.interval_minutes).sort((a, b) => a - b);
    expect(minutes).toEqual([5, 60]);
  });

  test('skips reminders in the past', () => {
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Old', '2020-01-01T10:00:00Z')");
    materializer.materialize(
      { id: 1, start_at: '2020-01-01T10:00:00Z', reminder_overrides: null, all_day: 0, user_timezone: 'UTC' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(0);
  });

  test('re-materializing replaces old reminders', () => {
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2099-03-15T10:00:00Z')");
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: null, all_day: 0, user_timezone: 'UTC' },
      42,
    );
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: '[5]', all_day: 0, user_timezone: 'UTC' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interval_minutes).toBe(5);
  });

  test('interval_minutes = 0 schedules reminder at event start time', () => {
    db.run("INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2099-06-20T14:30:00Z')");
    materializer.materialize(
      { id: 1, start_at: '2099-06-20T14:30:00Z', reminder_overrides: '[0]', all_day: 0, user_timezone: 'UTC' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interval_minutes).toBe(0);
    expect(rows[0]!.remind_at_utc).toBe('2099-06-20T14:30:00.000Z');
  });

  test('all-day event: schedules two reminders at morning_agenda_time local (day before and day of)', () => {
    // all-day event on 2099-07-10, user in UTC; default morning_agenda_time = '08:00'
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, all_day) VALUES (1, 42, 'Holiday', '2099-07-10T00:00:00Z', 1)",
    );
    materializer.materialize(
      { id: 1, start_at: '2099-07-10T00:00:00Z', reminder_overrides: null, all_day: 1, user_timezone: 'UTC' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(2);
    const times = rows.map((r) => r.remind_at_utc).sort();
    // day before at 08:00 UTC = 2099-07-09T08:00:00.000Z
    expect(times[0]).toBe('2099-07-09T08:00:00.000Z');
    // day of at 08:00 UTC = 2099-07-10T08:00:00.000Z
    expect(times[1]).toBe('2099-07-10T08:00:00.000Z');
  });

  test('all-day event: uses morning_agenda_time from prefs instead of 09:00 default', () => {
    prefsRepo.update(42, { morning_agenda_time: '07:00' });
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, all_day) VALUES (1, 42, 'Holiday', '2099-07-10T00:00:00Z', 1)",
    );
    materializer.materialize(
      { id: 1, start_at: '2099-07-10T00:00:00Z', reminder_overrides: null, all_day: 1, user_timezone: 'UTC' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(2);
    const times = rows.map((r) => r.remind_at_utc).sort();
    expect(times[0]).toBe('2099-07-09T07:00:00.000Z');
    expect(times[1]).toBe('2099-07-10T07:00:00.000Z');
  });

  test('all-day event: respects user timezone for UTC conversion', () => {
    // User in Europe/Kyiv (UTC+3 in summer). morning_agenda_time = '08:00' local = '05:00' UTC
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, all_day) VALUES (1, 42, 'Holiday', '2099-07-10T00:00:00Z', 1)",
    );
    materializer.materialize(
      { id: 1, start_at: '2099-07-10T00:00:00Z', reminder_overrides: null, all_day: 1, user_timezone: 'Europe/Kyiv' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(2);
    const times = rows.map((r) => r.remind_at_utc).sort();
    // default morning time = 08:00 from prefs, Europe/Kyiv UTC+3 in summer → 05:00 UTC
    expect(times[0]).toBe('2099-07-09T05:00:00.000Z');
    expect(times[1]).toBe('2099-07-10T05:00:00.000Z');
  });

  test('all-day event: skips past reminders', () => {
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, all_day) VALUES (1, 42, 'OldHoliday', '2020-01-15T00:00:00Z', 1)",
    );
    materializer.materialize(
      { id: 1, start_at: '2020-01-15T00:00:00Z', reminder_overrides: null, all_day: 1, user_timezone: 'UTC' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(0);
  });
});
