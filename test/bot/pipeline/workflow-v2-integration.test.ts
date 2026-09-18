import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createIntentMatcherLayer } from '../../../src/bot/pipeline/intent-matcher-layer.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { WorkflowSessionRepository } from '../../../src/database/repositories/workflow-session.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { IntentExecutor } from '../../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../../src/services/intent/intent-matcher.ts';

let db: Database;
beforeEach(() => {
  _resetToolThrottleForTest();
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db, migrations);
});
afterEach(() => db.close());
function setup(options: { initialWrite?: boolean; promptText?: string } = {}) {
  const users = new UserRepository(db);
  const user = users.create({ telegram_id: 890010001, timezone: 'UTC', language: 'en' });
  users.create({ telegram_id: 890010002, timezone: 'UTC', language: 'en' });
  const intents = new IntentRepository(db);
  const flow = {
    version: 2,
    steps: [
      ...(options.initialWrite
        ? [
            {
              call: 'manage_settings',
              input: { action: 'update', category: 'general', updates: { default_event_duration_minutes: 45 } },
            },
          ]
        : []),
      { call: 'manage_settings', input: { action: 'get', category: 'general' }, as: 'original' },
      {
        call: 'ask_user',
        input: { question: options.promptText ?? 'Choose <safe> duration', options: ['30', '60'] },
        as: 'minutes',
      },
      { call: 'ask_user', input: { question: 'Apply?', options: ['Yes', 'No'] }, as: 'confirm' },
      { when: "ask.confirm == 'No'", respond: 'Cancelled; unchanged.' },
      {
        when: "ask.minutes == '30'",
        call: 'manage_settings',
        input: { action: 'update', category: 'general', updates: { default_event_duration_minutes: 30 } },
      },
      {
        when: "ask.minutes == '60'",
        call: 'manage_settings',
        input: { action: 'update', category: 'general', updates: { default_event_duration_minutes: 60 } },
      },
      { respond: 'Updated.' },
    ],
  };
  db.query('INSERT INTO intents (canonical_name,phrases,trigger_words,workflow,status,format) VALUES(?,?,?,?,?,?)').run(
    'synthetic_version2',
    '["configure duration"]',
    '[]',
    JSON.stringify(flow),
    'approved',
    'text',
  );
  const matcher = new IntentMatcher();
  matcher.load(db.query<Parameters<IntentMatcher['load']>[0][number], []>('SELECT * FROM intents').all());
  const store = new WorkflowSessionRepository(db);
  const send = mock(async (_text: string, _options?: unknown) => ({ message_id: 77 }));
  const ctx = { dbUser: user, chatId: user.telegram_id, id: 71, send } as unknown as BotCommandContext;
  const history = new ChatHistoryRepository(db);
  const agentCtx: AgentContext = {
    user,
    chatId: user.telegram_id,
    messageText: 'configure duration',
    isGroup: false,
    userRepo: users,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory: history,
    eventReminderRepo: new EventReminderRepository(db),
    conversationLogger: new ConversationLogger(history),
  };
  const call = mock((name: string, input: unknown) => executeTool(agentCtx, name, input));
  const layer = createIntentMatcherLayer(matcher, intents, new IntentExecutor(), call, store);
  return { ctx, send, call, store, users, user, layer };
}
test('real SQLite settings mutation follows two delivered choices without repeating previous tools', async () => {
  const { layer, ctx, send, call, store, users, user } = setup();
  expect(await layer(ctx, 'configure duration')).toEqual({ handled: true });
  expect(call).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toBe('Choose &lt;safe&gt; duration');
  expect(send.mock.calls[0]?.[1]).toMatchObject({
    reply_markup: { keyboard: [[{ text: '30' }], [{ text: '60' }]], one_time_keyboard: true },
  });
  await layer(ctx, '30');
  expect(store.get(user.telegram_id, user.telegram_id)?.stepIndex).toBe(2);
  expect(call).toHaveBeenCalledTimes(1);
  await layer(ctx, 'Yes');
  expect(call).toHaveBeenCalledTimes(2);
  expect(users.findByTelegramId(user.telegram_id)?.default_event_duration_minutes).toBe(30);
  expect(users.findByTelegramId(890010002)?.default_event_duration_minutes).toBe(60);
  expect(store.get(user.telegram_id, user.telegram_id)).toBeNull();
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ reply_markup: { remove_keyboard: true } });
});
test('cancel across sequential questions leaves both users unchanged', async () => {
  const { layer, ctx, call, users, user } = setup();
  await layer(ctx, 'configure duration');
  await layer(ctx, '30');
  await layer(ctx, 'No');
  expect(call).toHaveBeenCalledTimes(1);
  expect(users.findByTelegramId(user.telegram_id)?.default_event_duration_minutes).toBe(60);
});
test('failed question delivery is retained as undelivered and next turn resends instead of accepting it', async () => {
  const { layer, ctx, send, call, store, user } = setup();
  send.mockRejectedValueOnce(new Error('synthetic transport error'));
  await expect(layer(ctx, 'configure duration')).rejects.toThrow('synthetic transport error');
  expect(store.get(user.telegram_id, user.telegram_id)).not.toBeNull();
  expect(call).toHaveBeenCalledTimes(1);
  await layer(ctx, '30');
  expect(call).toHaveBeenCalledTimes(1);
  expect(store.get(user.telegram_id, user.telegram_id)?.stepIndex).toBe(1);
  expect(send).toHaveBeenCalledTimes(2);
  await layer(ctx, '30');
  expect(store.get(user.telegram_id, user.telegram_id)?.stepIndex).toBe(2);
});
test('another actor cannot consume a stored workflow in the same chat', async () => {
  const { layer, ctx, call, users, store, user } = setup();
  await layer(ctx, 'configure duration');
  const other = { ...ctx, dbUser: users.findByTelegramId(890010002)! } as BotCommandContext;
  await layer(other, '60');
  expect(call).toHaveBeenCalledTimes(1);
  expect(store.get(user.telegram_id, user.telegram_id)?.stepIndex).toBe(1);
});

