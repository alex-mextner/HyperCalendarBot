// test/services/event/event-service.test.ts

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
    service = new EventService({ eventRepo, reminderRepo });
  });

  test('createEvent inserts event_reminders rows when materializer is provided', () => {
    const eventReminderRepo = new EventReminderRepository(db);
    const prefsRepo = new NotificationPreferencesRepository(db);
    prefsRepo.ensureDefaults(USER_ID);
    const mat = new ReminderMaterializer(eventReminderRepo, prefsRepo);
    const svc = new EventService({
      eventRepo: new EventRepository(db),
      reminderRepo: new ReminderRepository(db),
      materializer: mat,
    });
    const event = svc.createEvent({
      user_id: USER_ID,
      title: 'Coffee',
      start_at: '2099-06-01T17:31:00Z',
      timezone: TZ,
    });
    const rows = eventReminderRepo.getForEvent(event.id);
    // default_reminder_intervals = '[30, 0]' → two reminders
    expect(rows.length).toBeGreaterThan(0);
    const thirtyMinRow = rows.find((r) => r.interval_minutes === 30);
    expect(thirtyMinRow).toBeDefined();
    expect(thirtyMinRow!.remind_at_utc).toBe('2099-06-01T17:01:00.000Z');
  });

  test('createEvent uses explicit reminder_minutes for materialization, not user prefs', () => {
    const eventReminderRepo = new EventReminderRepository(db);
    const prefsRepo = new NotificationPreferencesRepository(db);
    prefsRepo.ensureDefaults(USER_ID);
    // User prefs say 30 min, but event is created with explicit 5-min reminder
    prefsRepo.update(USER_ID, { default_reminder_intervals: JSON.stringify([30]) });
    const mat = new ReminderMaterializer(eventReminderRepo, prefsRepo);
    const svc = new EventService({
      eventRepo: new EventRepository(db),
      reminderRepo: new ReminderRepository(db),
      materializer: mat,
    });
    const event = svc.createEvent({
      user_id: USER_ID,
      title: 'Custom Reminder Event',
      start_at: '2099-06-01T10:00:00Z',
      timezone: TZ,
      reminder_minutes: [5],
    });
    const rows = eventReminderRepo.getForEvent(event.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interval_minutes).toBe(5);
    expect(rows[0]!.remind_at_utc).toBe('2099-06-01T09:55:00.000Z');
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

  describe('recurring event operations', () => {
    test('editOccurrence creates exception from template', () => {
      const template = service.createEvent({
        user_id: USER_ID,
        title: 'Weekly Standup',
        start_at: '2026-03-01T10:00:00Z',
        end_at: '2026-03-01T11:00:00Z',
        timezone: TZ,
        recurrence_rule: 'FREQ=WEEKLY',
      });

      const exception = service.editOccurrence(template.id, '2026-03-08T10:00:00Z', USER_ID);
      expect(exception).not.toBeNull();
      expect(exception!.parent_event_id).toBe(template.id);
      expect(exception!.original_start_at).toBe('2026-03-08T10:00:00Z');
      expect(exception!.title).toBe('Weekly Standup');
    });

    test('splitRecurrence splits template into two series', () => {
      const template = service.createEvent({
        user_id: USER_ID,
        title: 'Weekly',
        start_at: '2026-03-01T10:00:00Z',
        timezone: TZ,
        recurrence_rule: 'FREQ=WEEKLY',
      });

      const newTemplate = service.splitRecurrence(template.id, '2026-03-15T10:00:00Z', USER_ID);
      expect(newTemplate).not.toBeNull();
      expect(newTemplate!.start_at).toBe('2026-03-15T10:00:00Z');
      expect(newTemplate!.recurrence_rule).toBe('FREQ=WEEKLY');

      // Original template now has UNTIL
      const original = service.getEvent(template.id, USER_ID);
      expect(original!.recurrence_rule).toContain('UNTIL=');
    });

    test('deleteFuture adds UNTIL and removes future exceptions', () => {
      const template = service.createEvent({
        user_id: USER_ID,
        title: 'Daily',
        start_at: '2026-03-01T10:00:00Z',
        timezone: TZ,
        recurrence_rule: 'FREQ=DAILY',
      });

      // Create a cancelled exception in the future
      service.cancelOccurrence(template.id, USER_ID, '2026-03-20T10:00:00Z');

      service.deleteFuture(template.id, '2026-03-15T10:00:00Z', USER_ID);

      const updated = service.getEvent(template.id, USER_ID);
      expect(updated!.recurrence_rule).toContain('UNTIL=');

      // Future exceptions should be deleted
      const exceptions = db.prepare('SELECT * FROM events WHERE parent_event_id = ?').all(template.id);
      expect(exceptions.length).toBe(0);
    });
  });

  describe('group calendar', () => {
    const GROUP_ID = -100999;

    test('createEvent() with group scope sets owner_type and group_id', () => {
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'Group Standup',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      expect(event.owner_type).toBe('group');
      expect(event.group_id).toBe(GROUP_ID);
    });

    test('getEventsInRangeForGroup() returns group events with recurrence expansion', () => {
      // One-off group event
      service.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting',
        start_at: '2026-04-02T10:00:00Z',
        end_at: '2026-04-02T11:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      // Recurring group event
      service.createEvent({
        user_id: USER_ID,
        title: 'Daily Standup',
        start_at: '2026-04-01T09:00:00Z',
        end_at: '2026-04-01T09:30:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=DAILY',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      // Personal event for USER_ID — should NOT appear
      service.createEvent({
        user_id: USER_ID,
        title: 'Personal Lunch',
        start_at: '2026-04-02T12:00:00Z',
        timezone: 'UTC',
      });

      const occurrences = service.getEventsInRangeForGroup(GROUP_ID, '2026-04-02T00:00:00Z', '2026-04-02T23:59:59Z');
      const titles = occurrences.map((o) => o.event.title).sort();
      expect(titles).toContain('Group Meeting');
      expect(titles).toContain('Daily Standup');
      expect(titles).not.toContain('Personal Lunch');
    });

    test('getEventForGroup() returns group event by id', () => {
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'Group Event',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      const found = service.getEventForGroup(event.id, GROUP_ID);
      expect(found).not.toBeNull();
      expect(found!.title).toBe('Group Event');
    });

    test('getEventForGroup() returns null for wrong group', () => {
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'Group Event',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      expect(service.getEventForGroup(event.id, -999)).toBeNull();
    });

    test('updateEventForGroup() updates group event', () => {
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'Before Update',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      const updated = service.updateEventForGroup(event.id, GROUP_ID, { title: 'After Update' });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('After Update');
    });

    test('updateEventForGroup() returns null for wrong group', () => {
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'Group Event',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      const result = service.updateEventForGroup(event.id, -999, { title: 'Hacked' });
      expect(result).toBeNull();
    });

    test('deleteEventForGroup() deletes group event', () => {
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'To Delete',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      const result = service.deleteEventForGroup(event.id, GROUP_ID);
      expect(result).toBe(true);
      expect(service.getEventForGroup(event.id, GROUP_ID)).toBeNull();
    });

    test('deleteEventForGroup() returns false for wrong group', () => {
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'Group Event',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      expect(service.deleteEventForGroup(event.id, -999)).toBe(false);
    });

    test('searchEventsForGroup() finds group events by title', () => {
      service.createEvent({
        user_id: USER_ID,
        title: 'Sprint Planning',
        start_at: '2026-04-01T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      service.createEvent({
        user_id: USER_ID,
        title: 'Retro',
        start_at: '2026-04-02T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      // Personal event with same keyword — must not appear
      service.createEvent({
        user_id: USER_ID,
        title: 'Personal Sprint',
        start_at: '2026-04-01T10:00:00Z',
        timezone: 'UTC',
      });

      const results = service.searchEventsForGroup(GROUP_ID, 'Sprint');
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('Sprint Planning');
    });

    test('getUpcomingForGroup() returns upcoming group events', () => {
      const futureStart = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      service.createEvent({
        user_id: USER_ID,
        title: 'Future Group Event',
        start_at: futureStart,
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      // Personal future event — must not appear
      service.createEvent({
        user_id: USER_ID,
        title: 'Personal Future',
        start_at: futureStart,
        timezone: 'UTC',
      });

      const occurrences = service.getUpcomingForGroup(GROUP_ID);
      expect(occurrences.length).toBeGreaterThan(0);
      expect(occurrences.every((o) => o.event.group_id === GROUP_ID)).toBe(true);
      const titles = occurrences.map((o) => o.event.title);
      expect(titles).toContain('Future Group Event');
      expect(titles).not.toContain('Personal Future');
    });

    test('getUpcomingForGroup() expands recurring group events', () => {
      const now = new Date();
      const pastStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      service.createEvent({
        user_id: USER_ID,
        title: 'Daily Group Standup',
        start_at: pastStart,
        end_at: new Date(new Date(pastStart).getTime() + 30 * 60 * 1000).toISOString(),
        timezone: 'UTC',
        recurrence_rule: 'FREQ=DAILY',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      const occurrences = service.getUpcomingForGroup(GROUP_ID, 5);
      expect(occurrences.length).toBeGreaterThan(0);
      expect(occurrences.every((o) => o.event.title === 'Daily Group Standup')).toBe(true);
    });

    test('getEventsInRange() returns group-owned events created by the user', () => {
      service.createEvent({
        user_id: USER_ID,
        title: 'Group Drinks',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      service.createEvent({
        user_id: USER_ID,
        title: 'Personal Task',
        start_at: '2026-04-01T10:00:00Z',
        timezone: 'UTC',
      });

      const occurrences = service.getEventsInRange(USER_ID, '2026-04-01T00:00:00Z', '2026-04-01T23:59:59Z');
      const titles = occurrences.map((o) => o.event.title);
      expect(titles).toContain('Personal Task');
      expect(titles).toContain('Group Drinks');
    });

    test('getEventsInRange() does not return group-owned events created by another user', () => {
      const OTHER_USER = 999;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      service.createEvent({
        user_id: USER_ID,
        title: 'Group Drinks By Other',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const occurrences = service.getEventsInRange(USER_ID, '2026-04-01T00:00:00Z', '2026-04-01T23:59:59Z');
      const titles = occurrences.map((o) => o.event.title);
      expect(titles).not.toContain('Group Drinks By Other');
    });

    test('getEvent() finds group-owned events created by the user', () => {
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      const found = service.getEvent(event.id, USER_ID);
      expect(found).not.toBeNull();
      expect(found!.title).toBe('Group Meeting');
    });

    test('getEvent() returns null for group-owned events created by another user', () => {
      const OTHER_USER = 998;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting By Other',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const found = service.getEvent(event.id, USER_ID);
      expect(found).toBeNull();
    });

    test('deleteEvent() succeeds for group-owned events created by the user', () => {
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      const deleted = service.deleteEvent(event.id, USER_ID);
      expect(deleted).toBe(true);
    });

    test('deleteEvent() returns false for group-owned events created by another user', () => {
      const OTHER_USER = 997;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      const event = service.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting By Other',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const deleted = service.deleteEvent(event.id, USER_ID);
      expect(deleted).toBe(false);

      // Group event must still exist
      const found = service.getEventForGroup(event.id, GROUP_ID);
      expect(found).not.toBeNull();
    });

    test('getEventsInRange() expands group-owned recurring events created by the user', () => {
      service.createEvent({
        user_id: USER_ID,
        title: 'Group Weekly',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=WEEKLY',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      const occurrences = service.getEventsInRange(USER_ID, '2026-04-01T00:00:00Z', '2026-04-30T23:59:59Z');
      expect(occurrences.some((o) => o.event.title === 'Group Weekly')).toBe(true);
    });

    test('getEventsInRange() does not expand group-owned recurring events created by another user', () => {
      const OTHER_USER = 996;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      service.createEvent({
        user_id: USER_ID,
        title: 'Group Weekly By Other',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=WEEKLY',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const occurrences = service.getEventsInRange(USER_ID, '2026-04-01T00:00:00Z', '2026-04-30T23:59:59Z');
      expect(occurrences.some((o) => o.event.title === 'Group Weekly By Other')).toBe(false);
    });

    test('getUpcoming() includes group-owned recurring events created by the user', () => {
      service.createEvent({
        user_id: USER_ID,
        title: 'Group Standup',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=DAILY',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      service.createEvent({
        user_id: USER_ID,
        title: 'Personal Yoga',
        start_at: '2026-04-01T07:00:00Z',
        timezone: 'UTC',
      });

      const upcoming = service.getUpcoming(USER_ID, 10);
      const titles = upcoming.map((e) => e.title);
      expect(titles).toContain('Group Standup');
      expect(titles).toContain('Personal Yoga');
    });

    test('getUpcoming() does not include group-owned recurring events created by another user', () => {
      const OTHER_USER = 995;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      service.createEvent({
        user_id: USER_ID,
        title: 'Group Standup By Other',
        start_at: '2026-04-01T09:00:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=DAILY',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const upcoming = service.getUpcoming(USER_ID, 10);
      const titles = upcoming.map((e) => e.title);
      expect(titles).not.toContain('Group Standup By Other');
    });

    test('getFreeSlotsForGroup() returns free slots based on group events', () => {
      service.createEvent({
        user_id: USER_ID,
        title: 'Group Morning',
        start_at: '2026-04-05T09:00:00Z',
        end_at: '2026-04-05T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      // Personal event should not affect group free slots
      service.createEvent({
        user_id: USER_ID,
        title: 'Personal Blocker',
        start_at: '2026-04-05T12:00:00Z',
        end_at: '2026-04-05T18:00:00Z',
        timezone: 'UTC',
      });

      const slots = service.getFreeSlotsForGroup(GROUP_ID, new Date('2026-04-05T12:00:00Z'), 'UTC');
      // Group calendar only has 1h busy (09-10), so most of the day is free
      expect(slots.length).toBeGreaterThan(0);
      // Personal blocker should not reduce group free slots
      const totalFreeMinutes = slots.reduce((sum, s) => sum + s.durationMinutes, 0);
      expect(totalFreeMinutes).toBeGreaterThan(20 * 60); // at least 20h free
    });
  });

  test('deleteEvent cascades to invitations via foreign key', () => {
    const event = service.createEvent({
      user_id: USER_ID,
      title: 'Party',
      start_at: '2026-03-15T18:00:00Z',
      timezone: TZ,
    });
    new UserRepository(db).create({ telegram_id: 200 });
    db.prepare('INSERT INTO invitations (event_id, inviter_id, invitee_id) VALUES (?, ?, ?)').run(
      event.id,
      USER_ID,
      200,
    );

    service.deleteEvent(event.id, USER_ID);

    const inv = db.prepare('SELECT * FROM invitations WHERE event_id = ?').all(event.id);
    expect(inv).toHaveLength(0);
  });
});
