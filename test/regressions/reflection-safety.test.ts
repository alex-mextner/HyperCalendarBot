import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { ActionLogRepository } from '../../src/database/repositories/action-log.repository.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { handleGetActionLog } from '../../src/services/ai/tool-handlers/action-log.ts';
import { handleGetHistory } from '../../src/services/ai/tool-handlers/history.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';

let db: Database;
let actions: ActionLogRepository;
let history: ChatHistoryRepository;
type ReflectionTestContext = Pick<
  AgentContext,
  'user' | 'chatId' | 'isGroup' | 'groupChatId' | 'chatHistory' | 'actionLogRepo'
>;
function context(overrides: Partial<ReflectionTestContext> = {}): ReflectionTestContext {
  return {
    user: new UserRepository(db).findByTelegramId(10)!,
    chatId: 10,
    isGroup: false,
    actionLogRepo: actions,
    chatHistory: history,
    ...overrides,
  };
}
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  for (const telegram_id of [10, 20]) new UserRepository(db).create({ telegram_id, timezone: 'UTC', language: 'en' });
  actions = new ActionLogRepository(db);
  history = new ChatHistoryRepository(db);
});
afterEach(() => db.close());
test('group diagnostics never reveal personal or other-group action entries', () => {
  for (const [chat_id, input_summary] of [
    [10, 'PRIVATE_SECRET'],
    [-1001, 'CURRENT_GROUP'],
    [-1002, 'OTHER_GROUP'],
  ] as const)
    actions.insert({ user_id: 10, chat_id, action_type: 'ai_tool', action_name: 'create_event', input_summary });
  const result = handleGetActionLog(context({ isGroup: true, chatId: -1001, groupChatId: -1001 }), {});
  expect(result.output).toContain('CURRENT_GROUP');
  expect(result.output).not.toContain('PRIVATE_SECRET');
  expect(result.output).not.toContain('OTHER_GROUP');
});
test('missing or contradictory group identity cannot fall back to private history', () => {
  history.save(10, 'user', 'PRIVATE_HISTORY');
  for (const groupChatId of [undefined, -1002]) {
    const ctx = context({ isGroup: true, chatId: -1001, groupChatId });
    expect(handleGetHistory(ctx, {}).success).toBe(false);
    expect(handleGetActionLog(ctx, {}).success).toBe(false);
  }
});
for (const isGroup of [false, true]) {
  test(`limits return exact positive counts (group=${isGroup})`, () => {
    const chatId = isGroup ? -1001 : 10;
    const ctx = context({ isGroup, chatId, groupChatId: isGroup ? chatId : undefined });
    for (let i = 0; i < 150; i++) {
      actions.insert({
        user_id: 10,
        chat_id: chatId,
        action_type: 'ai_tool',
        action_name: 'sample',
        input_summary: `entry-${i}`,
      });
      history.save(10, 'user', `entry-${i}`, chatId);
    }
    for (const [limit, actionCount, historyCount] of [
      [-1, 1, 1],
      [0, 1, 1],
      [0.5, 1, 1],
      [2.9, 2, 2],
      [1e9, 100, 100],
      [NaN, 30, 50],
      [Infinity, 30, 50],
      [-Infinity, 30, 50],
      [undefined, 30, 50],
    ] as const) {
      for (const [result, count] of [
        [handleGetActionLog(ctx, { limit }), actionCount],
        [handleGetHistory(ctx, { limit }), historyCount],
      ] as const) {
        expect(result.success).toBe(true);
        expect(result.output?.match(/entry-/g)?.length).toBe(count);
      }
    }
  });
}
test('recipient-specific audit filters real actions without including another owner', () => {
  for (const [user_id, target_user_id, input_summary] of [
    [10, 5000000001, 'MATCH'],
    [10, 5000000002, 'OTHER_RECIPIENT'],
    [20, 5000000001, 'OTHER_OWNER'],
  ] as const)
    actions.insert({
      user_id,
      chat_id: user_id,
      target_user_id,
      action_type: 'ai_tool',
      action_name: 'send_invitation',
      input_summary,
    });
  const result = handleGetActionLog(context(), { target_user_id: 5000000001 });
  expect(result.output).toContain('MATCH');
  expect(result.output).not.toContain('OTHER_RECIPIENT');
  expect(result.output).not.toContain('OTHER_OWNER');
});
test('group history honors time boundaries rather than silently ignoring them', () => {
  history.save(10, 'user', 'OLD', -1001);
  history.save(10, 'user', 'NEW', -1001);
  db.exec(
    "UPDATE chat_history SET created_at='2020-01-01 00:00:00' WHERE content='OLD'; UPDATE chat_history SET created_at='2020-02-01 00:00:00' WHERE content='NEW'",
  );
  const result = handleGetHistory(context({ isGroup: true, chatId: -1001, groupChatId: -1001 }), {
    after: '2020-01-15',
  });
  expect(result.output).toContain('NEW');
  expect(result.output).not.toContain('OLD');
});

