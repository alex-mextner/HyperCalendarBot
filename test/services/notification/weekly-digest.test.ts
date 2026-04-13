import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import type { EventOccurrence, NotificationLogRow } from '../../../src/database/types.ts';
import { NotificationRenderer } from '../../../src/services/notification/renderer.ts';
import { NotificationScheduler } from '../../../src/services/notification/scheduler.ts';

function setupDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE users (
    telegram_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
    language TEXT NOT NULL DEFAULT 'en', timezone TEXT NOT NULL DEFAULT 'UTC',
    country_code TEXT, google_refresh_token_enc TEXT,
    voice_response_enabled INTEGER DEFAULT NULL,
    onboarding_completed INTEGER NOT NULL DEFAULT 0,
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

// 2026-03-22 is a Sunday, 21:00 UTC
const SUNDAY_21H = new Date('2026-03-22T21:00:30Z');
// Next week: Mon 2026-03-23 through Sun 2026-03-29
const MON = '2026-03-23';

describe('NotificationScheduler – weekly_digest', () => {
  let db: Database;
  let enqueued: { type: string; userId: number; logId: number }[];
  let scheduler: NotificationScheduler;

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
      enqueue: mockEnqueue,
    });
  });

  test('enqueues weekly_digest on Sunday at evening_review_time', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run(
      `INSERT INTO events (id, user_id, title, start_at, end_at, timezone) VALUES (1, 42, 'Стендап', '${MON}T10:00:00Z', '${MON}T10:30:00Z', 'UTC')`,
    );

    await scheduler.tick(SUNDAY_21H);
    expect(enqueued.some((e) => e.type === 'weekly_digest' && e.userId === 42)).toBe(true);
  });

  test('does not enqueue weekly_digest when evening_review_enabled = 0', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 0)');
    db.run(`INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Стендап', '${MON}T10:00:00Z')`);

    await scheduler.tick(SUNDAY_21H);
    expect(enqueued.some((e) => e.type === 'weekly_digest')).toBe(false);
  });

  test('does not enqueue weekly_digest on non-Sunday', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run(`INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Стендап', '${MON}T10:00:00Z')`);

    // Monday 2026-03-23 at 21:00 UTC — not Sunday
    await scheduler.tick(new Date('2026-03-23T21:00:30Z'));
    expect(enqueued.some((e) => e.type === 'weekly_digest')).toBe(false);
  });

  test('does not enqueue weekly_digest at wrong time', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run(`INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Стендап', '${MON}T10:00:00Z')`);

    // Sunday but at 20:00 instead of 21:00
    await scheduler.tick(new Date('2026-03-22T20:00:30Z'));
    expect(enqueued.some((e) => e.type === 'weekly_digest')).toBe(false);
  });

  test('deduplicates weekly_digest for same week', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run(`INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Стендап', '${MON}T10:00:00Z')`);

    await scheduler.tick(SUNDAY_21H);
    await scheduler.tick(SUNDAY_21H);
    expect(enqueued.filter((e) => e.type === 'weekly_digest').length).toBe(1);
  });

  test('payload is rendered text containing event title and day names', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run(
      `INSERT INTO events (id, user_id, title, start_at, end_at, timezone) VALUES (1, 42, 'Стендап', '${MON}T10:00:00Z', '${MON}T10:30:00Z', 'UTC')`,
    );

    const logRepo = new NotificationLogRepository(db);
    const testEventRepo = new EventRepository(db);
    const testScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo,
      userRepo: new UserRepository(db),
      getEventsInRange: wrapGetEventsInRange(testEventRepo),
      enqueue: mock(() => {}),
    });

    await testScheduler.tick(SUNDAY_21H);
    const log = db
      .prepare("SELECT * FROM notification_log WHERE type = 'weekly_digest'")
      .get() as NotificationLogRow | null;
    expect(log).not.toBeNull();
    expect(log!.payload).toContain('Стендап');
    expect(log!.payload).toContain('10:00');
  });

  test('ref_key uses ISO week format wd:{userId}:{YYYY-WNN}', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    db.run(`INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Стендап', '${MON}T10:00:00Z')`);

    const logRepo = new NotificationLogRepository(db);
    const testEventRepo = new EventRepository(db);
    const testScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo,
      userRepo: new UserRepository(db),
      getEventsInRange: wrapGetEventsInRange(testEventRepo),
      enqueue: mock(() => {}),
    });

    await testScheduler.tick(SUNDAY_21H);
    const log = db
      .prepare("SELECT * FROM notification_log WHERE type = 'weekly_digest'")
      .get() as NotificationLogRow | null;
    expect(log).not.toBeNull();
    // 2026-03-22 is Sunday of ISO week 12 (2026-W12), next week is W13
    expect(log!.reference_key).toMatch(/^wd:42:2026-W\d+$/);
  });

  test('still enqueues weekly_digest even when no events next week (sends empty week digest)', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'ru')");
    db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    // No events inserted

    await scheduler.tick(SUNDAY_21H);
    // Weekly digest fires regardless of whether there are events (unlike morning/evening)
    expect(enqueued.some((e) => e.type === 'weekly_digest')).toBe(true);
  });
});

describe('NotificationRenderer – renderWeeklyDigest', () => {
  const renderer = new NotificationRenderer();

  test('renders week header with date range', () => {
    const result = renderer.renderWeeklyDigest('ru', '23–29 марта', [
      { date: '2026-03-23', dayLabel: 'Пн 23', events: [{ title: 'Стендап', startTime: '10:00' }] },
      { date: '2026-03-24', dayLabel: 'Вт 24', events: [] },
    ]);
    expect(result.channel).toBe('telegram_text');
    expect(result.text).toContain('23–29 марта');
    expect(result.text).toContain('Стендап');
    expect(result.text).toContain('10:00');
  });

  test('includes days with no events', () => {
    const result = renderer.renderWeeklyDigest('ru', '23–29 марта', [
      { date: '2026-03-23', dayLabel: 'Пн 23', events: [] },
    ]);
    expect(result.text).toContain('Пн 23');
  });

  test('renders in English', () => {
    const result = renderer.renderWeeklyDigest('en', 'Mar 23–29', [
      { date: '2026-03-23', dayLabel: 'Mon 23', events: [{ title: 'Standup', startTime: '10:00' }] },
    ]);
    expect(result.text).toContain('Mar 23–29');
    expect(result.text).toContain('Standup');
  });
});
