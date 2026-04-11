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

  test('findLatestCreatedByUser returns null when no events', () => {
    expect(events.findLatestCreatedByUser(USER_ID)).toBeNull();
  });

  test('findLatestCreatedByUser returns the most recently inserted event', () => {
    events.create({ user_id: USER_ID, title: 'First', start_at: '2026-03-10T10:00:00Z', timezone: 'UTC' });
    const second = events.create({
      user_id: USER_ID,
      title: 'Second',
      start_at: '2026-03-11T10:00:00Z',
      timezone: 'UTC',
    });
    expect(events.findLatestCreatedByUser(USER_ID)!.id).toBe(second.id);
  });

  test('findLatestCreatedByUser excludes group-owned events for the same user', () => {
    // Group event stored under USER_ID but with owner_type='group' — must be excluded
    events.create({
      user_id: USER_ID,
      title: 'GroupEvent',
      start_at: '2026-03-12T10:00:00Z',
      timezone: 'UTC',
      owner_type: 'group',
      group_id: 1,
    });
    const personal = events.create({
      user_id: USER_ID,
      title: 'Personal',
      start_at: '2026-03-10T10:00:00Z',
      timezone: 'UTC',
    });
    expect(events.findLatestCreatedByUser(USER_ID)!.id).toBe(personal.id);
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

  test('remove soft-deletes event (row persists, filtered from reads)', () => {
    const created = events.create({
      user_id: USER_ID,
      title: 'Del',
      start_at: '2026-03-11T10:00:00Z',
      timezone: 'UTC',
    });
    const removed = events.remove(created.id, USER_ID);
    expect(removed).toBe(true);
    // User-facing read filters out soft-deleted rows.
    expect(events.findById(created.id, USER_ID)).toBeNull();
    // But the row itself still exists — downstream systems (edit proposals,
    // action log) can still resolve the title by id.
    const raw = events.findByIdIncludingDeleted(created.id);
    expect(raw).not.toBeNull();
    expect(raw!.title).toBe('Del');
    expect(raw!.is_deleted).toBe(1);
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

  describe('birthday queries', () => {
    test('create stores event_type when provided', () => {
      const event = events.create({
        user_id: USER_ID,
        title: 'Д/р Ivan',
        start_at: '2026-05-10T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      expect(event.event_type).toBe('birthday');
    });

    test('getBirthdays returns only birthday events for personal calendar', () => {
      events.create({
        user_id: USER_ID,
        title: 'Д/р Ivan',
        start_at: '2026-06-15T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      events.create({
        user_id: USER_ID,
        title: 'Meeting',
        start_at: '2026-06-16T00:00:00Z',
        all_day: false,
        timezone: 'UTC',
      });
      const results = events.getBirthdays(USER_ID);
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('Д/р Ivan');
    });

    test('getBirthdays populates birth_year and celebrant_id from metadata', () => {
      const { id } = events.create({
        user_id: USER_ID,
        title: 'Д/р Ivan',
        start_at: '2026-05-10T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      db.prepare(
        'INSERT INTO birth_event_metadata (event_id, celebrant_id, birth_year, auto_created) VALUES (?, ?, ?, 0)',
      ).run(id, 42, 1996);
      const results = events.getBirthdays(USER_ID);
      const ev = results.find((e) => e.id === id)!;
      expect(ev.birth_year).toBe(1996);
      expect(ev.celebrant_id).toBe(42);
    });

    test('getBirthdays returns null birth_year when no metadata', () => {
      const { id } = events.create({
        user_id: USER_ID,
        title: 'Д/р Anna',
        start_at: '2026-06-01T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      const results = events.getBirthdays(USER_ID);
      const ev = results.find((e) => e.id === id)!;
      expect(ev.birth_year ?? null).toBeNull();
      expect(ev.celebrant_id ?? null).toBeNull();
    });

    test('getBirthdaysForGroup returns birthday events in group calendar', () => {
      db.prepare("INSERT INTO group_chats (chat_id, title, added_by) VALUES (100, 'Team', ?)").run(USER_ID);
      events.create({
        user_id: USER_ID,
        title: 'Д/р Bob',
        start_at: '2026-07-01T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
        owner_type: 'group',
        group_id: 100,
      });
      const results = events.getBirthdaysForGroup(100);
      expect(results.length).toBe(1);
    });

    test('getBirthdaysForGroup populates birth_year and celebrant_id from metadata', () => {
      db.prepare("INSERT OR IGNORE INTO group_chats (chat_id, title, added_by) VALUES (101, 'Team2', ?)").run(USER_ID);
      const { id } = events.create({
        user_id: USER_ID,
        title: 'Д/р Kate',
        start_at: '2026-08-15T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
        owner_type: 'group',
        group_id: 101,
      });
      db.prepare(
        'INSERT INTO birth_event_metadata (event_id, celebrant_id, birth_year, auto_created) VALUES (?, ?, ?, 0)',
      ).run(id, 99, 2000);
      const results = events.getBirthdaysForGroup(101);
      const ev = results.find((e) => e.id === id)!;
      expect(ev.birth_year).toBe(2000);
      expect(ev.celebrant_id).toBe(99);
    });

    test('searchWithEventType filters by event_type=birthday', () => {
      events.create({
        user_id: USER_ID,
        title: 'Д/р Ivan',
        start_at: '2026-05-10T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      events.create({
        user_id: USER_ID,
        title: 'Meeting',
        start_at: '2026-05-11T00:00:00Z',
        all_day: false,
        timezone: 'UTC',
      });
      const results = events.searchWithEventType(USER_ID, null, 'birthday');
      expect(results.every((e) => e.event_type === 'birthday')).toBe(true);
      expect(results.length).toBe(1);
    });

    test('searchWithEventType populates birth_year from metadata', () => {
      const { id } = events.create({
        user_id: USER_ID,
        title: 'Д/р Ivan',
        start_at: '2026-05-10T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      db.prepare(
        'INSERT INTO birth_event_metadata (event_id, celebrant_id, birth_year, auto_created) VALUES (?, ?, ?, 0)',
      ).run(id, 42, 1996);
      const results = events.searchWithEventType(USER_ID, null, 'birthday');
      const ev = results.find((e) => e.id === id)!;
      expect(ev.birth_year).toBe(1996);
      expect(ev.celebrant_id).toBe(42);
    });

    test('searchWithEventType with query filters by title', () => {
      events.create({
        user_id: USER_ID,
        title: 'Д/р Ivan',
        start_at: '2026-05-10T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      events.create({
        user_id: USER_ID,
        title: 'Д/р Anna',
        start_at: '2026-05-11T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      const results = events.searchWithEventType(USER_ID, 'ivan', null);
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('Д/р Ivan');
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

  describe('search includes accepted participant events', () => {
    const OWNER_ID = USER_ID;
    const PARTICIPANT_ID = 456;

    beforeEach(() => {
      new UserRepository(db).create({ telegram_id: PARTICIPANT_ID });
    });

    function addParticipant(eventId: number, userId: number, status: string) {
      db.prepare('INSERT INTO event_participants (event_id, user_id, status) VALUES (?, ?, ?)').run(
        eventId,
        userId,
        status,
      );
    }

    test('searchWithEventType finds events where user is an accepted participant', () => {
      const event = events.create({
        user_id: OWNER_ID,
        title: 'Team Planning',
        start_at: '2026-05-20T10:00:00Z',
        timezone: 'UTC',
      });
      addParticipant(event.id, PARTICIPANT_ID, 'accepted');

      const results = events.searchWithEventType(PARTICIPANT_ID, 'planning', null);
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('Team Planning');
    });

    test('searchWithEventType does NOT find events where user is a declined participant', () => {
      const event = events.create({
        user_id: OWNER_ID,
        title: 'Team Planning',
        start_at: '2026-05-20T10:00:00Z',
        timezone: 'UTC',
      });
      addParticipant(event.id, PARTICIPANT_ID, 'declined');

      const results = events.searchWithEventType(PARTICIPANT_ID, 'planning', null);
      expect(results.length).toBe(0);
    });

    test('search finds events where user is an accepted participant', () => {
      const event = events.create({
        user_id: OWNER_ID,
        title: 'Quarterly Review',
        start_at: '2026-06-01T14:00:00Z',
        timezone: 'UTC',
      });
      addParticipant(event.id, PARTICIPANT_ID, 'accepted');

      const results = events.search(PARTICIPANT_ID, 'quarterly');
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('Quarterly Review');
    });

    test('search does NOT find events where user is a declined participant', () => {
      const event = events.create({
        user_id: OWNER_ID,
        title: 'Quarterly Review',
        start_at: '2026-06-01T14:00:00Z',
        timezone: 'UTC',
      });
      addParticipant(event.id, PARTICIPANT_ID, 'declined');

      const results = events.search(PARTICIPANT_ID, 'quarterly');
      expect(results.length).toBe(0);
    });
  });

  test('searchWithEventType with event_type=regular returns non-birthday events', () => {
    events.create({
      user_id: USER_ID,
      title: 'Meeting',
      start_at: '2026-05-11T00:00:00Z',
      all_day: false,
      timezone: 'UTC',
    });
    events.create({
      user_id: USER_ID,
      title: 'Д/р Ivan',
      start_at: '2026-05-10T00:00:00Z',
      all_day: true,
      timezone: 'UTC',
      event_type: 'birthday',
    });
    const results = events.searchWithEventType(USER_ID, null, 'regular');
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe('Meeting');
  });
});

describe('EventRepository.updateSyncFields column allowlist', () => {
  let db: Database;
  let events: EventRepository;
  const USER_ID = 1;

  beforeEach(() => {
    db = createTestDb();
    events = new EventRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  function createSyncedEvent() {
    return events.create({
      user_id: USER_ID,
      title: 'Test',
      start_at: '2026-03-15T10:00:00Z',
      end_at: '2026-03-15T11:00:00Z',
      all_day: false,
      timezone: 'UTC',
    });
  }

  test('allowed fields update successfully', () => {
    const event = createSyncedEvent();
    expect(() =>
      events.updateSyncFields(event.id, {
        google_event_id: 'g1',
        sync_status: 'synced',
        last_synced_at: new Date().toISOString(),
      }),
    ).not.toThrow();
  });

  test('unknown field throws with descriptive error', () => {
    const event = createSyncedEvent();
    expect(() => events.updateSyncFields(event.id, { injected_column: 'DROP TABLE events' } as never)).toThrow(
      'Unknown sync field: injected_column',
    );
  });

  test('multiple unknown fields each throw', () => {
    const event = createSyncedEvent();
    expect(() => events.updateSyncFields(event.id, { malicious: '1; DROP TABLE events; --' } as never)).toThrow(
      'Unknown sync field: malicious',
    );
  });
});
