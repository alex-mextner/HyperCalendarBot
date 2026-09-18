import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { GroupChatRepository } from '../../src/database/repositories/group-chat.repository.ts';
import { GroupMemberRepository } from '../../src/database/repositories/group-member.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';

describe('calendar queries compare instants instead of ISO string shapes', () => {
  let db: Database;
  let events: EventRepository;
  const owner = 1001;
  const member = 1002;
  const group = -1001;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    users.create({ telegram_id: owner, timezone: 'UTC' });
    users.create({ telegram_id: member, timezone: 'UTC' });
    new GroupChatRepository(db).upsertGroup({ chat_id: group, title: 'Synthetic group', added_by: owner });
    events = new EventRepository(db);
  });
  afterEach(() => db.close());
  function add(start_at: string, end_at?: string, grouped = false) {
    return events.create({
      user_id: owner,
      title: 'UTC regression',
      start_at,
      end_at,
      timezone: 'UTC',
      ...(grouped ? { owner_type: 'group' as const, group_id: group, created_by: owner } : {}),
    });
  }

  test('offset instant crossing UTC midnight belongs to its actual day', () => {
    const event = add('2035-01-01T23:30:00-03:00');
    const start = '2035-01-02T00:00:00.000Z';
    const end = '2035-01-03T00:00:00.000Z';
    expect(events.getInRange(owner, start, end).map((e) => e.id)).toEqual([event.id]);
    expect(events.getVisibleInRange(owner, start, end).map((e) => e.id)).toEqual([event.id]);
    expect(events.countInRange(owner, start, end)).toBe(1);
  });

  test('exclusive end does not include equal instants with another precision', () => {
    add('2035-01-02T12:00:00.000Z');
    expect(events.getVisibleInRange(owner, '2035-01-02T11:00:00Z', '2035-01-02T12:00:00Z')).toHaveLength(0);
  });

  test('upcoming comparisons exclude exact now regardless of milliseconds spelling', () => {
    add('2035-01-02T12:00:00Z');
    expect(events.getUpcoming(owner, 10, new Date('2035-01-02T12:00:00.000Z'))).toHaveLength(0);
    expect(events.getVisibleUpcoming(owner, 10, new Date('2035-01-02T12:00:00.000Z'))).toHaveLength(0);
  });

  test('search and upcoming order by actual instant', () => {
    const later = add('2035-01-02T12:00:00Z');
    const earlier = add('2035-01-02T13:00:00+02:00');
    expect(events.search(owner, 'UTC').map((e) => e.id)).toEqual([earlier.id, later.id]);
    expect(events.getUpcoming(owner, 10, new Date('2035-01-02T10:00:00Z')).map((e) => e.id)).toEqual([
      earlier.id,
      later.id,
    ]);
  });

  test('explicit end and default-duration conflict checks understand offsets', () => {
    const explicit = add('2035-01-02T15:00:00+02:00', '2035-01-02T16:00:00+02:00');
    const implicit = add('2035-01-02T15:15:00+02:00');
    expect(
      events.findVisibleOverlapping(owner, '2035-01-02T13:20:00Z', '2035-01-02T13:25:00Z').map((e) => e.id),
    ).toEqual([explicit.id, implicit.id]);
  });

  test('group range and upcoming use the same instant semantics', () => {
    const event = add('2035-01-01T23:30:00-03:00', undefined, true);
    const start = '2035-01-02T00:00:00.000Z';
    const end = '2035-01-03T00:00:00.000Z';
    expect(events.getInRangeForGroup(group, start, end).map((e) => e.id)).toEqual([event.id]);
    expect(events.getByDateRangeForGroup(group, start, end).map((e) => e.id)).toEqual([event.id]);
    expect(events.getUpcomingForGroup(group, 10, new Date(start)).map((e) => e.id)).toEqual([event.id]);
  });

  test('membership fence cannot be bypassed by T versus SQLite space separator', () => {
    new GroupMemberRepository(db).upsert(group, member);
    db.run('UPDATE group_members SET joined_at=? WHERE chat_id=? AND user_id=?', [
      '2035-01-02 12:00:00',
      group,
      member,
    ]);
    const before = add('2035-01-02T11:59:59Z', undefined, true);
    const after = add('2035-01-02T12:00:01Z', undefined, true);
    expect(events.findById(before.id, member)).toBeNull();
    expect(events.findById(after.id, member)?.id).toBe(after.id);
  });

  test('membership fence compares the offset-normalized time', () => {
    new GroupMemberRepository(db).upsert(group, member);
    db.run('UPDATE group_members SET joined_at=? WHERE chat_id=? AND user_id=?', [
      '2035-01-02T12:00:00Z',
      group,
      member,
    ]);
    const before = add('2035-01-02T13:00:00+02:00', undefined, true);
    const after = add('2035-01-02T11:30:00-01:00', undefined, true);
    expect(events.findById(before.id, member)).toBeNull();
    expect(events.findById(after.id, member)?.id).toBe(after.id);
  });
  test('inclusive range and count include an offset-spelled exact endpoint', () => {
    const event = add('2035-01-02T14:00:00+02:00');
    expect(events.getInRange(owner, '2035-01-02T12:00:00.000Z', '2035-01-02T12:00:00Z').map((e) => e.id)).toEqual([
      event.id,
    ]);
    expect(events.countInRange(owner, '2035-01-02T12:00:00Z', '2035-01-02T12:00:00.000Z')).toBe(1);
    const grouped = add('2035-01-02T14:00:00+02:00', undefined, true);
    expect(
      events.getByDateRangeForGroup(group, '2035-01-02T12:00:00Z', '2035-01-02T12:00:00.000Z').map((e) => e.id),
    ).toEqual([grouped.id]);
  });

  test('default-duration overlap excludes an exactly touching endpoint', () => {
    add('2035-01-02T15:00:00+02:00');
    expect(events.findVisibleOverlapping(owner, '2035-01-02T13:30:00.000Z', '2035-01-02T14:00:00Z')).toHaveLength(0);
  });

  test('recurrence exception read/reparent/delete preserve instant-based cutoff fences', () => {
    const first = add('2035-01-01T10:00:00Z');
    const second = add('2035-01-01T11:00:00Z');
    const exception = (original_start_at: string) =>
      events.createException(first.id, {
        user_id: owner,
        title: 'Synthetic exception',
        start_at: '2035-01-02T15:00:00Z',
        timezone: 'UTC',
        original_start_at,
      });
    const before = exception('2035-01-02T13:00:00+02:00');
    const at = exception('2035-01-02T13:00:00+01:00');
    const later = exception('2035-01-02T14:00:00+01:00');
    expect(events.getExceptionsFrom(first.id, '2035-01-02T12:00:00Z').map((e) => e.id)).toEqual([at.id, later.id]);
    events.reparentExceptions(first.id, second.id, '2035-01-02T12:00:00Z');
    expect(events.getExceptions(first.id).map((e) => e.id)).toEqual([before.id]);
    expect(events.getExceptions(second.id).map((e) => e.id)).toEqual([at.id, later.id]);
    events.deleteExceptionsFrom(second.id, '2035-01-02T13:00:00Z');
    expect(events.getExceptions(second.id).map((e) => e.id)).toEqual([at.id]);
    expect(events.getExceptions(first.id).map((e) => e.id)).toEqual([before.id]);
  });

  test('corrupt legacy dates fail closed in range and membership predicates', () => {
    const event = add('2035-01-02T12:00:00Z');
    db.run('UPDATE events SET start_at=? WHERE id=?', ['not a timestamp', event.id]);
    expect(events.getVisibleInRange(owner, '2035-01-02T00:00:00Z', '2035-01-03T00:00:00Z')).toHaveLength(0);
    new GroupMemberRepository(db).upsert(group, member);
    db.run('UPDATE group_members SET joined_at=? WHERE chat_id=? AND user_id=?', ['not a timestamp', group, member]);
    const grouped = add('2035-01-02T12:00:00Z', undefined, true);
    expect(events.findById(grouped.id, member)).toBeNull();
  });

  test('the actual SQLite runtime normalizes offsets, precision and separators', () => {
    const row = db
      .query<{ a: number; b: number; c: number; version: string }, []>(
        "SELECT julianday('2035-01-02T14:00:00+02:00') AS a, julianday('2035-01-02T12:00:00.000Z') AS b, julianday('2035-01-02 12:00:00') AS c, sqlite_version() AS version",
      )
      .get();
    expect(row?.a).toBe(row?.b);
    expect(row?.b).toBe(row?.c);
    expect(Number.isFinite(row?.a)).toBe(true);
  });
});
