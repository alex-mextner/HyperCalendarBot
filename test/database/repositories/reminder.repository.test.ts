// test/database/repositories/reminder.repository.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('ReminderRepository', () => {
  let db: Database;
  let reminders: ReminderRepository;
  let eventId: number;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    reminders = new ReminderRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
    const event = new EventRepository(db).create({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-12T12:00:00Z',
      timezone: 'UTC',
    });
    eventId = event.id;
  });

  test('create adds reminder and returns it', () => {
    const r = reminders.create(eventId, 15);
    expect(r.event_id).toBe(eventId);
    expect(r.minutes_before).toBe(15);
  });

  test('getByEventId returns all reminders for event', () => {
    reminders.create(eventId, 5);
    reminders.create(eventId, 15);
    reminders.create(eventId, 60);
    const list = reminders.getByEventId(eventId);
    expect(list.length).toBe(3);
    expect(list.map((r) => r.minutes_before)).toEqual([5, 15, 60]);
  });

  test('removeByEventId deletes all reminders for event', () => {
    reminders.create(eventId, 5);
    reminders.create(eventId, 15);
    reminders.removeByEventId(eventId);
    expect(reminders.getByEventId(eventId).length).toBe(0);
  });

  test('setForEvent replaces existing reminders', () => {
    reminders.create(eventId, 5);
    reminders.setForEvent(eventId, [10, 30]);
    const list = reminders.getByEventId(eventId);
    expect(list.map((r) => r.minutes_before)).toEqual([10, 30]);
  });
});
