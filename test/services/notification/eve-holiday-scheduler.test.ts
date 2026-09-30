import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
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
  runMigrations(db, migrations);
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