test('a committed setting change is not repeated when a later question fails delivery', async () => {
  const { layer, ctx, send, call, store, users, user } = setup({ initialWrite: true });
  send.mockRejectedValueOnce(new Error('synthetic transport error'));
  await expect(layer(ctx, 'configure duration')).rejects.toThrow('synthetic transport error');
  expect(call).toHaveBeenCalledTimes(2);
  expect(users.findByTelegramId(user.telegram_id)?.default_event_duration_minutes).toBe(45);
  await layer(ctx, '30'); // Resends undelivered prompt, does not consume the text as a choice.
  expect(call).toHaveBeenCalledTimes(2);
  expect(store.get(user.telegram_id, user.telegram_id)?.stepIndex).toBe(2);
  await layer(ctx, '30');
  await layer(ctx, 'No');
  expect(call).toHaveBeenCalledTimes(2);
  expect(users.findByTelegramId(user.telegram_id)?.default_event_duration_minutes).toBe(45);
});

test('long escaped prompts split safely and attach choices only to the final delivery', async () => {
  const { layer, ctx, send } = setup({ promptText: 'Please choose <duration> & confirm. '.repeat(300) });
  await layer(ctx, 'configure duration');
  expect(send.mock.calls.length).toBeGreaterThan(1);
  for (const [index, entry] of send.mock.calls.entries()) {
    expect(entry[0].length).toBeLessThanOrEqual(4000);
    if (index < send.mock.calls.length - 1) expect(entry[1]).not.toHaveProperty('reply_markup');
    else expect(entry[1]).toMatchObject({ reply_markup: { keyboard: [[{ text: '30' }], [{ text: '60' }]] } });
  }
});
