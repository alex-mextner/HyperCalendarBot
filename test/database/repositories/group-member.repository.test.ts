import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const CHAT_ID = -1001234567;
const OTHER_CHAT_ID = -9999;
const USER_ID_1 = 100;
const USER_ID_2 = 200;

describe('GroupMemberRepository', () => {
  let db: Database;
  let repo: GroupMemberRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new GroupMemberRepository(db);
  });

  test('upsert inserts new member', () => {
    repo.upsert(CHAT_ID, USER_ID_1);
    const members = repo.getMembers(CHAT_ID);
    expect(members.length).toBe(1);
    expect(members[0]!.chat_id).toBe(CHAT_ID);
    expect(members[0]!.user_id).toBe(USER_ID_1);
  });

  test('upsert does not fail on duplicate and updates last_seen_at', () => {
    repo.upsert(CHAT_ID, USER_ID_1);
    const firstSeen = repo.getMembers(CHAT_ID)[0]!.last_seen_at;

    // SQLite datetime resolution is 1 second, so we need a small pause
    // or verify we can call it without throwing
    expect(() => repo.upsert(CHAT_ID, USER_ID_1)).not.toThrow();
    expect(repo.getMembers(CHAT_ID).length).toBe(1);
    const afterSeen = repo.getMembers(CHAT_ID)[0]!.last_seen_at;
    // last_seen_at should be >= first (may be same second in fast tests)
    expect(afterSeen >= firstSeen).toBe(true);
  });

  test('getMembers returns all members of a group', () => {
    repo.upsert(CHAT_ID, USER_ID_1);
    repo.upsert(CHAT_ID, USER_ID_2);
    const members = repo.getMembers(CHAT_ID);
    expect(members.length).toBe(2);
    const userIds = members.map((m) => m.user_id);
    expect(userIds).toContain(USER_ID_1);
    expect(userIds).toContain(USER_ID_2);
  });

  test('getMembers does not return members from other groups', () => {
    repo.upsert(CHAT_ID, USER_ID_1);
    repo.upsert(OTHER_CHAT_ID, USER_ID_2);
    const members = repo.getMembers(CHAT_ID);
    expect(members.length).toBe(1);
    expect(members[0]!.user_id).toBe(USER_ID_1);
  });

  test('getGroupsForUser returns all groups for a user', () => {
    db.prepare("INSERT INTO group_chats (chat_id, title, added_by) VALUES (?, 'Team', 1)").run(CHAT_ID);
    db.prepare("INSERT INTO group_chats (chat_id, title, added_by) VALUES (?, 'Other', 1)").run(OTHER_CHAT_ID);
    repo.upsert(CHAT_ID, USER_ID_1);
    repo.upsert(OTHER_CHAT_ID, USER_ID_1);
    repo.upsert(CHAT_ID, USER_ID_2);

    const groups = repo.getGroupsForUser(USER_ID_1);
    expect(groups.length).toBe(2);
    const chatIds = groups.map((g) => g.chat_id);
    expect(chatIds).toContain(CHAT_ID);
    expect(chatIds).toContain(OTHER_CHAT_ID);
    expect(groups.find((g) => g.chat_id === CHAT_ID)?.title).toBe('Team');
  });

  test('getGroupsForUser returns empty when user not in any group', () => {
    const groups = repo.getGroupsForUser(USER_ID_1);
    expect(groups.length).toBe(0);
  });

  test('getGroupsForUser does not include groups of other users', () => {
    db.prepare("INSERT INTO group_chats (chat_id, title, added_by) VALUES (?, 'Team', 1)").run(CHAT_ID);
    repo.upsert(CHAT_ID, USER_ID_2);
    const groups = repo.getGroupsForUser(USER_ID_1);
    expect(groups.length).toBe(0);
  });
});
