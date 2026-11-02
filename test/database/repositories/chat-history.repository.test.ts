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

  test('getRecent defaults to 10 messages', () => {
    for (let i = 0; i < 15; i++) {
      repo.save(USER_ID, 'user', `msg ${i}`);
    }
    const messages = repo.getRecent(USER_ID);
    expect(messages.length).toBe(10);
    expect(messages[0]!.content).toBe('msg 5');
  });

  test('search returns messages matching text', () => {
    repo.save(USER_ID, 'user', 'добавь встречу');
    repo.save(USER_ID, 'assistant', 'встреча создана');
    repo.save(USER_ID, 'user', 'что завтра');
    const results = repo.search(USER_ID, { search: 'встреч' });
    expect(results.length).toBe(2);
  });

  test('search respects limit', () => {
    for (let i = 0; i < 20; i++) repo.save(USER_ID, 'user', `msg ${i}`);
    const results = repo.search(USER_ID, { limit: 5 });
    expect(results.length).toBe(5);
  });

  test('search filters by before date', () => {
    db.exec(
      `INSERT INTO chat_history (user_id, role, content, created_at) VALUES (${USER_ID}, 'user', 'old message', '2020-01-01 00:00:00')`,
    );
    repo.save(USER_ID, 'user', 'new message');
    const results = repo.search(USER_ID, { before: '2020-01-02 00:00:00' });
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe('old message');
  });

  test('searchByChat returns messages for a chat filtered by search', () => {
    const CHAT_ID = -100123;
    repo.save(USER_ID, 'user', 'встреча завтра', CHAT_ID);
    repo.save(USER_ID, 'user', 'погода сегодня', CHAT_ID);
    const results = repo.searchByChat(CHAT_ID, { search: 'встреч' });
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe('встреча завтра');
  });

  test('searchByChat does not include DM messages', () => {
    const CHAT_ID = -100456;
    repo.save(USER_ID, 'user', 'dm message');
    repo.save(USER_ID, 'user', 'group message', CHAT_ID);
    const results = repo.searchByChat(CHAT_ID, {});
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe('group message');
  });

  test('deleteOlderThan removes rows older than the threshold', () => {
    db.exec(
      `INSERT INTO chat_history (user_id, role, content, created_at) VALUES (${USER_ID}, 'user', 'very old', '2020-01-01 00:00:00')`,
    );
    db.exec(
      `INSERT INTO chat_history (user_id, role, content, created_at) VALUES (${USER_ID}, 'user', 'also old', '2020-06-15 12:00:00')`,
    );
    repo.save(USER_ID, 'user', 'recent message');
    const deleted = repo.deleteOlderThan(90);
    expect(deleted).toBe(2);
    const remaining = repo.getRecent(USER_ID);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.content).toBe('recent message');
  });

  test('deleteOlderThan returns 0 when nothing is old enough', () => {
    repo.save(USER_ID, 'user', 'Hello');
    const deleted = repo.deleteOlderThan(90);
    expect(deleted).toBe(0);
    expect(repo.getRecent(USER_ID).length).toBe(1);
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

  describe('chat_id support', () => {
    const CHAT_ID = -1001234567;
    const OTHER_CHAT_ID = -9999;
    const USER_ID_2 = 456;

    beforeEach(() => {
      new UserRepository(db).create({ telegram_id: USER_ID_2 });
    });

    test('save stores chat_id when provided', () => {
      repo.save(USER_ID, 'user', 'group msg', CHAT_ID);
      const row = db.prepare('SELECT chat_id FROM chat_history WHERE user_id = ?').get(USER_ID) as {
        chat_id: number;
      };
      expect(row.chat_id).toBe(CHAT_ID);
    });

    test('save stores null chat_id when not provided', () => {
      repo.save(USER_ID, 'user', 'personal msg');
      const row = db.prepare('SELECT chat_id FROM chat_history WHERE user_id = ?').get(USER_ID) as {
        chat_id: number | null;
      };
      expect(row.chat_id).toBeNull();
    });

    test('getRecentByChat returns messages from all users in a chat', () => {
      repo.save(USER_ID, 'user', 'msg from user 1', CHAT_ID);
      repo.save(USER_ID_2, 'user', 'msg from user 2', CHAT_ID);
      const messages = repo.getRecentByChat(CHAT_ID);
      expect(messages.length).toBe(2);
      const contents = messages.map((m) => m.content);
      expect(contents).toContain('msg from user 1');
      expect(contents).toContain('msg from user 2');
    });

    test('getRecentByChat does not return messages from other chats', () => {
      repo.save(USER_ID, 'user', 'chat msg', CHAT_ID);
      repo.save(USER_ID, 'user', 'other chat msg', OTHER_CHAT_ID);
      const messages = repo.getRecentByChat(CHAT_ID);
      expect(messages.length).toBe(1);
      expect(messages[0]!.content).toBe('chat msg');
    });

    test('getRecentByChat respects limit', () => {
      for (let i = 0; i < 15; i++) {
        repo.save(USER_ID, 'user', `msg ${i}`, CHAT_ID);
      }
      const messages = repo.getRecentByChat(CHAT_ID, 10);
      expect(messages.length).toBe(10);
    });

    test('getRecent still works for personal messages without chat_id', () => {
      repo.save(USER_ID, 'user', 'personal 1');
      repo.save(USER_ID, 'user', 'personal 2');
      const messages = repo.getRecent(USER_ID);
      expect(messages.length).toBe(2);
    });

    test('getRecent excludes messages with chat_id (group messages)', () => {
      repo.save(USER_ID, 'user', 'personal msg');
      repo.save(USER_ID, 'user', 'group msg', CHAT_ID);
      repo.save(USER_ID, 'assistant', 'personal reply');
      repo.save(USER_ID, 'assistant', 'group reply', CHAT_ID);
      const messages = repo.getRecent(USER_ID);
      expect(messages.length).toBe(2);
      expect(messages[0]!.content).toBe('personal msg');
      expect(messages[1]!.content).toBe('personal reply');
    });
  });
});

