import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { ChatHistoryMessage } from '../../../src/database/types.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
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

describe('CalendarBotAgent', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;
  const USER_ID = 123;

  beforeEach(() => {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'en' });
    const eventService = new EventService({ eventRepo });
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'What do I have today?',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      conversationLogger: new ConversationLogger(chatHistoryRepo),
      userRepo,
      eventReminderRepo,
    };
    config = {};
    sender = {
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      editMessageText: mock(() => Promise.resolve()),
    };
  });

  test('constructor creates agent with config', () => {
    const agent = new CalendarBotAgent(config, sender);
    expect(agent).toBeDefined();
  });

  test('buildMessages includes system prompt and user message', () => {
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText); // middleware saves before pipeline
    const history = ctx.chatHistory.getRecent(USER_ID);
    const agent = new CalendarBotAgent(config, sender);
    const { systemPrompt, messages } = agent.buildMessages(ctx, history);
    expect(systemPrompt).toContain('calendar assistant');
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content as string).toContain('What do I have today?');
  });

  test('buildMessages includes chat history', () => {
    ctx.chatHistory.save(USER_ID, 'user', 'Previous question');
    // Assistant turns are stored as OpenAI-format JSON now
    const prevAssistant: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'Previous answer' };
    ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify(prevAssistant));
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const agent = new CalendarBotAgent(config, sender);
    const { messages } = agent.buildMessages(ctx, history);
    expect(messages.length).toBe(3);
    expect(messages[0]!.content as string).toContain('Previous question');
    expect(messages[1]!.content as string).toBe('Previous answer');
    expect(messages[2]!.content as string).toContain(ctx.messageText);
  });

  test('buildMessages prefixes user text messages with local timestamp', () => {
    ctx.chatHistory.save(USER_ID, 'user', 'Hello');
    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);
    expect(typeof messages[0]!.content).toBe('string');
    expect(messages[0]!.content as string).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
    expect(messages[0]!.content as string).toContain('Hello');
  });

  test('buildMessages formats button activity event as readable text', () => {
    const btnEvent = JSON.stringify({ kind: 'button', label: 'Удалить', detail: 'Спортзал 17 мар' });
    ctx.chatHistory.save(USER_ID, 'user', btnEvent);
    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);
    const content = messages[0]!.content as string;
    expect(content).toContain('[Button: "Удалить"]');
    expect(content).toContain('Спортзал 17 мар');
  });

  test('buildMessages formats command activity event as readable text', () => {
    const cmdEvent = JSON.stringify({ kind: 'command', name: '/today' });
    ctx.chatHistory.save(USER_ID, 'user', cmdEvent);
    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);
    const content = messages[0]!.content as string;
    expect(content).toContain('[Command: /today]');
  });

  test('buildMessages formats bot reply activity event as readable text', () => {
    ctx.chatHistory.save(USER_ID, 'user', 'Hello');
    const botEvent = JSON.stringify({ kind: 'bot', text: 'Сегодня 3 события' });
    ctx.chatHistory.save(USER_ID, 'assistant', botEvent);
    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);
    const content = messages[1]!.content as string;
    expect(content).toContain('[Bot: Сегодня 3 события]');
  });

  test('buildMessages round-trips an assistant turn with tool_calls (paired with tool result)', () => {
    const assistantWithTools: OpenAI.ChatCompletionMessageParam = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'get_events', arguments: '{"start_date":"2026-04-10"}' },
        },
      ],
    };
    const toolResult: OpenAI.ChatCompletionMessageParam = {
      role: 'tool',
      tool_call_id: 'call_abc',
      content: '[]',
    };
    ctx.chatHistory.save(USER_ID, 'user', 'What do I have?');
    ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify(assistantWithTools));
    ctx.chatHistory.save(USER_ID, 'tool', JSON.stringify([toolResult]));
    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);
    const assistantMsg = messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    const tools = (assistantMsg as OpenAI.ChatCompletionAssistantMessageParam).tool_calls;
    expect(tools).toBeDefined();
    expect(tools![0]!.type).toBe('function');
    if (tools![0]!.type === 'function') {
      expect(tools![0]!.function.name).toBe('get_events');
    }
  });

  test('sanitizeMessages strips orphaned tool_calls (assistant.tool_calls without matching tool result)', () => {
    const orphanedAssistant: OpenAI.ChatCompletionMessageParam = {
      role: 'assistant',
      content: 'I checked your calendar',
      tool_calls: [
        {
          id: 'call_orphan',
          type: 'function',
          function: { name: 'get_events', arguments: '{}' },
        },
      ],
    };
    ctx.chatHistory.save(USER_ID, 'user', 'What do I have?');
    ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify(orphanedAssistant));
    ctx.chatHistory.save(USER_ID, 'user', 'hello again');
    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);

    const assistantMsg = messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    // Text content is preserved, tool_calls field is gone
    expect((assistantMsg as OpenAI.ChatCompletionAssistantMessageParam).tool_calls).toBeUndefined();
    expect(assistantMsg!.content).toBe('I checked your calendar');
  });

  test('sanitizeMessages drops orphan assistant entirely when content is empty', () => {
    const orphanedEmpty: OpenAI.ChatCompletionMessageParam = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_x',
          type: 'function',
          function: { name: 'get_events', arguments: '{}' },
        },
      ],
    };
    ctx.chatHistory.save(USER_ID, 'user', 'hi');
    ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify(orphanedEmpty));
    ctx.chatHistory.save(USER_ID, 'user', 'are you there');
    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);
    // No assistant message in the sanitized output — the orphan was dropped,
    // and the two user messages remain.
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  test('buildMessages expands a stored tool-role row into individual tool messages', () => {
    const toolResults: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'tool', tool_call_id: 'call_a', content: 'result a' },
      { role: 'tool', tool_call_id: 'call_b', content: 'result b' },
    ];
    ctx.chatHistory.save(USER_ID, 'user', 'Show me');
    ctx.chatHistory.save(USER_ID, 'tool', JSON.stringify(toolResults));
    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect((toolMessages[0] as OpenAI.ChatCompletionToolMessageParam).tool_call_id).toBe('call_a');
    expect((toolMessages[1] as OpenAI.ChatCompletionToolMessageParam).tool_call_id).toBe('call_b');
  });

  test('buildMessages drops legacy Anthropic tool_result rows that cannot be mapped', () => {
    const legacyAnthropic = JSON.stringify([{ type: 'tool_result', tool_use_id: 'abc', content: 'ok' }]);
    ctx.chatHistory.save(USER_ID, 'user', 'What?');
    ctx.chatHistory.save(USER_ID, 'tool', legacyAnthropic);
    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);
    // The user message survives; the legacy tool row is dropped since it has no tool_call_id we could map.
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
  });

  test('saveAssistantTurn persists the full OpenAI assistant message as JSON', () => {
    const agent = new CalendarBotAgent(config, sender);
    const assistant: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'Here are your events.' };
    agent.saveAssistantTurn(ctx, assistant);

    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(1);
    expect(history[0]!.role).toBe('assistant');
    const parsed = JSON.parse(history[0]!.content) as OpenAI.ChatCompletionMessageParam;
    expect(parsed.role).toBe('assistant');
    expect(parsed.content).toBe('Here are your events.');
  });

  test('saveToolResults persists the array of tool-role messages under role=tool', () => {
    const agent = new CalendarBotAgent(config, sender);
    const results: OpenAI.ChatCompletionMessageParam[] = [{ role: 'tool', tool_call_id: 'call_abc', content: 'ok' }];
    agent.saveToolResults(ctx, results);

    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(1);
    expect(history[0]!.role).toBe('tool');
    const parsed = JSON.parse(history[0]!.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tool_call_id).toBe('call_abc');
  });

  describe('supplement mode', () => {
    test('buildMessages returns empty messages when history is empty and supplementMode is true', () => {
      const agent = new CalendarBotAgent(config, sender);
      const supplementCtx = { ...ctx, supplementMode: true };
      const { messages } = agent.buildMessages(supplementCtx, []);
      expect(messages.length).toBe(0);
    });

    test('buildMessages returns empty messages when history is empty and supplementMode is false', () => {
      const agent = new CalendarBotAgent(config, sender);
      const { messages } = agent.buildMessages(ctx, []);
      expect(messages.length).toBe(0);
    });
  });

  test('buildMessages fetches 50 entries for group chats', () => {
    const calls: { chatId: number; limit: number }[] = [];
    const mockChatHistory = {
      ...ctx.chatHistory,
      getRecentByChat: (chatId: number, limit: number) => {
        calls.push({ chatId, limit });
        return [];
      },
    } as never;
    const groupCtx: AgentContext = { ...ctx, isGroup: true, groupChatId: 456, chatHistory: mockChatHistory };

    const agent = new CalendarBotAgent(config, sender);
    agent.buildMessages(groupCtx, []);
    expect(calls[0]).toMatchObject({ chatId: 456, limit: 50 });
  });

  test('user message is saved before bot response in history', () => {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'en' });
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const log = new ConversationLogger(chatHistoryRepo);

    log.logUserMessage(USER_ID, 'add meeting');
    log.logBotResponse(USER_ID, 'Meeting added!');

    const history = chatHistoryRepo.getRecent(USER_ID);
    expect(history).toHaveLength(2);
    expect(history[0]!.role).toBe('user');
    expect(history[1]!.role).toBe('assistant');
    expect(history[0]!.id).toBeLessThan(history[1]!.id);
  });

  test('buildMessages does not re-append current message already in history', () => {
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const agent = new CalendarBotAgent(config, sender);
    const { messages } = agent.buildMessages(ctx, history);
    const userMessages = messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content as string).toContain(ctx.messageText);
  });

  describe('sanitizeMessages', () => {
    function makeGroupCtx(chatHistory: Partial<ChatHistoryRepository>): AgentContext {
      return {
        ...ctx,
        isGroup: true,
        groupChatId: 456,
        chatHistory: chatHistory as ChatHistoryRepository,
      };
    }

    function fakeMsg(
      id: number,
      userId: number,
      role: 'user' | 'assistant' | 'tool',
      content: string,
    ): ChatHistoryMessage {
      return { id, user_id: userId, role, content, chat_id: 456, created_at: '2026-01-01 10:00:00' };
    }

    test('passes consecutive user messages through unchanged (OpenAI-permissive)', () => {
      const history: ChatHistoryMessage[] = [
        fakeMsg(1, USER_ID, 'user', 'Hello'),
        fakeMsg(2, USER_ID, 'user', 'Anyone there?'),
        fakeMsg(3, USER_ID, 'user', 'Буду завтра'),
      ];
      const groupCtx = makeGroupCtx({ getRecentByChat: () => history });
      const agent = new CalendarBotAgent(config, sender);
      const { messages } = agent.buildMessages(groupCtx, []);
      // OpenAI allows consecutive user turns — no synthetic assistant placeholder.
      expect(messages).toHaveLength(3);
      expect(messages.every((m) => m.role === 'user')).toBe(true);
    });

    test('inserts ... user placeholder before leading assistant message', () => {
      const staleAssistant: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'Stale response' };
      ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify(staleAssistant));
      ctx.chatHistory.save(USER_ID, 'user', 'Hello again');
      const history = ctx.chatHistory.getRecent(USER_ID);
      const agent = new CalendarBotAgent(config, sender);
      const { messages } = agent.buildMessages(ctx, history);
      // [user:'...', assistant:..., user:'Hello again'] = 3
      expect(messages).toHaveLength(3);
      expect(messages[0]!.role).toBe('user');
      expect(messages[0]!.content).toBe('...');
      expect(messages[1]!.role).toBe('assistant');
      expect(messages[2]!.role).toBe('user');
      expect(messages[2]!.content as string).toContain('Hello again');
    });

    test('does not modify already alternating user/assistant messages', () => {
      const reply: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'Answer' };
      ctx.chatHistory.save(USER_ID, 'user', 'Question');
      ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify(reply));
      ctx.chatHistory.save(USER_ID, 'user', 'Follow-up');
      const history = ctx.chatHistory.getRecent(USER_ID);
      const agent = new CalendarBotAgent(config, sender);
      const { messages } = agent.buildMessages(ctx, history);
      expect(messages).toHaveLength(3);
      expect(messages[0]!.role).toBe('user');
      expect(messages[1]!.role).toBe('assistant');
      expect(messages[2]!.role).toBe('user');
    });
  });

  describe('group sender info', () => {
    function fakeMsg(
      id: number,
      userId: number,
      role: 'user' | 'assistant' | 'tool',
      content: string,
    ): ChatHistoryMessage {
      return { id, user_id: userId, role, content, chat_id: 456, created_at: '2026-01-01 10:00:00' };
    }

    test('injects sender name and id for group user messages', () => {
      const history: ChatHistoryMessage[] = [fakeMsg(1, USER_ID, 'user', 'Test message')];
      const groupCtx: AgentContext = {
        ...ctx,
        isGroup: true,
        groupChatId: 456,
        chatHistory: { getRecentByChat: () => history } as Partial<ChatHistoryRepository> as ChatHistoryRepository,
      };
      const agent = new CalendarBotAgent(config, sender);
      const { messages } = agent.buildMessages(groupCtx, []);
      const content = messages[0]!.content as string;
      expect(content).toContain(`id:${USER_ID}`);
      expect(content).toContain('Test message');
    });

    test('does not add sender info for private chat messages', () => {
      ctx.chatHistory.save(USER_ID, 'user', 'Private message');
      const history = ctx.chatHistory.getRecent(USER_ID);
      const agent = new CalendarBotAgent(config, sender);
      const { messages } = agent.buildMessages(ctx, history);
      const content = messages[0]!.content as string;
      expect(content).not.toContain('[From:');
    });
  });
});
