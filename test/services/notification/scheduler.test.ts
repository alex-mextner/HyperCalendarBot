import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { NotificationLogRow } from '../../../src/database/types.ts';
import { NotificationScheduler } from '../../../src/services/notification/scheduler.ts';

function setupDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
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
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Call', '2026-03-15T10:00:00Z', 'UTC')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T09:45:00Z', 15, '15 minutes')",
    );
    await scheduler.tick(new Date('2026-03-15T09:45:30Z'));
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.type).toBe('event_reminder');
  });

  test('tick does not double-enqueue (dedup)', async () => {
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Call', '2026-03-15T10:00:00Z', 'UTC')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T09:45:00Z', 15, '15 minutes')",
    );
    await scheduler.tick(new Date('2026-03-15T09:45:30Z'));
    await scheduler.tick(new Date('2026-03-15T09:45:30Z'));
    expect(enqueued.length).toBe(1);
  });

  test('tick enqueues morning agenda when local time matches', async () => {
    db.run("INSERT INTO users (telegram_id, timezone) VALUES (42, 'UTC')");
    db.run("INSERT INTO notification_preferences (user_id, morning_agenda_time) VALUES (42, '08:00')");
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Meeting', '2026-03-15T10:00:00Z', 'UTC')",
    );
    await scheduler.tick(new Date('2026-03-15T08:00:30Z'));
    expect(enqueued.some((e) => e.type === 'morning_agenda')).toBe(true);
  });

  test('skips voice call during call-specific quiet hours', async () => {
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Call', '2026-03-15T10:00:00Z', 'UTC')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T23:45:00Z', 15, '15 minutes')",
    );

    const callEnqueued: { userId: number; eventId: number }[] = [];
    const callScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo: new NotificationLogRepository(db),
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock(() => {}),
      callSettingsRepo: {
        isEnabled: mock(() => true),
        get: mock(() => ({
          user_id: 42,
          enabled: 1,
          max_daily_calls: 5,
          language: 'en',
          quiet_hours_start: '22:00',
          quiet_hours_end: '08:00',
          important_only: 0,
          updated_at: '',
        })),
      } as never,
      callLogRepo: {
        countTodayCalls: mock(() => 0),
      } as never,
      enqueueCall: mock((data: { userId: number; eventId: number }) => {
        callEnqueued.push(data);
      }) as never,
    });

    // 23:45 UTC is within quiet hours 22:00-08:00
    await callScheduler.tick(new Date('2026-03-15T23:45:30Z'));
    expect(callEnqueued.length).toBe(0);
  });

  test('batches multiple reminders at same time for same user into one job', async () => {
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Стендап', '2026-03-15T10:00:00Z', 'UTC')",
    );
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (2, 42, 'Звонок', '2026-03-15T10:00:00Z', 'UTC')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T09:30:00Z', 30, '30 minutes')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (2, 42, '2026-03-15T09:30:00Z', 30, '30 minutes')",
    );
    await scheduler.tick(new Date('2026-03-15T09:30:30Z'));
    // Two reminders at same time for same user → one batch job enqueued
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.type).toBe('event_reminder_batch');
  });

  test('does not batch reminders at different times', async () => {
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Стендап', '2026-03-15T10:00:00Z', 'UTC')",
    );
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (2, 42, 'Звонок', '2026-03-15T11:00:00Z', 'UTC')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T09:45:00Z', 15, '15 minutes')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (2, 42, '2026-03-15T10:45:00Z', 15, '15 minutes')",
    );
    // Only reminders within the current 1-min window are due, so only first one fires
    await scheduler.tick(new Date('2026-03-15T09:45:30Z'));
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.type).toBe('event_reminder');
  });

  test('tick runs cleanup on Sundays at 03:00 UTC', async () => {
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    const logRepo = new NotificationLogRepository(db);
    const cleanupSpy = { called: false };
    const origCleanup = logRepo.cleanup.bind(logRepo);
    logRepo.cleanup = (days: number) => {
      cleanupSpy.called = true;
      return origCleanup(days);
    };
    const cleanupScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo,
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock(() => {}),
    });
    // Sunday 2026-03-15 at 03:00 UTC
    await cleanupScheduler.tick(new Date('2026-03-15T03:00:30Z'));
    expect(cleanupSpy.called).toBe(true);
  });

  test('tick does not run cleanup on non-Sunday', async () => {
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    const logRepo = new NotificationLogRepository(db);
    const cleanupSpy = { called: false };
    const origCleanup = logRepo.cleanup.bind(logRepo);
    logRepo.cleanup = (days: number) => {
      cleanupSpy.called = true;
      return origCleanup(days);
    };
    const cleanupScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo,
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock(() => {}),
    });
    // Monday 2026-03-16 at 03:00 UTC (day=1 not Sunday=0)
    await cleanupScheduler.tick(new Date('2026-03-16T03:00:30Z'));
    expect(cleanupSpy.called).toBe(false);
  });

  test('enqueues voice call outside call-specific quiet hours', async () => {
    db.run('INSERT INTO users (telegram_id) VALUES (42)');
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Call', '2026-03-15T15:00:00Z', 'UTC')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T14:45:00Z', 15, '15 minutes')",
    );

    const callEnqueued: { userId: number; eventId: number }[] = [];
    const callScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo: new NotificationLogRepository(db),
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock(() => {}),
      callSettingsRepo: {
        isEnabled: mock(() => true),
        get: mock(() => ({
          user_id: 42,
          enabled: 1,
          max_daily_calls: 5,
          language: 'en',
          quiet_hours_start: '22:00',
          quiet_hours_end: '08:00',
          important_only: 0,
          updated_at: '',
        })),
      } as never,
      callLogRepo: {
        countTodayCalls: mock(() => 0),
      } as never,
      enqueueCall: mock((data: { userId: number; eventId: number }) => {
        callEnqueued.push(data);
      }) as never,
    });

    // 14:45 UTC is outside quiet hours 22:00-08:00
    await callScheduler.tick(new Date('2026-03-15T14:45:30Z'));
    expect(callEnqueued.length).toBe(1);
  });

  test('event_reminder payload is formatted text, not raw event JSON', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'Europe/Moscow', 'ru')");
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, end_at, timezone) VALUES (1, 42, 'Стендап', '2026-03-15T10:00:00Z', '2026-03-15T10:30:00Z', 'Europe/Moscow')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T09:45:00Z', 15, '15 minutes')",
    );
    const logRepo = new NotificationLogRepository(db);
    let capturedLogId = 0;
    const captureScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo,
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock((type: string, _userId: number, logId: number) => {
        if (type === 'event_reminder') capturedLogId = logId;
      }),
    });
    await captureScheduler.tick(new Date('2026-03-15T09:45:30Z'));
    expect(capturedLogId).toBeGreaterThan(0);
    const log = logRepo.getById(capturedLogId) as NotificationLogRow;
    const parsed = JSON.parse(log.payload!) as { text: string; event_id: number };
    expect(parsed.event_id).toBe(1);
    expect(parsed.text).toContain('⏰');
    expect(parsed.text).toContain('Стендап');
    expect(parsed.text).toContain('через 15 минут');
    expect(parsed.text).toContain('13:00'); // Moscow = UTC+3
    expect(parsed.text).not.toContain('"event_title"');
  });

  test('event_reminder_batch payload is formatted text', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'en')");
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Standup', '2026-03-15T10:00:00Z', 'UTC')",
    );
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (2, 42, 'Call', '2026-03-15T10:00:00Z', 'UTC')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (1, 42, '2026-03-15T09:30:00Z', 30, '30 minutes')",
    );
    db.run(
      "INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (2, 42, '2026-03-15T09:30:00Z', 30, '30 minutes')",
    );
    const logRepo = new NotificationLogRepository(db);
    let capturedLogId = 0;
    const captureScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo,
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock((type: string, _userId: number, logId: number) => {
        if (type === 'event_reminder_batch') capturedLogId = logId;
      }),
    });
    await captureScheduler.tick(new Date('2026-03-15T09:30:30Z'));
    expect(capturedLogId).toBeGreaterThan(0);
    const log = logRepo.getById(capturedLogId) as NotificationLogRow;
    const parsed = JSON.parse(log.payload!) as { text: string; event_ids: number[] };
    expect(parsed.event_ids).toEqual([1, 2]);
    expect(parsed.text).toContain('Reminders:');
    expect(parsed.text).toContain('Standup');
    expect(parsed.text).toContain('Call');
    expect(parsed.text).not.toContain('"event_title"');
  });

  test('morning_agenda payload is rendered text, not raw JSON', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'en')");
    db.run("INSERT INTO notification_preferences (user_id, morning_agenda_time) VALUES (42, '08:00')");
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, end_at, timezone) VALUES (1, 42, 'Standup', '2026-03-15T10:00:00Z', '2026-03-15T10:30:00Z', 'UTC')",
    );
    const logRepo = new NotificationLogRepository(db);
    let capturedLogId = 0;
    const captureScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo,
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock((type: string, _userId: number, logId: number) => {
        if (type === 'morning_agenda') capturedLogId = logId;
      }),
    });
    await captureScheduler.tick(new Date('2026-03-15T08:00:30Z'));
    expect(capturedLogId).toBeGreaterThan(0);
    const log = logRepo.getById(capturedLogId) as NotificationLogRow;
    expect(log.payload).not.toContain('"eventCount"');
    expect(log.payload).toContain('Standup');
  });

  test('evening_review payload is rendered text, not raw JSON', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'UTC', 'en')");
    db.run(
      "INSERT INTO notification_preferences (user_id, evening_review_enabled, evening_review_time) VALUES (42, 1, '21:00')",
    );
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, end_at, timezone) VALUES (1, 42, 'Planning', '2026-03-16T10:00:00Z', '2026-03-16T11:00:00Z', 'UTC')",
    );
    const logRepo = new NotificationLogRepository(db);
    let capturedLogId = 0;
    const captureScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo,
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock((type: string, _userId: number, logId: number) => {
        if (type === 'evening_review') capturedLogId = logId;
      }),
    });
    await captureScheduler.tick(new Date('2026-03-15T21:00:30Z'));
    expect(capturedLogId).toBeGreaterThan(0);
    const log = logRepo.getById(capturedLogId) as NotificationLogRow;
    expect(log.payload).not.toContain('"eventCount"');
    expect(log.payload).toContain('Planning');
  });

  test('morning agenda includes event at 00:30 local (22:30 UTC previous day) for UTC+2 user', async () => {
    // Tick: 2026-03-19T06:00:30Z = 08:00 local in Europe/Kyiv (UTC+2)
    // Event at 2026-03-18T22:30:00Z = 00:30 local on March 19 — should appear in today's agenda
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'Europe/Kyiv', 'en')");
    db.run("INSERT INTO notification_preferences (user_id, morning_agenda_time) VALUES (42, '08:00')");
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Night standup', '2026-03-18T22:30:00Z', 'UTC')",
    );
    await scheduler.tick(new Date('2026-03-19T06:00:30Z'));
    expect(enqueued.some((e) => e.type === 'morning_agenda')).toBe(true);
  });

  test('eve-holiday fires for holiday on user local tomorrow (UTC+2)', async () => {
    // nowUtc = 2026-03-18T19:00:30Z = 21:00 local (Europe/Kyiv, UTC+2)
    // Local tomorrow = 2026-03-19, UTC date still 2026-03-18
    // Holiday is on local tomorrow (2026-03-19) — should trigger at 21:00 local
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'Europe/Kyiv', 'en')");
    db.run(
      "INSERT INTO notification_preferences (user_id, evening_review_enabled, evening_review_time) VALUES (42, 1, '21:00')",
    );
    const eveHolidayEnqueued: string[] = [];
    const mockHolidayRepo = {
      getUsersWithNotifyForDate: (date: string) => {
        if (date === '2026-03-18' || date === '2026-03-19')
          return [{ user_id: 42, country_code: 'UA', holiday_name: 'Test Holiday' }];
        return [];
      },
      getHolidayForUser: (userId: number, date: string) => {
        if (userId === 42 && date === '2026-03-19') return { country_code: 'UA', holiday_name: 'Test Holiday' };
        return null;
      },
    };
    const testScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo: new NotificationLogRepository(db),
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: (type: string) => eveHolidayEnqueued.push(type),
      holidayRepo: mockHolidayRepo as never,
    });
    await testScheduler.tick(new Date('2026-03-18T19:00:30Z'));
    expect(eveHolidayEnqueued.some((t) => t === 'eve_holiday')).toBe(true);
  });

  test('morning agenda includes clock-change notice on DST day (Europe/Berlin spring forward)', async () => {
    // 2026-03-29 is the day Europe/Berlin springs forward (UTC+1 → UTC+2)
    // At 06:00 UTC = 08:00 CEST (new offset already applies)
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'Europe/Berlin', 'en')");
    db.run("INSERT INTO notification_preferences (user_id, morning_agenda_time) VALUES (42, '08:00')");
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Standup', '2026-03-29T10:00:00Z', 'Europe/Berlin')",
    );
    const logRepo = new NotificationLogRepository(db);
    let capturedPayload = '';
    const captureScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo,
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock((_type: string, _userId: number, _logId: number, payload: string) => {
        capturedPayload = payload;
      }),
    });
    await captureScheduler.tick(new Date('2026-03-29T06:00:30Z'));
    expect(capturedPayload).toContain('Standup');
    expect(capturedPayload).toContain('🕐');
    expect(capturedPayload).toContain('forward');
  });

  test('morning agenda does NOT include clock-change notice on non-DST day', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'Europe/Berlin', 'en')");
    db.run("INSERT INTO notification_preferences (user_id, morning_agenda_time) VALUES (42, '08:00')");
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Standup', '2026-03-15T10:00:00Z', 'Europe/Berlin')",
    );
    const logRepo = new NotificationLogRepository(db);
    let capturedPayload = '';
    const captureScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo,
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock((_type: string, _userId: number, _logId: number, payload: string) => {
        capturedPayload = payload;
      }),
    });
    await captureScheduler.tick(new Date('2026-03-15T07:00:30Z'));
    expect(capturedPayload).toContain('Standup');
    expect(capturedPayload).not.toContain('🕐');
  });

  test('standalone clock-change sent at 08:00 for user without morning agenda', async () => {
    // User has no morning agenda enabled but clocks changed in their timezone
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'Europe/Berlin', 'ru')");
    // Do NOT insert into notification_preferences → no morning agenda
    const capturedTypes: string[] = [];
    let capturedPayload = '';
    const standaloneScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo: new NotificationLogRepository(db),
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock((type: string, _userId: number, _logId: number, payload: string) => {
        capturedTypes.push(type);
        capturedPayload = payload;
      }),
    });
    // 2026-03-29 06:00 UTC = 08:00 CEST (Europe/Berlin springs forward)
    await standaloneScheduler.tick(new Date('2026-03-29T06:00:30Z'));
    expect(capturedTypes).toContain('clock_change');
    expect(capturedPayload).toContain('🕐');
    expect(capturedPayload).toContain('вперёд');
  });

  test('standalone clock-change NOT sent at wrong time', async () => {
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'Europe/Berlin', 'en')");
    const capturedTypes: string[] = [];
    const noTimeScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo: new NotificationLogRepository(db),
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock((type: string) => {
        capturedTypes.push(type);
      }),
    });
    // 2026-03-29 at 10:00 UTC = 12:00 CEST — not 08:00
    await noTimeScheduler.tick(new Date('2026-03-29T10:00:30Z'));
    expect(capturedTypes).not.toContain('clock_change');
  });

  test('clock-change sent as standalone when morning agenda user has no events on DST day', async () => {
    // User has morning agenda enabled but no events today — should still get clock-change notice
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'Europe/Berlin', 'en')");
    db.run("INSERT INTO notification_preferences (user_id, morning_agenda_time) VALUES (42, '08:00')");
    // No events inserted
    let capturedType = '';
    let capturedPayload = '';
    const noEventsScheduler = new NotificationScheduler({
      prefsRepo: new NotificationPreferencesRepository(db),
      reminderRepo: new EventReminderRepository(db),
      logRepo: new NotificationLogRepository(db),
      userRepo: new UserRepository(db),
      eventRepo: new EventRepository(db),
      enqueue: mock((type: string, _userId: number, _logId: number, payload: string) => {
        capturedType = type;
        capturedPayload = payload;
      }),
    });
    await noEventsScheduler.tick(new Date('2026-03-29T06:00:30Z'));
    expect(capturedType).toBe('clock_change');
    expect(capturedPayload).toContain('🕐');
    expect(capturedPayload).toContain('forward');
  });

  test('evening review includes event at 00:30 local tomorrow (22:30 UTC today) for UTC+2 user', async () => {
    // Tick: 2026-03-18T19:00:30Z = 21:00 local in Europe/Kyiv (UTC+2)
    // Event at 2026-03-18T22:30:00Z = 00:30 local on March 19 — that is "tomorrow" → should appear
    db.run("INSERT INTO users (telegram_id, timezone, language) VALUES (42, 'Europe/Kyiv', 'en')");
    db.run(
      "INSERT INTO notification_preferences (user_id, evening_review_enabled, evening_review_time) VALUES (42, 1, '21:00')",
    );
    db.run(
      "INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (1, 42, 'Early birds', '2026-03-18T22:30:00Z', 'UTC')",
    );
    await scheduler.tick(new Date('2026-03-18T19:00:30Z'));
    expect(enqueued.some((e) => e.type === 'evening_review')).toBe(true);
  });
});
