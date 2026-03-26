// test/database/repositories/action-log.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations';
import { ActionLogRepository, telegramMessageLink } from '../../../src/database/repositories/action-log.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { runMigrations } from '../../../src/database/schema';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;
const CHAT_ID = 100;

describe('ActionLogRepository', () => {
  let db: Database;
  let repo: ActionLogRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new ActionLogRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('insert creates an action log entry with defaults', () => {
    const entry = repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'command',
      action_name: '/add',
    });
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.user_id).toBe(USER_ID);
    expect(entry.action_type).toBe('command');
    expect(entry.action_name).toBe('/add');
    expect(entry.success).toBe(1);
    expect(entry.message_id).toBeNull();
    expect(entry.metadata).toBeNull();
    expect(entry.target_event_id).toBeNull();
    expect(entry.created_at).toBeTruthy();
  });

  test('insert stores all optional fields', () => {
    const entry = repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'create_event',
      message_id: 42,
      input_summary: 'Meeting tomorrow',
      result_summary: 'id: 1\ntitle: Meeting',
      metadata: JSON.stringify({ title: 'Meeting', start_at: '2026-03-26T10:00:00Z' }),
      target_event_id: 1,
      target_user_id: 200,
      success: true,
    });
    expect(entry.message_id).toBe(42);
    expect(entry.input_summary).toBe('Meeting tomorrow');
    expect(entry.target_event_id).toBe(1);
    expect(entry.target_user_id).toBe(200);
    expect(entry.success).toBe(1);
  });

  test('insert with success=false stores 0', () => {
    const entry = repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'delete_event',
      success: false,
    });
    expect(entry.success).toBe(0);
  });

  test('findById returns entry by id', () => {
    const created = repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'command',
      action_name: '/delete',
    });
    const found = repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found!.action_name).toBe('/delete');
  });

  test('findById returns null for non-existent id', () => {
    expect(repo.findById(999)).toBeNull();
  });

  test('query filters by user_id', () => {
    const otherUser = 200;
    new UserRepository(db).create({ telegram_id: otherUser });
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'command', action_name: '/add' });
    repo.insert({ user_id: otherUser, chat_id: otherUser, action_type: 'command', action_name: '/add' });

    const results = repo.query({ user_id: USER_ID });
    expect(results).toHaveLength(1);
    expect(results[0]!.user_id).toBe(USER_ID);
  });

  test('query filters by action_type', () => {
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'command', action_name: '/add' });
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'ai_tool', action_name: 'create_event' });
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'callback', action_name: 'edit' });

    const results = repo.query({ user_id: USER_ID, action_type: 'ai_tool' });
    expect(results).toHaveLength(1);
    expect(results[0]!.action_name).toBe('create_event');
  });

  test('query filters by target_event_id', () => {
    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'delete_event',
      target_event_id: 42,
    });
    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'update_event',
      target_event_id: 43,
    });

    const results = repo.query({ target_event_id: 42 });
    expect(results).toHaveLength(1);
    expect(results[0]!.action_name).toBe('delete_event');
  });

  test('query respects limit', () => {
    for (let i = 0; i < 10; i++) {
      repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'command', action_name: `/cmd${i}` });
    }
    const results = repo.query({ user_id: USER_ID, limit: 3 });
    expect(results).toHaveLength(3);
  });

  test('query orders by created_at DESC', () => {
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'command', action_name: '/first' });
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'command', action_name: '/second' });

    const results = repo.query({ user_id: USER_ID });
    expect(results[0]!.action_name).toBe('/second');
    expect(results[1]!.action_name).toBe('/first');
  });

  test('getByEvent returns actions for a specific event', () => {
    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'create_event',
      target_event_id: 10,
    });
    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'update_event',
      target_event_id: 10,
    });
    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'delete_event',
      target_event_id: 20,
    });

    const results = repo.getByEvent(10);
    expect(results).toHaveLength(2);
  });

  test('getRecent returns recent actions for user', () => {
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'command', action_name: '/add' });
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'ai_tool', action_name: 'create_event' });

    const results = repo.getRecent(USER_ID, 10);
    expect(results).toHaveLength(2);
  });

  test('getRecent returns empty for user with no actions', () => {
    expect(repo.getRecent(999, 10)).toHaveLength(0);
  });

  test('queryWithHistory joins with chat_history', () => {
    // Insert a chat history record
    db.prepare('INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)').run(
      USER_ID,
      'user',
      'delete my meeting',
    );
    const historyId = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'delete_event',
      chat_history_id: historyId,
    });

    const results = repo.queryWithHistory({ user_id: USER_ID });
    expect(results).toHaveLength(1);
    expect(results[0]!.history_content).toBe('delete my meeting');
    expect(results[0]!.history_role).toBe('user');
  });

  test('queryWithHistory returns null history fields when no chat_history_id', () => {
    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'command',
      action_name: '/add',
    });

    const results = repo.queryWithHistory({ user_id: USER_ID });
    expect(results).toHaveLength(1);
    expect(results[0]!.history_content).toBeNull();
    expect(results[0]!.history_role).toBeNull();
  });

  test('query filters by action_name', () => {
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'ai_tool', action_name: 'create_event' });
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'ai_tool', action_name: 'delete_event' });
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'ai_tool', action_name: 'update_event' });

    const results = repo.query({ action_name: 'delete_event' });
    expect(results).toHaveLength(1);
    expect(results[0]!.action_name).toBe('delete_event');
  });

  test('query filters by target_user_id', () => {
    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'send_invitation',
      target_user_id: 300,
    });
    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'send_invitation',
      target_user_id: 400,
    });

    const results = repo.query({ target_user_id: 300 });
    expect(results).toHaveLength(1);
  });

  test('query filters by before/after datetime', () => {
    // Insert with explicit timestamps
    db.prepare(
      `INSERT INTO user_action_log (user_id, chat_id, action_type, action_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(USER_ID, CHAT_ID, 'command', '/early', '2026-03-20 08:00:00');
    db.prepare(
      `INSERT INTO user_action_log (user_id, chat_id, action_type, action_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(USER_ID, CHAT_ID, 'command', '/late', '2026-03-25 20:00:00');

    const afterResults = repo.query({ user_id: USER_ID, after: '2026-03-22 00:00:00' });
    expect(afterResults).toHaveLength(1);
    expect(afterResults[0]!.action_name).toBe('/late');

    const beforeResults = repo.query({ user_id: USER_ID, before: '2026-03-22 00:00:00' });
    expect(beforeResults).toHaveLength(1);
    expect(beforeResults[0]!.action_name).toBe('/early');
  });

  test('query with no filters returns all entries up to limit', () => {
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'command', action_name: '/a' });
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'ai_tool', action_name: 'b' });

    const results = repo.query({});
    expect(results).toHaveLength(2);
  });

  test('query filters by chat_id', () => {
    const GROUP_CHAT = -1001234567890;
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'command', action_name: '/dm' });
    repo.insert({ user_id: USER_ID, chat_id: GROUP_CHAT, action_type: 'command', action_name: '/group' });

    const results = repo.query({ chat_id: GROUP_CHAT });
    expect(results).toHaveLength(1);
    expect(results[0]!.action_name).toBe('/group');
  });

  test('insert preserves metadata JSON roundtrip', () => {
    const meta = { title: 'Test', nested: { key: 'value' }, arr: [1, 2, 3] };
    const entry = repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'create_event',
      metadata: JSON.stringify(meta),
    });
    const parsed = JSON.parse(entry.metadata!);
    expect(parsed).toEqual(meta);
  });

  test('getByEvent returns empty for non-existent event', () => {
    expect(repo.getByEvent(99999)).toHaveLength(0);
  });

  test('queryWithHistory filters by action_type with join', () => {
    db.prepare('INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)').run(USER_ID, 'user', 'msg1');
    const hid1 = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;
    db.prepare('INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)').run(USER_ID, 'user', 'msg2');
    const hid2 = (db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;

    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'ai_tool',
      action_name: 'create_event',
      chat_history_id: hid1,
    });
    repo.insert({
      user_id: USER_ID,
      chat_id: CHAT_ID,
      action_type: 'command',
      action_name: '/add',
      chat_history_id: hid2,
    });

    const results = repo.queryWithHistory({ user_id: USER_ID, action_type: 'ai_tool' });
    expect(results).toHaveLength(1);
    expect(results[0]!.history_content).toBe('msg1');
  });

  test('cascade delete removes action log when user deleted', () => {
    repo.insert({ user_id: USER_ID, chat_id: CHAT_ID, action_type: 'command', action_name: '/test' });
    expect(repo.getRecent(USER_ID)).toHaveLength(1);

    db.prepare('DELETE FROM users WHERE telegram_id = ?').run(USER_ID);
    expect(repo.getRecent(USER_ID)).toHaveLength(0);
  });
});

describe('telegramMessageLink', () => {
  test('generates link for supergroup chat (-100 prefix)', () => {
    const link = telegramMessageLink(-1001234567890, 42);
    expect(link).toBe('https://t.me/c/1234567890/42');
  });

  test('returns null for private chat (positive id)', () => {
    expect(telegramMessageLink(12345, 42)).toBeNull();
  });

  test('returns null for regular group (negative, no -100)', () => {
    expect(telegramMessageLink(-12345, 42)).toBeNull();
  });
});