for (const isGroup of [false, true]) {
  for (const boundary of [
    '2020-01-01T00:00:00.500Z',
    '2020-01-01 03:00:00.500+03:00',
    '2019-12-31T19:00:00.000001-05:00',
    '2020-01-01 00:00:00.5',
    '2020-01-01T00:00:00.500',
  ]) {
    test(`exclusive fractional boundaries ${boundary} group=${isGroup}`, () => {
      const chatId = isGroup ? -1001 : 10;
      const ctx = context({ isGroup, chatId, groupChatId: isGroup ? chatId : undefined });
      for (const [marker, timestamp] of [
        ['EARLIER', '2020-01-01 00:00:00'],
        ['LATER', '2020-01-01 00:00:01'],
      ] as const) {
        history.save(10, 'user', marker, chatId);
        actions.insert({ user_id: 10, chat_id: chatId, action_type: 'ai_tool', action_name: marker });
        db.query('UPDATE chat_history SET created_at = ? WHERE content = ?').run(timestamp, marker);
        db.query('UPDATE user_action_log SET created_at = ? WHERE action_name = ?').run(timestamp, marker);
      }
      for (const handler of [handleGetHistory, handleGetActionLog]) {
        const before = handler(ctx, { before: boundary });
        expect(before.success).toBe(true);
        expect(before.output).toContain('EARLIER');
        expect(before.output).not.toContain('LATER');
        const after = handler(ctx, { after: boundary });
        expect(after.success).toBe(true);
        expect(after.output).toContain('LATER');
        expect(after.output).not.toContain('EARLIER');
        for (const exact of ['2020-01-01T00:00:00.000Z', '2020-01-01', '2020-01-01 00:00']) {
          const equal = handler(ctx, { after: exact });
          expect(equal.success).toBe(true);
          expect(equal.output).not.toContain('EARLIER');
          expect(equal.output).toContain('LATER');
          const equalBefore = handler(ctx, { before: exact });
          expect(equalBefore.success).toBe(true);
          expect(equalBefore.output).not.toContain('EARLIER');
          expect(equalBefore.output).not.toContain('LATER');
        }
      }
    });
  }
  test(`malformed dates fail closed group=${isGroup}`, () => {
    const ctx = context({ isGroup, chatId: isGroup ? -1001 : 10, groupChatId: isGroup ? -1001 : undefined });
    for (const invalid of [
      '',
      'garbage',
      '2020-02-30',
      '2020-01-01 25:00:00',
      '2020-01-01T00:00:00+25:00',
      '2020-01-01junk',
    ]) {
      for (const handler of [handleGetHistory, handleGetActionLog]) {
        expect(handler(ctx, { before: invalid }).success).toBe(false);
        expect(handler(ctx, { after: invalid }).success).toBe(false);
      }
    }
  });
}
test('sparse recipient query uses migration 063 composite index without a sort', () => {
  for (let i = 0; i < 2000; i++)
    actions.insert({
      user_id: 10,
      chat_id: 10,
      action_type: 'ai_tool',
      action_name: 'sample',
      target_user_id: i === 1 ? 5000000001 : 20,
    });
  expect(actions.query({ user_id: 10, target_user_id: 5000000001 })).toHaveLength(1);
  const plan = db
    .query<{ detail: string }, []>(
      `EXPLAIN QUERY PLAN SELECT * FROM user_action_log WHERE user_id = 10 AND target_user_id = 5000000001 AND created_at > '2020-01-01 00:00:00' ORDER BY created_at DESC, id DESC LIMIT 30`,
    )
    .all()
    .map((row) => row.detail)
    .join(' ');
  expect(plan).toContain('idx_action_log_recipient');
  expect(plan).not.toContain('TEMP B-TREE');
  expect(migrations.some((migration) => migration.name === '063_reflection_recipient_index')).toBe(true);
});

test('sparse current-group audit uses owner-chat index without scanning other actors', () => {
  for (let i = 0; i < 2000; i++) {
    actions.insert({ user_id: 20, chat_id: -10010, action_type: 'tool', action_name: 'other actor' });
  }
  actions.insert({ user_id: 10, chat_id: -10010, action_type: 'tool', action_name: 'owned marker' });
  const plan = db
    .query<{ detail: string }, []>(
      'EXPLAIN QUERY PLAN SELECT * FROM user_action_log WHERE user_id = 10 AND chat_id = -10010 ORDER BY created_at DESC, id DESC LIMIT 30',
    )
    .all()
    .map((row) => row.detail)
    .join(' ');
  expect(plan).toContain('idx_action_log_owner_chat');
  expect(plan).not.toContain('USE TEMP B-TREE');
  const result = handleGetActionLog(context({ isGroup: true, chatId: -10010, groupChatId: -10010 }), {});
  expect(result.success).toBe(true);
  expect(result.output).toContain('owned marker');
  expect(result.output).not.toContain('other actor');
});
