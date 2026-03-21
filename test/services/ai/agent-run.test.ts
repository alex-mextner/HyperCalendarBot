import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { AiDebugLogger } from '../../../src/services/ai/debug-logger.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

/**
 * Creates a mock Anthropic client that simulates streaming responses.
 * streamEvents: array of SSE-like event objects the stream yields.
 * finalMessage: the final aggregated message returned by stream.finalMessage().
 */
function createMockAnthropicClient(
  streamEvents: Array<Record<string, unknown>>,
  finalMessage: {
    content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason: string;
  },
) {
  return {
    messages: {
      stream: mock(() => {
        let index = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (index < streamEvents.length) {
                  return Promise.resolve({ value: streamEvents[index++], done: false });
                }
                return Promise.resolve({ value: undefined, done: true });
              },
            };
          },
          finalMessage: mock(() => Promise.resolve(finalMessage)),
        };
      }),
    },
  };
}

describe('CalendarBotAgent.run()', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;
  const USER_ID = 456;

  beforeEach(() => {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'en' });
    const eventService = new EventService(eventRepo, reminderRepo);
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'Show my events today',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      conversationLogger: new ConversationLogger(chatHistoryRepo),
      userRepo,
      reminderRepo,
    };
    config = {
      apiKey: 'test-key',
      baseUrl: 'http://localhost:9999',
      model: 'test-model',
    };
    sender = {
      sendMessage: mock(() => Promise.resolve({ message_id: 42 })),
      editMessageText: mock(() => Promise.resolve()),
    };
  });

  test('run() with simple text response streams and saves history', async () => {
    const streamEvents = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'No events' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' today.' } },
    ];
    const finalMsg = {
      content: [{ type: 'text', text: 'No events today.' }],
      stop_reason: 'end_turn',
    };

    const mockClient = createMockAnthropicClient(streamEvents, finalMsg);
    const agent = new CalendarBotAgent(config, sender);
    // Replace the internal client with our mock
    (agent as unknown as { client: unknown }).client = mockClient;

    // Middleware saves user message before pipeline runs
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    await agent.run(ctx);

    // Sender init message was called
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    // Finalize flushes to edit the message
    expect(sender.editMessageText).toHaveBeenCalled();

    // Chat history should have user message + assistant turn
    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(2);
    expect(history[0]!.role).toBe('user');
    expect(history[0]!.content).toBe('Show my events today');
    expect(history[1]!.role).toBe('assistant');
    const assistantContent = JSON.parse(history[1]!.content);
    expect(assistantContent[0].text).toBe('No events today.');
  });

  test('run() with tool use executes tool and continues loop', async () => {
    // First round: model calls get_events tool
    const toolCallEvents = [
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'get_events' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ];
    const toolCallFinal = {
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'get_events',
          input: { start_date: '2026-03-15', end_date: '2026-03-15' },
        },
      ],
      stop_reason: 'tool_use',
    };

    // Second round: model returns text after seeing tool results
    const textEvents = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'You have 0 events.' } }];
    const textFinal = {
      content: [{ type: 'text', text: 'You have 0 events.' }],
      stop_reason: 'end_turn',
    };

    let callCount = 0;
    const mockClient = {
      messages: {
        stream: mock(() => {
          callCount++;
          const events = callCount === 1 ? toolCallEvents : textEvents;
          const final = callCount === 1 ? toolCallFinal : textFinal;
          let index = 0;
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  if (index < events.length) {
                    return Promise.resolve({ value: events[index++], done: false });
                  }
                  return Promise.resolve({ value: undefined, done: true });
                },
              };
            },
            finalMessage: mock(() => Promise.resolve(final)),
          };
        }),
      },
    };

    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    // Middleware saves user message before pipeline runs
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    await agent.run(ctx);

    // Should have called stream twice (tool round + final text round)
    expect(mockClient.messages.stream).toHaveBeenCalledTimes(2);

    // History: user + assistant (tool call) + tool result + assistant (text)
    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(4);
    expect(history[0]!.role).toBe('user');
    expect(history[1]!.role).toBe('assistant');
    expect(history[2]!.role).toBe('tool');
    expect(history[3]!.role).toBe('assistant');
  });

  test('run() handles API errors and sends error message', async () => {
    const mockClient = {
      messages: {
        stream: mock(() => {
          throw new Error('API connection failed');
        }),
      },
    };

    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    // Middleware saves user message before pipeline runs
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    await agent.run(ctx);

    // Should not throw, should finalize gracefully
    // Sender should have init + finalize calls
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(sender.editMessageText).toHaveBeenCalled();

    // User message should still be saved (saved by middleware before run())
    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(1);
    expect(history[0]!.role).toBe('user');
  });

  test('run() handles error with Russian language user', async () => {
    ctx.user = { ...ctx.user, language: 'ru' };

    const mockClient = {
      messages: {
        stream: mock(() => {
          throw new Error('API error');
        }),
      },
    };

    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    await agent.run(ctx);

    // The finalize call should contain Russian error text
    const editCalls = (sender.editMessageText as ReturnType<typeof mock>).mock.calls;
    const lastEditText = editCalls[editCalls.length - 1]?.[2] as string;
    expect(lastEditText).toContain('Произошла ошибка');
  });

  test('run() breaks loop when no tool use in response', async () => {
    const streamEvents = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } }];
    const finalMsg = {
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
    };

    const mockClient = createMockAnthropicClient(streamEvents, finalMsg);
    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    await agent.run(ctx);

    // Only one stream call — no looping
    expect(mockClient.messages.stream).toHaveBeenCalledTimes(1);
  });

  test('run() passes system prompt with cache_control', async () => {
    const streamEvents: Array<Record<string, unknown>> = [];
    const finalMsg = {
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    };
    const mockClient = createMockAnthropicClient(streamEvents, finalMsg);
    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    await agent.run(ctx);

    const streamCall = (mockClient.messages.stream as ReturnType<typeof mock>).mock.calls[0]!;
    const args = streamCall[0] as {
      system: Array<{ type: string; text: string; cache_control: { type: string } }>;
      model: string;
    };
    expect(args.model).toBe('test-model');
    expect(args.system[0]!.cache_control.type).toBe('ephemeral');
    expect(args.system[0]!.text).toContain('calendar assistant');
  });

  test('buildMessages parses JSON content blocks from history', () => {
    const agent = new CalendarBotAgent(config, sender);
    ctx.chatHistory.save(USER_ID, 'user', 'Hello');
    const contentBlocks = [{ type: 'text', text: 'Hello' }];
    ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify(contentBlocks));

    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);

    // Parsed JSON array should be passed as content blocks, not a string
    expect(Array.isArray(messages[1]!.content)).toBe(true);
  });

  test('buildMessages handles non-JSON content as plain string', () => {
    const agent = new CalendarBotAgent(config, sender);
    ctx.chatHistory.save(USER_ID, 'user', 'plain text message');

    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);

    expect(typeof messages[0]!.content).toBe('string');
    expect(messages[0]!.content as string).toContain('plain text message');
  });

  test('buildMessages handles non-array JSON as plain string', () => {
    const agent = new CalendarBotAgent(config, sender);
    ctx.chatHistory.save(USER_ID, 'user', 'Hello');
    ctx.chatHistory.save(USER_ID, 'assistant', '{"key": "value"}');

    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);

    // Non-array JSON should be kept as string
    expect(typeof messages[1]!.content).toBe('string');
  });

  test('buildMessages uses per-chat history in group context', () => {
    const GROUP_CHAT_ID = -1001234;
    // Save some per-user history (should be ignored in group)
    ctx.chatHistory.save(USER_ID, 'user', 'personal message');
    // Save per-chat history including current message (simulating middleware)
    ctx.chatHistory.save(USER_ID, 'user', 'group message', GROUP_CHAT_ID);
    ctx.chatHistory.save(USER_ID, 'assistant', 'group reply', GROUP_CHAT_ID);
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText, GROUP_CHAT_ID);

    ctx.isGroup = true;
    ctx.groupChatId = GROUP_CHAT_ID;
    ctx.groupTitle = 'Test Group';

    const agent = new CalendarBotAgent(config, sender);
    const personalHistory = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, personalHistory);

    // Should have 3 group history entries (group message + reply + current)
    expect(messages.length).toBe(3);
    expect(messages[0]!.content as string).toContain('group message');
    expect(messages[1]!.content as string).toContain('group reply');
    expect(messages[2]!.content as string).toContain('Show my events today');
  });

  test('[SKIP] response in group sends nothing (no placeholder, no delete)', async () => {
    const streamEvents = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: '[SKIP]' } }];
    const finalMsg = {
      content: [{ type: 'text', text: '[SKIP]' }],
      stop_reason: 'end_turn',
    };

    const mockClient = createMockAnthropicClient(streamEvents, finalMsg);
    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';

    await agent.run(ctx);

    // No ⏳ placeholder is sent in groups
    expect(sender.sendMessage).toHaveBeenCalledTimes(0);
    // Nothing to delete either
    expect(deleteMessage).toHaveBeenCalledTimes(0);
  });

  test('response containing [SKIP] anywhere is discarded in group', async () => {
    const streamEvents = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Got it ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '[SKIP]' } },
    ];
    const finalMsg = {
      content: [{ type: 'text', text: 'Got it [SKIP]' }],
      stop_reason: 'end_turn',
    };

    const mockClient = createMockAnthropicClient(streamEvents, finalMsg);
    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = true;
    ctx.groupChatId = -100999;

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    expect(sender.sendMessage).toHaveBeenCalledTimes(0);
    expect(deleteMessage).toHaveBeenCalledTimes(0);
  });

  test('[SKIP] response in DM is NOT discarded', async () => {
    const streamEvents = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: '[SKIP]' } }];
    const finalMsg = {
      content: [{ type: 'text', text: '[SKIP]' }],
      stop_reason: 'end_turn',
    };

    const mockClient = createMockAnthropicClient(streamEvents, finalMsg);
    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    ctx.isGroup = false;

    await agent.run(ctx);

    // In DM, [SKIP] should be finalized normally (editMessageText called)
    expect(sender.editMessageText).toHaveBeenCalled();
  });

  test('onBotResponse callback is called after finalize with message ID', async () => {
    const streamEvents = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }];
    const finalMsg = {
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
    };

    const mockClient = createMockAnthropicClient(streamEvents, finalMsg);
    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    const onBotResponse = mock(() => {});
    ctx.onBotResponse = onBotResponse;

    await agent.run(ctx);

    expect(onBotResponse).toHaveBeenCalledTimes(1);
    // Message ID from mock sender is 42
    expect(onBotResponse).toHaveBeenCalledWith(42);
  });

  test('onBotResponse is NOT called after [SKIP] discard', async () => {
    const streamEvents = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: '[SKIP]' } }];
    const finalMsg = {
      content: [{ type: 'text', text: '[SKIP]' }],
      stop_reason: 'end_turn',
    };

    const mockClient = createMockAnthropicClient(streamEvents, finalMsg);
    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    const onBotResponse = mock(() => {});
    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';
    ctx.onBotResponse = onBotResponse;

    await agent.run(ctx);

    // onBotResponse should NOT be called after SKIP
    expect(onBotResponse).not.toHaveBeenCalled();
  });

  test('logAiTurn via ConversationLogger saves content blocks with chatId in group context', () => {
    const GROUP_CHAT_ID = -1001234;
    ctx.isGroup = true;
    ctx.groupChatId = GROUP_CHAT_ID;

    const agent = new CalendarBotAgent(config, sender);
    const blocks = [{ type: 'text' as const, text: 'Group response' }];
    agent.saveAssistantTurn(ctx, blocks);

    const chatHistory = ctx.chatHistory.getRecentByChat(GROUP_CHAT_ID, 10);
    expect(chatHistory.length).toBe(1);
    expect(chatHistory[0]!.role).toBe('assistant');
    const parsed = JSON.parse(chatHistory[0]!.content);
    expect(parsed[0].text).toBe('Group response');
  });

  test('end_conversation tool stops loop and calls debugLogger.endSession', async () => {
    const endConvFinal = {
      content: [
        {
          type: 'tool_use',
          id: 'call-end',
          name: 'end_conversation',
          input: {},
        },
      ],
      stop_reason: 'tool_use',
    };

    const mockClient = createMockAnthropicClient(
      [{ type: 'content_block_start', content_block: { type: 'tool_use', name: 'end_conversation' } }],
      endConvFinal,
    );
    const endSession = mock(() => {});
    const debugLogger = {
      createRunContext: mock(() => null),
      endSession,
    } as unknown as AiDebugLogger;

    const agent = new CalendarBotAgent({ ...config, debugLogger }, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const result = await agent.run(ctx);

    // Loop stopped after one round (no second API call)
    expect(mockClient.messages.stream).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.some((tc) => tc.name === 'end_conversation')).toBe(true);
    // Session must be ended so next message gets a fresh log file
    expect(endSession).toHaveBeenCalledWith(USER_ID);
  });

  test('voice_message mode returns plain text without execution log HTML', async () => {
    // Round 1: tool call (produces execution log in intermediateChunks)
    const toolCallFinal = {
      content: [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'get_events',
          input: { start_date: '2026-03-20', end_date: '2026-03-20' },
        },
      ],
      stop_reason: 'tool_use',
    };
    // Round 2: plain text summary
    const textFinal = {
      content: [{ type: 'text', text: 'You have 0 events today.' }],
      stop_reason: 'end_turn',
    };

    let callCount = 0;
    const mockClient = {
      messages: {
        stream: mock(() => {
          callCount++;
          const final = callCount === 1 ? toolCallFinal : textFinal;
          const events =
            callCount === 1
              ? [{ type: 'content_block_start', content_block: { type: 'tool_use', name: 'get_events' } }]
              : [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'You have 0 events today.' } }];
          let index = 0;
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  return index < events.length
                    ? Promise.resolve({ value: events[index++], done: false })
                    : Promise.resolve({ value: undefined, done: true });
                },
              };
            },
            finalMessage: mock(() => Promise.resolve(final)),
          };
        }),
      },
    };

    const agent = new CalendarBotAgent(config, sender);
    (agent as unknown as { client: unknown }).client = mockClient;

    const result = await agent.run({ ...ctx, inputMode: 'voice_message' });

    // Must be plain text — no HTML blockquote, no execution log markers
    expect(result.responseText).toBe('You have 0 events today.');
    expect(result.responseText).not.toContain('<blockquote');
    expect(result.responseText).not.toContain('✅');
  });
});
