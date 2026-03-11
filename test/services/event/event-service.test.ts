// test/services/event/event-service.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { EventService } from '../../../src/services/event/event-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('EventService', () => {
  let db: Database;
  let service: EventService;
  const USER_ID = 123;
  const TZ = 'UTC';

  beforeEach(() => {
    db = createTestDb();
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
    service = new EventService(eventRepo, reminderRepo);
  });

  test('createEvent creates event with default reminder', () => {
    const event = service.createEvent({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-12T12:00:00Z',
      timezone: TZ,
    });
    expect(event.title).toBe('Test');
  });

  test('createEvent creates reminders from reminder_minutes', () => {
    const event = service.createEvent({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-12T12:00:00Z',
      timezone: TZ,
      reminder_minutes: [5, 15],
    });
    const reminders = db.prepare('SELECT * FROM reminders WHERE event_id = ?').all(event.id);
    expect(reminders.length).toBe(2);
  });

  test('getEventsForDay returns events and recurring occurrences', () => {
    service.createEvent({
      user_id: USER_ID,
      title: 'OneOff',
      start_at: '2026-03-11T10:00:00Z',
      timezone: TZ,
    });
    service.createEvent({
      user_id: USER_ID,
      title: 'Daily',
      start_at: '2026-03-01T09:00:00Z',
      timezone: TZ,
      recurrence_rule: 'FREQ=DAILY',
    });

    const occurrences = service.getEventsForDay(USER_ID, new Date('2026-03-11T12:00:00Z'), TZ);
    expect(occurrences.length).toBe(2);
    const titles = occurrences.map((o) => o.event.title).sort();
    expect(titles).toEqual(['Daily', 'OneOff']);
  });

  test('deleteEvent removes event', () => {
    const event = service.createEvent({
      user_id: USER_ID,
      title: 'Del',
      start_at: '2026-03-12T12:00:00Z',
      timezone: TZ,
    });
    const result = service.deleteEvent(event.id, USER_ID);
    expect(result).toBe(true);
  });

  test('getFreeSlots finds gaps between events', () => {
    service.createEvent({
      user_id: USER_ID,
      title: 'A',
      start_at: '2026-03-11T09:00:00Z',
      end_at: '2026-03-11T10:00:00Z',
      timezone: TZ,
    });
    service.createEvent({
      user_id: USER_ID,
      title: 'B',
      start_at: '2026-03-11T12:00:00Z',
      end_at: '2026-03-11T13:00:00Z',
      timezone: TZ,
    });

    const slots = service.getFreeSlots(USER_ID, new Date('2026-03-11T12:00:00Z'), TZ);
    expect(slots.length).toBe(3);
  });
});
