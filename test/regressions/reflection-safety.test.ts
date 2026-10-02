import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ActionLogRepository } from '../../src/database/repositories/action-log.repository.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { handleGetActionLog } from '../../src/services/ai/tool-handlers/action-log.ts';
import { handleGetHistory } from '../../src/services/ai/tool-handlers/history.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';

let db: Database;
let actions: ActionLogRepository;
let history: ChatHistoryRepository;
function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: { telegram_id: 10, language: 'en' },
    chatId: 10,
    isGroup: false,
    actionLogRepo: actions,
    chatHistory: history,
    ...overrides,
  } as unknown as AgentContext;
}
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE user_action_log(id INTEGER PRIMARY KEY, user_id INTEGER, chat_id INTEGER,
    action_type TEXT, action_name TEXT, message_id INTEGER, chat_history_id INTEGER,
    input_summary TEXT, result_summary TEXT, metadata TEXT, target_event_id INTEGER,
    target_user_id INTEGER, success INTEGER, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE chat_history(id INTEGER PRIMARY KEY, user_id INTEGER, role TEXT, content TEXT,
    chat_id INTEGER, created_at TEXT DEFAULT (datetime('now')));`);
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
test('negative and non-finite limits cannot turn diagnostics into unbounded reads', () => {
  for (let i = 0; i < 150; i++) {
    actions.insert({
      user_id: 10,
      chat_id: 10,
      action_type: 'ai_tool',
      action_name: 'sample',
      input_summary: `entry-${i}`,
    });
    history.save(10, 'user', `entry-${i}`);
  }
  for (const limit of [-1, 1e9, NaN, Infinity]) {
    expect((handleGetActionLog(context(), { limit }).output?.match(/entry-/g) ?? []).length).toBeLessThanOrEqual(100);
    expect((handleGetHistory(context(), { limit }).output?.match(/entry-/g) ?? []).length).toBeLessThanOrEqual(100);
  }
});
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
