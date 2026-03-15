import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GroupChatRepository } from '../../../src/database/repositories/group-chat.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;
const GROUP_ID = -1001234;

describe('GroupChatRepository', () => {
  let db: Database;
  let repo: GroupChatRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new GroupChatRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('upsertGroup creates group record', () => {
    repo.upsertGroup({ chat_id: GROUP_ID, title: 'Dev Team', added_by: USER_ID });
    const group = repo.findByChatId(GROUP_ID);
    expect(group).not.toBeNull();
    expect(group!.title).toBe('Dev Team');
    expect(group!.is_active).toBe(1);
  });

  test('upsertGroup reactivates deactivated group', () => {
    repo.upsertGroup({ chat_id: GROUP_ID, added_by: USER_ID });
    repo.deactivate(GROUP_ID);
    expect(repo.findByChatId(GROUP_ID)!.is_active).toBe(0);
    repo.upsertGroup({ chat_id: GROUP_ID, title: 'Updated', added_by: USER_ID });
    const group = repo.findByChatId(GROUP_ID)!;
    expect(group.is_active).toBe(1);
    expect(group.title).toBe('Updated');
  });

  test('findByChatId returns null for missing group', () => {
    expect(repo.findByChatId(-999)).toBeNull();
  });

  test('shareEvent links event to group', () => {
    repo.upsertGroup({ chat_id: GROUP_ID, added_by: USER_ID });
    const eventId = new EventRepository(db).create({
      user_id: USER_ID,
      title: 'Standup',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    }).id;
    repo.shareEvent(GROUP_ID, eventId, USER_ID);
    expect(repo.getSharedEvents(GROUP_ID)).toHaveLength(1);
  });

  test('shareEvent ignores duplicate', () => {
    repo.upsertGroup({ chat_id: GROUP_ID, added_by: USER_ID });
    const eventId = new EventRepository(db).create({
      user_id: USER_ID,
      title: 'Standup',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    }).id;
    repo.shareEvent(GROUP_ID, eventId, USER_ID);
    repo.shareEvent(GROUP_ID, eventId, USER_ID);
    expect(repo.getSharedEvents(GROUP_ID)).toHaveLength(1);
  });

  test('unshareEvent removes event from group', () => {
    repo.upsertGroup({ chat_id: GROUP_ID, added_by: USER_ID });
    const eventId = new EventRepository(db).create({
      user_id: USER_ID,
      title: 'Standup',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    }).id;
    repo.shareEvent(GROUP_ID, eventId, USER_ID);
    expect(repo.unshareEvent(GROUP_ID, eventId, USER_ID)).toBe(true);
    expect(repo.getSharedEvents(GROUP_ID)).toHaveLength(0);
  });

  test('unshareEvent returns false for non-existent share', () => {
    expect(repo.unshareEvent(GROUP_ID, 999, USER_ID)).toBe(false);
  });

  test('deactivate sets is_active to 0', () => {
    repo.upsertGroup({ chat_id: GROUP_ID, added_by: USER_ID });
    repo.deactivate(GROUP_ID);
    expect(repo.findByChatId(GROUP_ID)!.is_active).toBe(0);
  });

  test('getSharedEventsPaginated returns paginated results', () => {
    repo.upsertGroup({ chat_id: GROUP_ID, added_by: USER_ID });
    const eventRepo = new EventRepository(db);
    for (let i = 0; i < 15; i++) {
      const event = eventRepo.create({
        user_id: USER_ID,
        title: `Event ${i}`,
        start_at: `2026-03-${String(15 + i).padStart(2, '0')}T10:00:00Z`,
        timezone: 'UTC',
      });
      repo.shareEvent(GROUP_ID, event.id, USER_ID);
    }

    const page1 = repo.getSharedEventsPaginated(GROUP_ID, 0, 10);
    expect(page1.total).toBe(15);
    expect(page1.items).toHaveLength(10);

    const page2 = repo.getSharedEventsPaginated(GROUP_ID, 10, 10);
    expect(page2.total).toBe(15);
    expect(page2.items).toHaveLength(5);
  });

  test('getSharedEventsPaginated orders by event start_at ASC', () => {
    repo.upsertGroup({ chat_id: GROUP_ID, added_by: USER_ID });
    const eventRepo = new EventRepository(db);
    const late = eventRepo.create({
      user_id: USER_ID,
      title: 'Late Event',
      start_at: '2026-03-30T10:00:00Z',
      timezone: 'UTC',
    });
    const early = eventRepo.create({
      user_id: USER_ID,
      title: 'Early Event',
      start_at: '2026-03-01T10:00:00Z',
      timezone: 'UTC',
    });
    repo.shareEvent(GROUP_ID, late.id, USER_ID);
    repo.shareEvent(GROUP_ID, early.id, USER_ID);

    const result = repo.getSharedEventsPaginated(GROUP_ID, 0, 10);
    expect(result.items[0]!.event_id).toBe(early.id);
    expect(result.items[1]!.event_id).toBe(late.id);
  });

  test('getSharedEventsPaginated returns empty for no events', () => {
    repo.upsertGroup({ chat_id: GROUP_ID, added_by: USER_ID });
    const result = repo.getSharedEventsPaginated(GROUP_ID, 0, 10);
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });
});
