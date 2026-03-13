// test/database/repositories/chat-history.repository.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('ChatHistoryRepository', () => {
  let db: Database;
  let repo: ChatHistoryRepository;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    repo = new ChatHistoryRepository(db);
  });

  test('save inserts a user text message', () => {
    repo.save(USER_ID, 'user', 'Hello');
    const messages = repo.getRecent(USER_ID);
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toBe('Hello');
  });

  test('save stores assistant content blocks as JSON', () => {
    const blocks = JSON.stringify([
      { type: 'text', text: 'Let me check...' },
      { type: 'tool_use', id: 'call_1', name: 'get_events', input: { start_date: '2026-03-15' } },
    ]);
    repo.save(USER_ID, 'assistant', blocks);
    const messages = repo.getRecent(USER_ID);
    expect(messages[0]!.role).toBe('assistant');
    const parsed = JSON.parse(messages[0]!.content);
    expect(parsed).toBeArray();
    expect(parsed[1].name).toBe('get_events');
  });

  test('save stores tool_result messages', () => {
    const toolResult = JSON.stringify([{ type: 'tool_result', tool_use_id: 'call_1', content: '{"events":[]}' }]);
    repo.save(USER_ID, 'tool', toolResult);
    const messages = repo.getRecent(USER_ID);
    expect(messages[0]!.role).toBe('tool');
  });

  test('saveInteraction stores full multi-round exchange', () => {
    repo.save(USER_ID, 'user', 'What events today?');
    repo.save(
      USER_ID,
      'assistant',
      JSON.stringify([
        { type: 'text', text: 'Checking...' },
        { type: 'tool_use', id: 'c1', name: 'get_events', input: {} },
      ]),
    );
    repo.save(USER_ID, 'tool', JSON.stringify([{ type: 'tool_result', tool_use_id: 'c1', content: '[]' }]));
    repo.save(USER_ID, 'assistant', JSON.stringify([{ type: 'text', text: 'No events today.' }]));
    const messages = repo.getRecent(USER_ID);
    expect(messages.length).toBe(4);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  test('getRecent returns last N messages ordered by created_at', () => {
    repo.save(USER_ID, 'user', 'First');
    repo.save(USER_ID, 'assistant', 'Response 1');
    repo.save(USER_ID, 'user', 'Second');
    repo.save(USER_ID, 'assistant', 'Response 2');

    const messages = repo.getRecent(USER_ID, 3);
    expect(messages.length).toBe(3);
    expect(messages[0]!.content).toBe('Response 1');
    expect(messages[2]!.content).toBe('Response 2');
  });

  test('getRecent defaults to 50 messages', () => {
    for (let i = 0; i < 60; i++) {
      repo.save(USER_ID, 'user', `msg ${i}`);
    }
    const messages = repo.getRecent(USER_ID);
    expect(messages.length).toBe(50);
    expect(messages[0]!.content).toBe('msg 10');
  });

  test('clear removes all messages for user', () => {
    repo.save(USER_ID, 'user', 'Hello');
    repo.save(USER_ID, 'assistant', 'Hi');
    repo.clear(USER_ID);
    const messages = repo.getRecent(USER_ID);
    expect(messages.length).toBe(0);
  });

  test('messages are isolated per user', () => {
    const OTHER_USER = 456;
    new UserRepository(db).create({ telegram_id: OTHER_USER });

    repo.save(USER_ID, 'user', 'User 1 msg');
    repo.save(OTHER_USER, 'user', 'User 2 msg');

    const msgs1 = repo.getRecent(USER_ID);
    const msgs2 = repo.getRecent(OTHER_USER);
    expect(msgs1.length).toBe(1);
    expect(msgs2.length).toBe(1);
    expect(msgs1[0]!.content).toBe('User 1 msg');
    expect(msgs2[0]!.content).toBe('User 2 msg');
  });
});
