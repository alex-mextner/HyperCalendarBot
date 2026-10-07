import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CreateEventData } from '../../../src/database/types.ts';
import { EventService, type FreeSlot } from '../../../src/services/event/event-service.ts';
import { getDayRangeUtc } from '../../../src/utils/date.ts';

const USER_ID = 123;
const OTHER_USER = 456;
const GROUP_ID = -100500;
const OTHER_GROUP = -100600;
const DAY = new Date('2026-06-10T12:00:00Z');

function bounds(slots: FreeSlot[]): string[][] {
  return slots.map((s) => [s.start, s.end]);
}

function totalMinutes(slots: FreeSlot[]): number {
  return slots.reduce((sum, s) => sum + s.durationMinutes, 0);
}

describe('EventService free slots', () => {
  let db: Database;
  let service: EventService;
  let eventRepo: EventRepository;
  let participants: ParticipantRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    users.create({ telegram_id: USER_ID });
    users.create({ telegram_id: OTHER_USER });
    participants = new ParticipantRepository(db);
    eventRepo = new EventRepository(db);
    service = new EventService({
      eventRepo,
      groupMemberRepo: new GroupMemberRepository(db),
      participantRepo: participants,
    });
  });

  function personal(title: string, startAt: string, endAt?: string, extra: Partial<CreateEventData> = {}) {
    return service.createEvent({
      user_id: USER_ID,
      title,
      start_at: startAt,
      end_at: endAt,
      timezone: 'UTC',
      ...extra,
    });
  }

  function addMember(userId: number, chatId: number, joinedAt: string, leftAt: string | null = null) {
    db.prepare('INSERT INTO group_members (chat_id, user_id, joined_at, left_at) VALUES (?, ?, ?, ?)').run(
      chatId,
      userId,
      joinedAt,
      leftAt,
    );
  }

  function assertInsideDay(slots: FreeSlot[], date: Date, tz: string) {
    const { start, end } = getDayRangeUtc(date, tz);
    for (const s of slots) {
      expect(new Date(s.start).getTime()).toBeGreaterThanOrEqual(new Date(start).getTime());
      expect(new Date(s.end).getTime()).toBeLessThanOrEqual(new Date(end).getTime());
      expect(new Date(s.end).getTime()).toBeGreaterThan(new Date(s.start).getTime());
    }
  }

  describe('timed events', () => {
    test('11:00-13:00 blocks 12:00', () => {
      personal('Lunch', '2026-06-10T11:00:00Z', '2026-06-10T13:00:00Z');
      const slots = service.getFreeSlots(USER_ID, DAY, 'UTC');
      expect(bounds(slots)).toEqual([
        ['2026-06-10T00:00:00.000Z', '2026-06-10T11:00:00.000Z'],
        ['2026-06-10T13:00:00.000Z', '2026-06-10T23:59:59.999Z'],
      ]);
    });

    test('an event without an end blocks the default 30 minutes', () => {
      personal('Call', '2026-06-10T10:00:00Z');
      const slots = service.getFreeSlots(USER_ID, DAY, 'UTC');
      expect(bounds(slots)).toEqual([
        ['2026-06-10T00:00:00.000Z', '2026-06-10T10:00:00.000Z'],
        ['2026-06-10T10:30:00.000Z', '2026-06-10T23:59:59.999Z'],
      ]);
    });

    test('an event that started the previous night blocks the morning', () => {
      personal('Night shift', '2026-06-09T23:00:00Z', '2026-06-10T01:00:00Z');
      const slots = service.getFreeSlots(USER_ID, DAY, 'UTC');
      expect(slots[0]!.start).toBe('2026-06-10T01:00:00.000Z');
      expect(totalMinutes(slots)).toBe(23 * 60);
    });

    test('an event ending exactly at the day start does not block the day', () => {
      personal('Late', '2026-06-09T23:00:00Z', '2026-06-10T00:00:00Z');
      const slots = service.getFreeSlots(USER_ID, DAY, 'UTC');
      expect(slots).toHaveLength(1);
      expect(slots[0]!.start).toBe('2026-06-10T00:00:00.000Z');
    });

    test('a multi-day event blocks the whole day and no slot leaves the day', () => {
      personal('Trip', '2026-06-09T20:00:00Z', '2026-06-11T04:00:00Z');
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')).toEqual([]);
    });

    test('overlapping events merge and slots stay inside the day', () => {
      personal('A', '2026-06-10T10:00:00Z', '2026-06-10T12:00:00Z');
      personal('B', '2026-06-10T11:00:00Z', '2026-06-10T13:00:00Z');
      personal('C', '2026-06-10T10:30:00Z', '2026-06-10T11:00:00Z');
      personal('Tail', '2026-06-10T23:00:00Z', '2026-06-11T02:00:00Z');
      const slots = service.getFreeSlots(USER_ID, DAY, 'UTC');
      expect(bounds(slots)).toEqual([
        ['2026-06-10T00:00:00.000Z', '2026-06-10T10:00:00.000Z'],
        ['2026-06-10T13:00:00.000Z', '2026-06-10T23:00:00.000Z'],
      ]);
      assertInsideDay(slots, DAY, 'UTC');
    });

    test('a west-of-UTC local day starts at its own local midnight', () => {
      const date = new Date('2026-03-15T18:00:00Z');
      personal('Prev evening local', '2026-03-15T01:00:00Z', '2026-03-15T02:00:00Z');
      const slots = service.getFreeSlots(USER_ID, date, 'America/New_York');
      expect(slots).toHaveLength(1);
      expect(slots[0]!.start).toBe('2026-03-15T04:00:00.000Z');
      assertInsideDay(slots, date, 'America/New_York');
    });
  });

  describe('all-day events', () => {
    test.each(['2026-06-10', '2026-06-10T00:00:00Z'])('null end blocks the whole local day (%s)', (startAt) => {
      personal('Holiday', startAt, undefined, { all_day: true });
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')).toEqual([]);
      const next = service.getFreeSlots(USER_ID, new Date('2026-06-11T12:00:00Z'), 'UTC');
      expect(next).toHaveLength(1);
      expect(next[0]!.durationMinutes).toBe(1440);
    });

    test('date-only value blocks its calendar day west of UTC and leaves the neighbours free', () => {
      personal('Holiday', '2026-03-15', undefined, { all_day: true });
      const tz = 'America/New_York';
      expect(service.getFreeSlots(USER_ID, new Date('2026-03-15T18:00:00Z'), tz)).toEqual([]);
      expect(service.getFreeSlots(USER_ID, new Date('2026-03-14T18:00:00Z'), tz)).toHaveLength(1);
      expect(service.getFreeSlots(USER_ID, new Date('2026-03-16T18:00:00Z'), tz)).toHaveLength(1);
    });

    test.each([
      ['2026-03-29', 'spring-forward 23h day'],
      ['2026-10-25', 'fall-back 25h day'],
    ])('blocks the whole DST day %s (%s)', (date) => {
      personal('DST holiday', date, undefined, { all_day: true });
      const noon = new Date(`${date}T12:00:00Z`);
      expect(service.getFreeSlots(USER_ID, noon, 'Europe/Belgrade')).toEqual([]);
    });

    test('a timed event on a DST day leaves exactly the rest of the 23h day free', () => {
      const noon = new Date('2026-03-29T12:00:00Z');
      personal('Morning', '2026-03-29T07:00:00Z', '2026-03-29T08:00:00Z');
      const slots = service.getFreeSlots(USER_ID, noon, 'Europe/Belgrade');
      expect(totalMinutes(slots)).toBe(22 * 60);
    });

    test('a Google-style date range blocks each day up to the exclusive end date', () => {
      personal('Conference', '2026-06-09', '2026-06-11', { all_day: true });
      expect(service.getFreeSlots(USER_ID, new Date('2026-06-09T12:00:00Z'), 'UTC')).toEqual([]);
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')).toEqual([]);
      expect(service.getFreeSlots(USER_ID, new Date('2026-06-11T12:00:00Z'), 'UTC')).toHaveLength(1);
    });

    test('a same-day all-day end does not block the next day', () => {
      personal('Bot all-day', '2026-06-10T00:00:00Z', '2026-06-10T23:59:59Z', { all_day: true });
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')).toEqual([]);
      expect(service.getFreeSlots(USER_ID, new Date('2026-06-11T12:00:00Z'), 'UTC')).toHaveLength(1);
    });
  });

  describe('recurring events', () => {
    test('an occurrence that spans midnight from the previous night blocks the morning', () => {
      personal('Nightly', '2026-06-01T23:00:00Z', '2026-06-02T01:00:00Z', { recurrence_rule: 'FREQ=DAILY' });
      const slots = service.getFreeSlots(USER_ID, DAY, 'UTC');
      expect(bounds(slots)).toEqual([['2026-06-10T01:00:00.000Z', '2026-06-10T23:00:00.000Z']]);
    });

    test('a recurring event without an end blocks the default 30 minutes', () => {
      personal('Standup', '2026-06-01T09:00:00Z', undefined, { recurrence_rule: 'FREQ=DAILY' });
      const slots = service.getFreeSlots(USER_ID, DAY, 'UTC');
      expect(bounds(slots).slice(0, 2)).toEqual([
        ['2026-06-10T00:00:00.000Z', '2026-06-10T09:00:00.000Z'],
        ['2026-06-10T09:30:00.000Z', '2026-06-10T23:59:59.999Z'],
      ]);
    });

    test('a recurring all-day event blocks its local day west of UTC', () => {
      personal('Yearly', '2025-03-15T00:00:00Z', undefined, { all_day: true, recurrence_rule: 'FREQ=YEARLY' });
      const tz = 'America/New_York';
      expect(service.getFreeSlots(USER_ID, new Date('2026-03-15T18:00:00Z'), tz)).toEqual([]);
      expect(service.getFreeSlots(USER_ID, new Date('2026-03-14T18:00:00Z'), tz)).toHaveLength(1);
    });

    test('an exception moved into the day blocks its new time', () => {
      const template = personal('Daily', '2026-06-01T09:00:00Z', '2026-06-01T10:00:00Z', {
        recurrence_rule: 'FREQ=DAILY',
      });
      eventRepo.createException(template.id, {
        user_id: USER_ID,
        title: 'Daily (moved)',
        start_at: '2026-06-10T15:00:00Z',
        end_at: '2026-06-10T16:00:00Z',
        timezone: 'UTC',
        original_start_at: '2026-06-02T09:00:00Z',
      });
      const slots = service.getFreeSlots(USER_ID, DAY, 'UTC');
      expect(slots.some((s) => s.start <= '2026-06-10T15:30:00.000Z' && s.end >= '2026-06-10T15:30:00.000Z')).toBe(
        false,
      );
    });

    test('a cancelled occurrence does not block', () => {
      const template = personal('Daily', '2026-06-01T09:00:00Z', '2026-06-01T10:00:00Z', {
        recurrence_rule: 'FREQ=DAILY',
      });
      eventRepo.createException(template.id, {
        user_id: USER_ID,
        title: 'Daily',
        start_at: '2026-06-10T09:00:00Z',
        timezone: 'UTC',
        original_start_at: '2026-06-10T09:00:00Z',
        is_cancelled: true,
      });
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')).toHaveLength(1);
    });
  });

  describe('ownership boundaries', () => {
    test("another user's events do not block personal slots", () => {
      service.createEvent({
        user_id: OTHER_USER,
        title: 'Other',
        start_at: '2026-06-10T11:00:00Z',
        end_at: '2026-06-10T13:00:00Z',
        timezone: 'UTC',
      });
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')).toHaveLength(1);
    });

    test('a group event of a group the user never joined does not block', () => {
      service.createEvent({
        user_id: OTHER_USER,
        title: 'Foreign group',
        start_at: '2026-06-10T11:00:00Z',
        end_at: '2026-06-10T13:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: OTHER_GROUP,
        created_by: OTHER_USER,
      });
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')).toHaveLength(1);
    });

    test('a joined group event that started the previous night blocks the member', () => {
      addMember(USER_ID, GROUP_ID, '2026-01-01T00:00:00Z');
      service.createEvent({
        user_id: OTHER_USER,
        title: 'Group night',
        start_at: '2026-06-09T23:00:00Z',
        end_at: '2026-06-10T01:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')[0]!.start).toBe('2026-06-10T01:00:00.000Z');
    });

    test('an accepted participation blocks and a pending one does not', () => {
      const event = service.createEvent({
        user_id: OTHER_USER,
        title: 'Invited',
        start_at: '2026-06-10T11:00:00Z',
        end_at: '2026-06-10T13:00:00Z',
        timezone: 'UTC',
      });
      participants.add(event.id, USER_ID, 'pending');
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')).toHaveLength(1);
      participants.updateStatus(event.id, USER_ID, 'accepted');
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')).toHaveLength(2);
    });

    test('recurring group occurrences respect membership bounds stored in SQLite format', () => {
      addMember(USER_ID, GROUP_ID, '2026-06-10 12:00:00');
      service.createEvent({
        user_id: OTHER_USER,
        title: 'Group standup',
        start_at: '2026-06-01T09:00:00Z',
        end_at: '2026-06-01T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
        recurrence_rule: 'FREQ=DAILY',
      });
      expect(service.getFreeSlots(USER_ID, DAY, 'UTC')).toHaveLength(1);
      expect(service.getFreeSlots(USER_ID, new Date('2026-06-11T12:00:00Z'), 'UTC')).toHaveLength(2);
    });

    test('group slots include the previous-night group event and ignore personal and other-group events', () => {
      const group = {
        owner_type: 'group' as const,
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      };
      service.createEvent({
        user_id: OTHER_USER,
        title: 'Group night',
        start_at: '2026-06-09T23:00:00Z',
        end_at: '2026-06-10T01:00:00Z',
        timezone: 'UTC',
        ...group,
      });
      service.createEvent({
        user_id: OTHER_USER,
        title: 'Group no end',
        start_at: '2026-06-10T10:00:00Z',
        timezone: 'UTC',
        ...group,
      });
      service.createEvent({
        user_id: OTHER_USER,
        title: 'Other group',
        start_at: '2026-06-10T14:00:00Z',
        end_at: '2026-06-10T16:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: OTHER_GROUP,
        created_by: OTHER_USER,
      });
      personal('Personal', '2026-06-10T18:00:00Z', '2026-06-10T20:00:00Z');
      const slots = service.getFreeSlotsForGroup(GROUP_ID, DAY, 'UTC');
      expect(bounds(slots)).toEqual([
        ['2026-06-10T01:00:00.000Z', '2026-06-10T10:00:00.000Z'],
        ['2026-06-10T10:30:00.000Z', '2026-06-10T23:59:59.999Z'],
      ]);
    });

    test('a group all-day event blocks the local day', () => {
      service.createEvent({
        user_id: OTHER_USER,
        title: 'Group holiday',
        start_at: '2026-03-15',
        timezone: 'UTC',
        all_day: true,
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });
      expect(service.getFreeSlotsForGroup(GROUP_ID, new Date('2026-03-15T18:00:00Z'), 'America/New_York')).toEqual([]);
    });
  });
});
