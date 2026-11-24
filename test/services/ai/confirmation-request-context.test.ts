// Confirmation regression: keep independent requests visible without broadening a button's approval.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { continueWithAgent } from '../../../src/bot/handlers/agent-continuation.ts';
import { buildAgentContextFactory } from '../../../src/bot/handlers/message.handler.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { _resetToolThrottleForTest } from '../../../src/services/ai/tool-executor.ts';
import type { TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

const USER = 456;
const ORIGINAL = 'Schedule Alpha at 17:00 on 2030-06-10. By the way, I like tea. And add Beta at 18:00 on 2030-06-10.';
const QUESTION = 'Create Alpha at 17:00?';
const LONG_ORIGINAL = `Schedule Alpha at 17:00 on 2030-06-10. ${'A casual tea topic. '.repeat(45)}And add Beta at 18:00 on 2030-06-10.`;
let db: Database;
let nextCallId = 0;
beforeEach(() => {
  nextCallId = 0;
  _resetToolThrottleForTest();
  db = new Database(':memory:');
  runMigrations(db, migrations);
});
afterEach(() => db.close());

function result(message: OpenAI.ChatCompletionAssistantMessageParam): StreamRoundResult {
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls: (message.tool_calls ?? []).flatMap((call) =>
      call.type === 'function'
        ? [
            {
              id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            },
          ]
        : [],
    ),
    assistantMessage: message,
    providerUsed: 'synthetic',
    finishReason: message.tool_calls?.length ? 'tool_calls' : 'stop',
  };
}
function tool(name: string, input: { [key: string]: unknown }): OpenAI.ChatCompletionAssistantMessageParam {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `synthetic-${name}-${nextCallId++}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(input) },
      },
    ],
  };
}
function setup(script: OpenAI.ChatCompletionAssistantMessageParam[], reject = false) {
  const users = new UserRepository(db);
  const events = new EventRepository(db);
  const history = new ChatHistoryRepository(db);
  const logger = new ConversationLogger(history);
  const user = users.create({ telegram_id: USER, timezone: 'UTC', language: 'en' });
  const sender = {
    sendMessage: mock(async () => ({ message_id: 42 })),
    editMessageText: mock(async () => {}),
    sendButtons: mock(async (..._args: Parameters<NonNullable<TelegramSender['sendButtons']>>) => ({ message_id: 43 })),
  } satisfies TelegramSender;
  const validationInputs: string[] = [];
  let index = 0;
  const stream = async (options: StreamRoundOptions): Promise<StreamRoundResult> => {
    const system = options.messages[0];
    if (typeof system?.content === 'string' && system.content.includes('strict QA validator')) {
      validationInputs.push(String(options.messages[1]?.content));
      const evidence = validationInputs.at(-1)!;
      const origin = /<original_request>\n([\s\S]*?)<\/original_request>/.exec(evidence)?.[1] ?? '';
      const reply = /<assistant_response>\n([\s\S]*?)<\/assistant_response>/.exec(evidence)?.[1] ?? '';
      return result({
        role: 'assistant',
        content:
          reject &&
          origin.includes('Beta') &&
          reply.includes('If you want') &&
          (!reply.includes('Gamma') ||
            /<earlier_mutation_results>[\s\S]*Alpha[\s\S]*<\/earlier_mutation_results>/.test(evidence) ||
            /<earlier_answers>[\s\S]*Alpha[\s\S]*Cancel[\s\S]*<\/earlier_answers>/.test(evidence))
            ? 'REJECT: requested work was made optional'
            : 'APPROVE',
      });
    }
    const message = script[index++];
    if (!message) throw new Error('Synthetic script exhausted');
    return result(message);
  };
  const agent = new CalendarBotAgent({}, sender, { streamImpl: stream });
  const buildContext = buildAgentContextFactory({
    agent,
    eventService: new EventService({ eventRepo: events }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory: history,
    conversationLogger: logger,
    userRepo: users,
    eventReminderRepo: new EventReminderRepository(db),
    sceneStorage: { get: async () => undefined, delete: async () => {} },
  });
  return { agent, buildContext, user, logger, sender, events, validationInputs, history };
}

test.each([
  ORIGINAL,
  LONG_ORIGINAL,
])('real continuation validates both requests and asks about remaining work without replaying the confirmed write: %s', async (original) => {
  const s = setup(
    [
      tool('ask_user', { question: QUESTION, options: ['Create', 'Cancel'] }),
      tool('create_event', { title: 'Alpha', start_at: '2030-06-10T17:00:00Z', end_at: '2030-06-10T18:00:00Z' }),
      { role: 'assistant', content: 'Alpha is created. If you want to add Beta, let me know.' },
      tool('ask_user', { question: 'Create Beta at 18:00?', options: ['Create', 'Cancel'] }),
    ],
    true,
  );
  s.logger.logUserMessage(USER, original);
  await s.agent.run(s.buildContext(s.user, USER, original));
  await continueWithAgent(s.user, 'Create', { agent: s.agent, buildContext: s.buildContext });
  expect(s.sender.sendButtons).toHaveBeenCalledTimes(2);
  expect(s.sender.sendButtons.mock.calls[1]?.[1]).toBe('Create Beta at 18:00?');
  expect(s.events.getInRange(USER, '2030-06-10T00:00:00Z', '2030-06-11T00:00:00Z').map((event) => event.title)).toEqual(
    ['Alpha'],
  );
  expect(s.validationInputs).toHaveLength(1);
  expect(s.validationInputs[0]).toContain(original);
  expect(s.validationInputs[0]).toContain(QUESTION);
});

test('a freely chosen new topic is not forced back to the earlier confirmation', async () => {
  const s = setup([
    tool('ask_user', { question: QUESTION, options: ['Create', 'Cancel'] }),
    { role: 'assistant', content: 'Tea can be a pleasant drink.' },
  ]);
  s.logger.logUserMessage(USER, ORIGINAL);
  await s.agent.run(s.buildContext(s.user, USER, ORIGINAL));
  await continueWithAgent(s.user, 'Tell me about tea instead.', { agent: s.agent, buildContext: s.buildContext });
  expect(s.sender.sendButtons).toHaveBeenCalledTimes(1);
  expect(s.events.getInRange(USER, '2030-06-10T00:00:00Z', '2030-06-11T00:00:00Z')).toEqual([]);
  expect(s.validationInputs[0]).toContain('Tell me about tea instead.');
  expect(s.validationInputs[0]).not.toContain('<original_request>');
});

test('three independent requests survive two real confirmation hops without replaying the first write', async () => {
  const original = `${ORIGINAL} Also schedule Gamma at 19:00 on 2030-06-10.`;
  const s = setup(
    [
      tool('ask_user', { question: QUESTION, options: ['Create', 'Cancel'] }),
      tool('create_event', { title: 'Alpha', start_at: '2030-06-10T17:00:00Z', end_at: '2030-06-10T18:00:00Z' }),
      ...Array.from({ length: 7 }, () => tool('calculate', { expression: '2+2' })),
      { role: 'assistant', content: 'Alpha is created. If you want Beta, let me know.' },
      tool('ask_user', { question: 'Create Beta at 18:00?', options: ['Create', 'Cancel'] }),
      tool('create_event', { title: 'Beta', start_at: '2030-06-10T18:00:00Z', end_at: '2030-06-10T19:00:00Z' }),
      { role: 'assistant', content: 'Beta is created. If you want Gamma, let me know.' },
      tool('ask_user', { question: 'Create Gamma at 19:00?', options: ['Create', 'Cancel'] }),
    ],
    true,
  );
  s.logger.logUserMessage(USER, original);
  await s.agent.run(s.buildContext(s.user, USER, original));
  await continueWithAgent(s.user, 'Create', { agent: s.agent, buildContext: s.buildContext });
  await continueWithAgent(s.user, 'Create', { agent: s.agent, buildContext: s.buildContext });
  expect(s.sender.sendButtons).toHaveBeenCalledTimes(3);
  expect(s.sender.sendButtons.mock.calls[2]?.[1]).toBe('Create Gamma at 19:00?');
  expect(s.events.getInRange(USER, '2030-06-10T00:00:00Z', '2030-06-11T00:00:00Z').map((event) => event.title)).toEqual(
    ['Alpha', 'Beta'],
  );
  expect(s.validationInputs).toHaveLength(2);
  expect(s.validationInputs[1]).toContain(original);
  expect(s.validationInputs[1]).toContain('Create Beta at 18:00?');
  expect(s.validationInputs[1]).toContain('<earlier_mutation_results>');
  expect(s.validationInputs[1]).toContain('Alpha');
});

test('literal confirmation labels are replaced by the real ask_user handler, not calendar writes', async () => {
  const s = setup([
    tool('calculate', { expression: '2+2' }),
    { role: 'assistant', content: 'Create Beta at 18:00? [Create] [Cancel]' },
    tool('ask_user', { question: 'Create Beta at 18:00?', options: ['Create', 'Cancel'] }),
  ]);
  s.logger.logUserMessage(USER, 'Please add Beta at 18:00 on 2030-06-10.');
  await s.agent.run(s.buildContext(s.user, USER, 'Please add Beta at 18:00 on 2030-06-10.'));
  expect(s.sender.sendButtons).toHaveBeenCalledTimes(1);
  expect(s.sender.sendButtons.mock.calls[0]?.[1]).toBe('Create Beta at 18:00?');
  expect(s.events.getInRange(USER, '2030-06-10T00:00:00Z', '2030-06-11T00:00:00Z')).toEqual([]);
});

// Cancellation belongs to its specific question, even after a different confirmation.
test('a cancelled first request stays cancelled through the next confirmation', async () => {
  const original = `${ORIGINAL} Also schedule Gamma at 19:00 on 2030-06-10.`;
  const s = setup(
    [
      tool('ask_user', { question: QUESTION, options: ['Create', 'Cancel'] }),
      tool('ask_user', { question: 'Create Beta at 18:00?', options: ['Create', 'Cancel'] }),
      tool('create_event', { title: 'Beta', start_at: '2030-06-10T18:00:00Z', end_at: '2030-06-10T19:00:00Z' }),
      { role: 'assistant', content: 'Beta is created. If you want Gamma, let me know.' },
      tool('ask_user', { question: 'Create Gamma at 19:00?', options: ['Create', 'Cancel'] }),
    ],
    true,
  );
  s.logger.logUserMessage(USER, original);
  await s.agent.run(s.buildContext(s.user, USER, original));
  await continueWithAgent(s.user, 'Cancel', { agent: s.agent, buildContext: s.buildContext });
  await continueWithAgent(s.user, 'Create', { agent: s.agent, buildContext: s.buildContext });
  expect(s.sender.sendButtons).toHaveBeenCalledTimes(3);
  expect(s.events.getInRange(USER, '2030-06-10T00:00:00Z', '2030-06-11T00:00:00Z').map((event) => event.title)).toEqual(
    ['Beta'],
  );
  expect(s.validationInputs[0]).toContain('<earlier_answers>');
  expect(s.validationInputs[0]).toContain(QUESTION);
  expect(s.validationInputs[0]).toContain('Answer: Cancel');
});
