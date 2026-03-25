import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { ReminderMaterializer } from '../../../src/services/notification/materializer.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 42;
const TZ = 'UTC';

describe('Recurring reminder materialization', () => {
  let db: Database;
  let eventRepo: EventRepository;
  let eventReminderRepo: EventReminderRepository;
  let prefsRepo: NotificationPreferencesRepository;
  let materializer: ReminderMaterializer;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    eventRepo = new EventRepository(db);
    eventReminderRepo = new EventReminderRepository(db);
    prefsRepo = new NotificationPreferencesRepository(db);
    prefsRepo.ensureDefaults(USER_ID);
    materializer = new ReminderMaterializer(eventReminderRepo, prefsRepo);
  });

  describe('materializeForOccurrence', () => {
    test('creates reminders for a single occurrence without deleting existing', () => {
      const event = eventRepo.create({
        user_id: USER_ID,
        title: 'Weekly standup',
        start_at: '2099-06-01T10:00:00Z',
        timezone: TZ,
        recurrence_rule: 'FREQ=WEEKLY',
      });

      // Materialize for the base occurrence
      materializer.materialize(
        { id: event.id, start_at: event.start_at, reminder_overrides: '[30, 0]', all_day: 0, user_timezone: TZ },
        USER_ID,
      );
      const baseReminders = eventReminderRepo.getForEvent(event.id);
      expect(baseReminders.length).toBe(2);

      // Materialize for next occurrence (1 week later) — should NOT delete base reminders
      const nextOccurrence = '2099-06-08T10:00:00Z';
      const inserted = materializer.materializeForOccurrence(event.id, nextOccurrence, USER_ID, '[30, 0]', 0, TZ);
      expect(inserted).toBe(2);

      const allReminders = eventReminderRepo.getForEvent(event.id);
      expect(allReminders.length).toBe(4);

      // Verify the new reminders are for the next occurrence
      const nextReminders = allReminders.filter(
        (r) => r.remind_at_utc === '2099-06-08T09:30:00.000Z' || r.remind_at_utc === '2099-06-08T10:00:00.000Z',
      );
      expect(nextReminders.length).toBe(2);
    });

    test('skips duplicates — does not insert if reminder already exists', () => {
      const event = eventRepo.create({
        user_id: USER_ID,
        title: 'Daily sync',
        start_at: '2099-06-01T09:00:00Z',
        timezone: TZ,
        recurrence_rule: 'FREQ=DAILY',
      });

      const occurrenceStart = '2099-06-02T09:00:00Z';
      const inserted1 = materializer.materializeForOccurrence(event.id, occurrenceStart, USER_ID, '[30]', 0, TZ);
      expect(inserted1).toBe(1);

      // Calling again should not insert duplicates
      const inserted2 = materializer.materializeForOccurrence(event.id, occurrenceStart, USER_ID, '[30]', 0, TZ);
      expect(inserted2).toBe(0);

      const reminders = eventReminderRepo.getForEvent(event.id);
      expect(reminders.length).toBe(1);
    });

    test('skips past reminders', () => {
      const event = eventRepo.create({
        user_id: USER_ID,
        title: 'Old meeting',
        start_at: '2020-01-01T10:00:00Z',
        timezone: TZ,
        recurrence_rule: 'FREQ=WEEKLY',
      });

      const inserted = materializer.materializeForOccurrence(event.id, '2020-01-08T10:00:00Z', USER_ID, '[30]', 0, TZ);
      expect(inserted).toBe(0);
    });

    test('handles all-day events', () => {
      const event = eventRepo.create({
        user_id: USER_ID,
        title: 'All day recurring',
        start_at: '2099-07-10T00:00:00Z',
        all_day: true,
        timezone: TZ,
        recurrence_rule: 'FREQ=WEEKLY',
      });

      // default morning_agenda_time = '08:00'
      const inserted = materializer.materializeForOccurrence(event.id, '2099-07-17T00:00:00Z', USER_ID, null, 1, TZ);
      expect(inserted).toBe(2);

      const reminders = eventReminderRepo.getForEvent(event.id);
      const times = reminders.map((r) => r.remind_at_utc).sort();
      // Day before (July 16) at 08:00 UTC
      expect(times[0]).toBe('2099-07-16T08:00:00.000Z');
      // Day of (July 17) at 08:00 UTC
      expect(times[1]).toBe('2099-07-17T08:00:00.000Z');
    });

    test('uses user prefs when no overrides', () => {
      prefsRepo.update(USER_ID, { default_reminder_intervals: JSON.stringify([5, 60]) });

      const event = eventRepo.create({
        user_id: USER_ID,
        title: 'Recurring meeting',
        start_at: '2099-06-01T14:00:00Z',
        timezone: TZ,
        recurrence_rule: 'FREQ=WEEKLY',
      });

      const inserted = materializer.materializeForOccurrence(event.id, '2099-06-08T14:00:00Z', USER_ID, null, 0, TZ);
      expect(inserted).toBe(2);

      const reminders = eventReminderRepo.getForEvent(event.id);
      const minutes = reminders.map((r) => r.interval_minutes).sort((a, b) => a - b);
      expect(minutes).toEqual([5, 60]);
    });
  });

  describe('materializeUpcomingRecurringReminders', () => {
    test('materializes reminders for multiple upcoming occurrences', () => {
      // Create a daily event starting tomorrow
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
      tomorrow.setUTCHours(14, 0, 0, 0);
      const startAt = tomorrow.toISOString();

      const event = eventRepo.create({
        user_id: USER_ID,
        title: 'Daily standup',
        start_at: startAt,
        timezone: TZ,
        recurrence_rule: 'FREQ=DAILY',
      });

      // Store reminder overrides on the event
      db.prepare('UPDATE events SET reminder_overrides = ? WHERE id = ?').run('[30]', event.id);

      const totalInserted = materializer.materializeUpcomingRecurringReminders(eventRepo, 7);

      // Should have created reminders for occurrences within the next 7 days
      const reminders = eventReminderRepo.getForEvent(event.id);
      expect(reminders.length).toBeGreaterThanOrEqual(5);
      expect(totalInserted).toBeGreaterThanOrEqual(5);
    });

    test('does not duplicate reminders on repeated runs', () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
      tomorrow.setUTCHours(14, 0, 0, 0);
      const startAt = tomorrow.toISOString();

      eventRepo.create({
        user_id: USER_ID,
        title: 'Daily standup',
        start_at: startAt,
        timezone: TZ,
        recurrence_rule: 'FREQ=DAILY',
      });

      db.prepare("UPDATE events SET reminder_overrides = '[30]' WHERE title = 'Daily standup'").run();

      const first = materializer.materializeUpcomingRecurringReminders(eventRepo, 7);
      const second = materializer.materializeUpcomingRecurringReminders(eventRepo, 7);

      expect(first).toBeGreaterThan(0);
      expect(second).toBe(0);
    });

    test('skips cancelled occurrences (exceptions)', () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
      tomorrow.setUTCHours(10, 0, 0, 0);
      const startAt = tomorrow.toISOString();

      const event = eventRepo.create({
        user_id: USER_ID,
        title: 'Weekly meeting',
        start_at: startAt,
        timezone: TZ,
        recurrence_rule: 'FREQ=DAILY',
      });

      db.prepare("UPDATE events SET reminder_overrides = '[30]' WHERE id = ?").run(event.id);

      // Cancel the day-after-tomorrow occurrence
      const dayAfterTomorrow = new Date(tomorrow.getTime() + 24 * 60 * 60_000);
      const cancelledDate = dayAfterTomorrow.toISOString();
      eventRepo.createException(event.id, {
        user_id: USER_ID,
        title: 'Weekly meeting',
        start_at: cancelledDate,
        timezone: TZ,
        original_start_at: cancelledDate,
        is_cancelled: true,
      });

      materializer.materializeUpcomingRecurringReminders(eventRepo, 7);

      // All reminders should be for the template event (the cancelled occurrence produces no reminders)
      const reminders = eventReminderRepo.getForEvent(event.id);
      for (const r of reminders) {
        expect(r.remind_at_utc).not.toBe(new Date(dayAfterTomorrow.getTime() - 30 * 60_000).toISOString());
      }
    });

    test('ignores non-recurring events', () => {
      eventRepo.create({
        user_id: USER_ID,
        title: 'One-off meeting',
        start_at: '2099-06-01T14:00:00Z',
        timezone: TZ,
      });

      const inserted = materializer.materializeUpcomingRecurringReminders(eventRepo, 7);
      expect(inserted).toBe(0);
    });
  });

  describe('EventService integration with recurring materializer', () => {
    test('createEvent materializes reminders for upcoming recurring occurrences', () => {
      const reminderRepo = new ReminderRepository(db);
      const svc = new EventService({
        eventRepo,
        reminderRepo,
        materializer,
      });

      // Create a daily event starting tomorrow
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
      tomorrow.setUTCHours(14, 0, 0, 0);
      const startAt = tomorrow.toISOString();

      const event = svc.createEvent({
        user_id: USER_ID,
        title: 'Daily standup',
        start_at: startAt,
        timezone: TZ,
        recurrence_rule: 'FREQ=DAILY',
        reminder_minutes: [30],
      });

      // Should have reminders for the base occurrence AND future occurrences within 7 days
      const reminders = eventReminderRepo.getForEvent(event.id);
      // Base occurrence + up to 6 more days = at least 2 occurrences
      expect(reminders.length).toBeGreaterThanOrEqual(2);
    });

    test('updateEvent re-materializes recurring occurrences', () => {
      const reminderRepo = new ReminderRepository(db);
      const svc = new EventService({
        eventRepo,
        reminderRepo,
        materializer,
      });

      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
      tomorrow.setUTCHours(14, 0, 0, 0);
      const startAt = tomorrow.toISOString();

      const event = svc.createEvent({
        user_id: USER_ID,
        title: 'Weekly standup',
        start_at: startAt,
        timezone: TZ,
        recurrence_rule: 'FREQ=DAILY',
        reminder_minutes: [30],
      });

      // Update the event — this should re-materialize
      svc.updateEvent(event.id, USER_ID, { title: 'Updated standup' });

      const remindersAfter = eventReminderRepo.getForEvent(event.id);
      // Should still have reminders (materialize deletes + re-creates for base, and adds for occurrences)
      expect(remindersAfter.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('EventReminderRepository.existsForEventAt', () => {
  test('returns true when reminder exists, false otherwise', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    new UserRepository(db).create({ telegram_id: 42 });
    const eventRepo = new EventRepository(db);
    const event = eventRepo.create({
      user_id: 42,
      title: 'Test',
      start_at: '2099-06-01T10:00:00Z',
      timezone: 'UTC',
    });
    const repo = new EventReminderRepository(db);

    expect(repo.existsForEventAt(event.id, '2099-06-01T09:30:00.000Z')).toBe(false);

    repo.insert({
      event_id: event.id,
      user_id: 42,
      remind_at_utc: '2099-06-01T09:30:00.000Z',
      interval_minutes: 30,
      interval_label: '30 minutes',
    });

    expect(repo.existsForEventAt(event.id, '2099-06-01T09:30:00.000Z')).toBe(true);
    expect(repo.existsForEventAt(event.id, '2099-06-01T10:00:00.000Z')).toBe(false);
  });
});

describe('EventRepository.getAllRecurringTemplates', () => {
  test('returns all recurring events across all users', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: 1 });
    userRepo.create({ telegram_id: 2 });
    const eventRepo = new EventRepository(db);

    // User 1: recurring event
    eventRepo.create({
      user_id: 1,
      title: 'User 1 weekly',
      start_at: '2099-06-01T10:00:00Z',
      timezone: 'UTC',
      recurrence_rule: 'FREQ=WEEKLY',
    });

    // User 2: recurring event
    eventRepo.create({
      user_id: 2,
      title: 'User 2 daily',
      start_at: '2099-06-01T09:00:00Z',
      timezone: 'UTC',
      recurrence_rule: 'FREQ=DAILY',
    });

    // User 1: non-recurring event (should be excluded)
    eventRepo.create({
      user_id: 1,
      title: 'One-off',
      start_at: '2099-06-01T12:00:00Z',
      timezone: 'UTC',
    });

    const templates = eventRepo.getAllRecurringTemplates();
    expect(templates.length).toBe(2);
    const titles = templates.map((t) => t.title).sort();
    expect(titles).toEqual(['User 1 weekly', 'User 2 daily']);
  });

  test('excludes cancelled events and exceptions', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    new UserRepository(db).create({ telegram_id: 1 });
    const eventRepo = new EventRepository(db);

    const parent = eventRepo.create({
      user_id: 1,
      title: 'Recurring',
      start_at: '2099-06-01T10:00:00Z',
      timezone: 'UTC',
      recurrence_rule: 'FREQ=WEEKLY',
    });

    // Create an exception (child event with parent_event_id)
    eventRepo.createException(parent.id, {
      user_id: 1,
      title: 'Exception',
      start_at: '2099-06-08T11:00:00Z',
      timezone: 'UTC',
      original_start_at: '2099-06-08T10:00:00Z',
    });

    const templates = eventRepo.getAllRecurringTemplates();
    expect(templates.length).toBe(1);
    expect(templates[0]!.title).toBe('Recurring');
  });
});
