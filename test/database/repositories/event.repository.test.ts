// test/database/repositories/event.repository.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('EventRepository', () => {
  let db: Database;
  let events: EventRepository;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    events = new EventRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('create inserts event and returns it with id', () => {
    const event = events.create({
      user_id: USER_ID,
      title: 'Dentist',
      start_at: '2026-03-12T12:00:00Z',
      timezone: 'Europe/Moscow',
    });
    expect(event.id).toBeGreaterThan(0);
    expect(event.title).toBe('Dentist');
    expect(event.user_id).toBe(USER_ID);
  });

  test('findById returns event', () => {
    const created = events.create({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-12T12:00:00Z',
      timezone: 'UTC',
    });
    const found = events.findById(created.id, USER_ID);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Test');
  });

  test('findById returns null for wrong user', () => {
    const created = events.create({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-12T12:00:00Z',
      timezone: 'UTC',
    });
    expect(events.findById(created.id, 999)).toBeNull();
  });

  test('getInRange returns events within date range', () => {
    events.create({ user_id: USER_ID, title: 'E1', start_at: '2026-03-11T10:00:00Z', timezone: 'UTC' });
    events.create({ user_id: USER_ID, title: 'E2', start_at: '2026-03-12T10:00:00Z', timezone: 'UTC' });
    events.create({ user_id: USER_ID, title: 'E3', start_at: '2026-03-13T10:00:00Z', timezone: 'UTC' });

    const result = events.getInRange(USER_ID, '2026-03-11T00:00:00Z', '2026-03-12T23:59:59Z');
    expect(result.length).toBe(2);
    expect(result.map((e) => e.title)).toEqual(['E1', 'E2']);
  });

  test('getRecurringTemplates returns events with recurrence_rule', () => {
    events.create({
      user_id: USER_ID,
      title: 'Daily',
      start_at: '2026-01-01T09:00:00Z',
      timezone: 'UTC',
      recurrence_rule: 'FREQ=DAILY',
    });
    events.create({ user_id: USER_ID, title: 'OneOff', start_at: '2026-03-11T09:00:00Z', timezone: 'UTC' });

    const templates = events.getRecurringTemplates(USER_ID);
    expect(templates.length).toBe(1);
    expect(templates[0]!.title).toBe('Daily');
  });

  test('update modifies event fields', () => {
    const created = events.create({
      user_id: USER_ID,
      title: 'Old',
      start_at: '2026-03-11T10:00:00Z',
      timezone: 'UTC',
    });
    const updated = events.update(created.id, USER_ID, { title: 'New' });
    expect(updated!.title).toBe('New');
  });

  test('remove deletes event', () => {
    const created = events.create({
      user_id: USER_ID,
      title: 'Del',
      start_at: '2026-03-11T10:00:00Z',
      timezone: 'UTC',
    });
    const removed = events.remove(created.id, USER_ID);
    expect(removed).toBe(true);
    expect(events.findById(created.id, USER_ID)).toBeNull();
  });

  test('search finds events by title substring', () => {
    events.create({
      user_id: USER_ID,
      title: 'Dentist appointment',
      start_at: '2026-03-12T12:00:00Z',
      timezone: 'UTC',
    });
    events.create({ user_id: USER_ID, title: 'Team lunch', start_at: '2026-03-12T12:00:00Z', timezone: 'UTC' });

    const results = events.search(USER_ID, 'dent');
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe('Dentist appointment');
  });

  test('getUpcoming returns future events sorted by start_at', () => {
    events.create({ user_id: USER_ID, title: 'Past', start_at: '2020-01-01T10:00:00Z', timezone: 'UTC' });
    events.create({ user_id: USER_ID, title: 'Future2', start_at: '2099-03-12T10:00:00Z', timezone: 'UTC' });
    events.create({ user_id: USER_ID, title: 'Future1', start_at: '2099-03-11T10:00:00Z', timezone: 'UTC' });

    const upcoming = events.getUpcoming(USER_ID, 5);
    expect(upcoming.length).toBe(2);
    expect(upcoming[0]!.title).toBe('Future1');
  });

  test('getUpcoming includes recurring templates regardless of start_at', () => {
    events.create({
      user_id: USER_ID,
      title: 'Old recurring',
      start_at: '2020-01-01T10:00:00Z',
      timezone: 'UTC',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
    });
    events.create({ user_id: USER_ID, title: 'Future one-off', start_at: '2099-06-01T10:00:00Z', timezone: 'UTC' });

    const upcoming = events.getUpcoming(USER_ID, 10);
    expect(upcoming.length).toBe(2);
    const titles = upcoming.map((e) => e.title);
    expect(titles).toContain('Old recurring');
    expect(titles).toContain('Future one-off');
  });
});
