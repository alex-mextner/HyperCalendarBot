// test/database/repositories/event.repository.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CalendarEvent } from '../../../src/database/types.ts';

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

  describe('recurring event helpers', () => {
    test('getExceptionsFrom returns exceptions on or after date', () => {
      const template = events.create({
        user_id: USER_ID,
        title: 'Weekly',
        start_at: '2026-03-01T10:00:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=WEEKLY',
      });
      events.createException(template.id, {
        user_id: USER_ID,
        title: 'Moved',
        start_at: '2026-03-08T11:00:00Z',
        timezone: 'UTC',
        original_start_at: '2026-03-08T10:00:00Z',
      });
      events.createException(template.id, {
        user_id: USER_ID,
        title: 'Moved2',
        start_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
        original_start_at: '2026-03-15T10:00:00Z',
      });

      const from = events.getExceptionsFrom(template.id, '2026-03-15T00:00:00Z');
      expect(from.length).toBe(1);
      expect(from[0]!.title).toBe('Moved2');
    });

    test('reparentExceptions moves exceptions to new template', () => {
      const old = events.create({
        user_id: USER_ID,
        title: 'Old',
        start_at: '2026-03-01T10:00:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=WEEKLY',
      });
      const exc = events.createException(old.id, {
        user_id: USER_ID,
        title: 'Exc',
        start_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
        original_start_at: '2026-03-15T10:00:00Z',
      });
      const newTemplate = events.create({
        user_id: USER_ID,
        title: 'New',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=WEEKLY',
      });

      events.reparentExceptions(old.id, newTemplate.id, '2026-03-15T00:00:00Z');

      const moved = db.prepare('SELECT * FROM events WHERE id = ?').get(exc.id) as CalendarEvent;
      expect(moved.parent_event_id).toBe(newTemplate.id);
    });

    test('deleteExceptionsFrom removes exceptions on or after date', () => {
      const template = events.create({
        user_id: USER_ID,
        title: 'Weekly',
        start_at: '2026-03-01T10:00:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=WEEKLY',
      });
      events.createException(template.id, {
        user_id: USER_ID,
        title: 'E1',
        start_at: '2026-03-08T10:00:00Z',
        timezone: 'UTC',
        original_start_at: '2026-03-08T10:00:00Z',
        is_cancelled: true,
      });
      events.createException(template.id, {
        user_id: USER_ID,
        title: 'E2',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
        original_start_at: '2026-03-15T10:00:00Z',
        is_cancelled: true,
      });

      events.deleteExceptionsFrom(template.id, '2026-03-15T00:00:00Z');

      const remaining = events.getExceptions(template.id);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.title).toBe('E1');
    });

    test('search escapes LIKE wildcards in query', () => {
      events.create({ user_id: USER_ID, title: '50% off sale', start_at: '2026-03-11T10:00:00Z', timezone: 'UTC' });
      events.create({ user_id: USER_ID, title: '50 items left', start_at: '2026-03-11T11:00:00Z', timezone: 'UTC' });

      const results = events.search(USER_ID, '50%');
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('50% off sale');
    });

    test('search escapes underscore wildcard', () => {
      events.create({ user_id: USER_ID, title: 'test_case', start_at: '2026-03-11T10:00:00Z', timezone: 'UTC' });
      events.create({ user_id: USER_ID, title: 'testXcase', start_at: '2026-03-11T11:00:00Z', timezone: 'UTC' });

      const results = events.search(USER_ID, 'test_case');
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('test_case');
    });

    test('setRecurrenceUntil appends UNTIL to rrule', () => {
      const template = events.create({
        user_id: USER_ID,
        title: 'Weekly',
        start_at: '2026-03-01T10:00:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=WEEKLY',
      });

      events.setRecurrenceUntil(template.id, '2026-03-14T00:00:00Z');

      const updated = events.findById(template.id, USER_ID);
      expect(updated!.recurrence_rule).toBe('FREQ=WEEKLY;UNTIL=20260314T000000Z');
    });
  });

  describe('group calendar', () => {
    const GROUP_ID = 999;
    const CREATOR_ID = USER_ID;

    function createGroupEvent(overrides: { title?: string; start_at?: string; recurrence_rule?: string } = {}) {
      return events.create({
        user_id: CREATOR_ID,
        title: overrides.title ?? 'Group Meeting',
        start_at: overrides.start_at ?? '2026-03-12T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: CREATOR_ID,
        ...(overrides.recurrence_rule ? { recurrence_rule: overrides.recurrence_rule } : {}),
      });
    }

    test('create() stores owner_type, group_id, created_by', () => {
      const event = createGroupEvent();
      const row = db.prepare('SELECT * FROM events WHERE id = ?').get(event.id) as CalendarEvent;
      expect(row.owner_type).toBe('group');
      expect(row.group_id).toBe(GROUP_ID);
      expect(row.created_by).toBe(CREATOR_ID);
    });

    test('findByIdInGroup() finds group event without user_id check', () => {
      const event = createGroupEvent();
      const found = events.findByIdInGroup(event.id, GROUP_ID);
      expect(found).not.toBeNull();
      expect(found!.title).toBe('Group Meeting');
    });

    test('findByIdInGroup() returns null for wrong group', () => {
      const event = createGroupEvent();
      expect(events.findByIdInGroup(event.id, 888)).toBeNull();
    });

    test('getByDateRangeForGroup() returns only group events, not personal', () => {
      createGroupEvent({ title: 'Group Event', start_at: '2026-03-12T10:00:00Z' });
      events.create({
        user_id: USER_ID,
        title: 'Personal Event',
        start_at: '2026-03-12T10:00:00Z',
        timezone: 'UTC',
      });

      const results = events.getByDateRangeForGroup(GROUP_ID, '2026-03-12T00:00:00Z', '2026-03-12T23:59:59Z');
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('Group Event');
    });

    test('getByDateRangeForGroup() returns only events for specified group', () => {
      createGroupEvent({ title: 'Group1 Event', start_at: '2026-03-12T10:00:00Z' });
      events.create({
        user_id: CREATOR_ID,
        title: 'Group2 Event',
        start_at: '2026-03-12T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: 777,
        created_by: CREATOR_ID,
      });

      const results = events.getByDateRangeForGroup(GROUP_ID, '2026-03-12T00:00:00Z', '2026-03-12T23:59:59Z');
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('Group1 Event');
    });

    test('getInRangeForGroup() returns non-recurring group events in range', () => {
      createGroupEvent({ title: 'InRange', start_at: '2026-03-12T10:00:00Z' });
      createGroupEvent({ title: 'OutOfRange', start_at: '2026-03-20T10:00:00Z' });

      const results = events.getInRangeForGroup(GROUP_ID, '2026-03-12T00:00:00Z', '2026-03-12T23:59:59Z');
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('InRange');
    });

    test('getRecurringTemplatesForGroup() returns group recurring events', () => {
      createGroupEvent({ title: 'Weekly Standup', recurrence_rule: 'FREQ=WEEKLY' });
      createGroupEvent({ title: 'One-off' });

      const templates = events.getRecurringTemplatesForGroup(GROUP_ID);
      expect(templates.length).toBe(1);
      expect(templates[0]!.title).toBe('Weekly Standup');
    });

    test('searchForGroup() searches within group events only', () => {
      createGroupEvent({ title: 'Planning Meeting' });
      events.create({
        user_id: USER_ID,
        title: 'Planning Session',
        start_at: '2026-03-12T10:00:00Z',
        timezone: 'UTC',
      });

      const results = events.searchForGroup(GROUP_ID, 'planning');
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('Planning Meeting');
    });

    test('searchForGroup() escapes LIKE wildcards', () => {
      createGroupEvent({ title: '50% off sale' });
      createGroupEvent({ title: '50 items left' });

      const results = events.searchForGroup(GROUP_ID, '50%');
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('50% off sale');
    });

    test('getUpcomingForGroup() returns upcoming group events', () => {
      createGroupEvent({ title: 'Future Group', start_at: '2099-06-01T10:00:00Z' });
      events.create({
        user_id: USER_ID,
        title: 'Future Personal',
        start_at: '2099-06-01T10:00:00Z',
        timezone: 'UTC',
      });

      const results = events.getUpcomingForGroup(GROUP_ID, 10, new Date('2026-01-01T00:00:00Z'));
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('Future Group');
    });

    test('updateInGroup() updates event by group', () => {
      const event = createGroupEvent({ title: 'Old Title' });
      const updated = events.updateInGroup(event.id, GROUP_ID, { title: 'New Title' });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('New Title');
    });

    test('updateInGroup() returns null for wrong group', () => {
      const event = createGroupEvent();
      const result = events.updateInGroup(event.id, 888, { title: 'Hacked' });
      expect(result).toBeNull();
    });

    test('removeFromGroup() deletes event by group', () => {
      const event = createGroupEvent();
      const removed = events.removeFromGroup(event.id, GROUP_ID);
      expect(removed).toBe(true);
      expect(events.findByIdInGroup(event.id, GROUP_ID)).toBeNull();
    });

    test('removeFromGroup() returns false for wrong group', () => {
      const event = createGroupEvent();
      const removed = events.removeFromGroup(event.id, 888);
      expect(removed).toBe(false);
      expect(events.findByIdInGroup(event.id, GROUP_ID)).not.toBeNull();
    });
  });
});