describe('ChatHistoryRepository queued-turn handling', () => {
  const USER_ID = 321;
  let db: Database;
  let repo: ChatHistoryRepository;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID });
    repo = new ChatHistoryRepository(db);
  });

  test('excluded rows are left out before the limit, in private history, group history and the history search', () => {
    const rows = Array.from({ length: 6 }, (_, index) => repo.save(USER_ID, 'user', `m${index}`));
    const newest = new Set([rows[4]!, rows[5]!]);
    expect(repo.getRecent(USER_ID, 3, newest).map((row) => row.content)).toEqual(['m1', 'm2', 'm3']);
    expect(repo.getRecent(USER_ID, 3).map((row) => row.content)).toEqual(['m3', 'm4', 'm5']);
    expect(repo.search(USER_ID, { excludeIds: newest }).map((row) => row.content)).toEqual(['m0', 'm1', 'm2', 'm3']);
    repo.save(USER_ID, 'user', 'g1', -5);
    const group = repo.save(USER_ID, 'user', 'g2', -5);
    expect(repo.getRecentByChat(-5, 10, new Set([group])).map((row) => row.content)).toEqual(['g1']);
    expect(repo.searchByChat(-5, { excludeIds: new Set([group]) }).map((row) => row.content)).toEqual(['g1']);
  });

  describe('placeUserTurnAfterLatest', () => {
    const roles = () => repo.getRecent(USER_ID, 20).map((row) => `${row.role}:${row.content}`);

    test('reads the turn after what was saved since, under the same id', () => {
      const confirm = repo.save(USER_ID, 'user', 'Yes');
      repo.save(USER_ID, 'assistant', 'working on the earlier request');
      repo.save(USER_ID, 'tool', '[]');

      expect(repo.placeUserTurnAfterLatest(confirm, USER_ID)).toBe(true);

      expect(roles()).toEqual(['assistant:working on the earlier request', 'tool:[]', 'user:Yes']);
      expect(repo.getRecent(USER_ID, 20).at(-1)?.id).toBe(confirm);
    });

    test('the turn keeps the time it was sent and is marked as moved; reading order does not depend on that time', () => {
      const confirm = repo.save(USER_ID, 'user', 'Yes');
      db.prepare('UPDATE chat_history SET created_at = ? WHERE id = ?').run('2020-01-01 00:00:05', confirm);
      const output = repo.save(USER_ID, 'assistant', 'earlier output');
      const other = repo.save(USER_ID, 'user', 'Thanks');

      expect(repo.placeUserTurnAfterLatest(confirm, USER_ID)).toBe(true);
      const answer = repo.save(USER_ID, 'assistant', 'answer to the moved turn');

      const rows = repo.getRecent(USER_ID, 20);
      expect(rows.map((row) => row.content)).toEqual(['earlier output', 'Thanks', 'Yes', 'answer to the moved turn']);
      const moved = rows.find((row) => row.id === confirm);
      expect(moved?.created_at).toBe('2020-01-01 00:00:05');
      expect(moved?.turn_order).toBe(other + 0.5);
      expect(rows.find((row) => row.id === output)?.turn_order).toBeNull();
      // The newest two rows by reading order, not by the time the moved turn was sent.
      expect(repo.getRecent(USER_ID, 2).map((row) => row.id)).toEqual([confirm, answer]);
    });

    test('rows saved afterwards, in the same second, still read after the moved turn', () => {
      const confirm = repo.save(USER_ID, 'user', 'Yes');
      repo.save(USER_ID, 'assistant', 'earlier output');
      repo.placeUserTurnAfterLatest(confirm, USER_ID);
      repo.save(USER_ID, 'assistant', 'answer to the moved turn');
      expect(roles()).toEqual(['assistant:earlier output', 'user:Yes', 'assistant:answer to the moved turn']);
    });

    test('nothing moves while no bot row follows the turn', () => {
      const first = repo.save(USER_ID, 'user', 'Yes');
      const queued = repo.save(USER_ID, 'user', 'Thanks');
      expect(repo.placeUserTurnAfterLatest(first, USER_ID)).toBe(false);
      expect(roles()).toEqual(['user:Yes', 'user:Thanks']);
      expect(queued).toBeGreaterThan(first);
    });

    test('a group turn stays in its group', () => {
      const row = repo.save(USER_ID, 'user', 'book it', -1001);
      repo.save(USER_ID, 'assistant', 'earlier answer', -1001);
      expect(repo.placeUserTurnAfterLatest(row, USER_ID)).toBe(true);
      expect(repo.getRecentByChat(-1001, 10).map((entry) => entry.content)).toEqual(['earlier answer', 'book it']);
    });

    test('in a group, another member’s run output counts as what the turn must be read after', () => {
      new UserRepository(db).create({ telegram_id: 456 });
      const memberAMessage = repo.save(USER_ID, 'user', 'A: add the review', -1001);
      repo.save(456, 'assistant', 'answer to member B', -1001); // the active run was triggered by member B
      expect(repo.placeUserTurnAfterLatest(memberAMessage, USER_ID)).toBe(true);
      expect(repo.getRecentByChat(-1001, 10).map((entry) => entry.content)).toEqual([
        'answer to member B',
        'A: add the review',
      ]);
    });

    test('a private turn is not moved by bot rows of another conversation', () => {
      new UserRepository(db).create({ telegram_id: 456 });
      const privateTurn = repo.save(USER_ID, 'user', 'Yes');
      repo.save(USER_ID, 'assistant', 'group answer', -1001);
      repo.save(456, 'assistant', 'someone else', undefined);
      expect(repo.placeUserTurnAfterLatest(privateTurn, USER_ID)).toBe(false);
    });

    test('tool actions logged against the turn keep pointing at it', () => {
      const turn = repo.save(USER_ID, 'user', 'Yes');
      repo.save(USER_ID, 'assistant', 'earlier run output');
      repo.placeUserTurnAfterLatest(turn, USER_ID);
      db.prepare(
        "INSERT INTO user_action_log (user_id, chat_id, action_type, action_name, chat_history_id, success) VALUES (?, ?, 'tool', 'create_event', ?, 1)",
      ).run(USER_ID, USER_ID, turn);
      expect(db.prepare('SELECT chat_history_id FROM user_action_log').get()).toEqual({ chat_history_id: turn });
    });

    test.each([
      ['another user’s row', 456, 'user'],
      ['a bot row', USER_ID, 'assistant'],
    ] as const)('leaves %s where it is', (_name, owner, role) => {
      new UserRepository(db).create({ telegram_id: 456 });
      const row = repo.save(owner, role, 'Yes');
      repo.save(USER_ID, 'assistant', 'later');
      expect(repo.placeUserTurnAfterLatest(row, USER_ID)).toBe(false);
    });

    test('a row that no longer exists is reported, nothing changes', () => {
      repo.save(USER_ID, 'user', 'Yes');
      expect(repo.placeUserTurnAfterLatest(9_999, USER_ID)).toBe(false);
      expect(roles()).toEqual(['user:Yes']);
    });
  });
});
