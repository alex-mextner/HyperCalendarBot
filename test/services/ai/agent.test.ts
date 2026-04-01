import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
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
    config = {
      apiKey: 'test-key',
      baseUrl: 'http://localhost:9999',
      model: 'test-model',
    };
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
    ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify([{ type: 'text', text: 'Previous answer' }]));
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText); // current msg saved by middleware
    const history = ctx.chatHistory.getRecent(USER_ID);
    const agent = new CalendarBotAgent(config, sender);
    const { messages } = agent.buildMessages(ctx, history);
    expect(messages.length).toBe(3);
    expect(messages[0]!.content as string).toContain('Previous question');
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

  test('buildMessages prefixes user messages with local timestamp', () => {
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText); // middleware saves it
    const history = ctx.chatHistory.getRecent(USER_ID);
    const agent = new CalendarBotAgent(config, sender);
    const { messages } = agent.buildMessages(ctx, history);
    expect(messages[0]!.content as string).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/);
    expect(messages[0]!.content as string).toContain(ctx.messageText);
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

  test('buildMessages does not add timestamp to ContentBlockParam arrays', () => {
    ctx.chatHistory.save(USER_ID, 'user', 'Hello');
    const blocks = JSON.stringify([{ type: 'text', text: 'AI response' }]);
    ctx.chatHistory.save(USER_ID, 'assistant', blocks);
    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);
    // ContentBlock array should not be a string
    expect(Array.isArray(messages[1]!.content)).toBe(true);
  });

  test('buildMessages maps tool role to user for Anthropic API', () => {
    const toolBlocks = JSON.stringify([{ type: 'tool_result', tool_use_id: 'abc', content: 'result' }]);
    ctx.chatHistory.save(USER_ID, 'tool', toolBlocks);

    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);
    // tool role should be mapped to 'user'
    expect(messages[0]!.role).toBe('user');
  });

  test('saveAssistantTurn saves content blocks as JSON', () => {
    const agent = new CalendarBotAgent(config, sender);
    const blocks = [{ type: 'text' as const, text: 'Here are your events...' }];
    agent.saveAssistantTurn(ctx, blocks);

    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(1);
    expect(history[0]!.role).toBe('assistant');
    const parsed = JSON.parse(history[0]!.content);
    expect(parsed[0].text).toBe('Here are your events...');
  });

  test('saveToolResults saves tool results as tool role', () => {
    const agent = new CalendarBotAgent(config, sender);
    const results = [{ type: 'tool_result' as const, tool_use_id: 'abc', content: 'ok' }];
    agent.saveToolResults(ctx, results);

    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(1);
    expect(history[0]!.role).toBe('tool');
  });

  describe('supplement mode', () => {
    test('buildMessages does not append current user message when supplementMode is true', () => {
      const agent = new CalendarBotAgent(config, sender);
      const supplementCtx = { ...ctx, supplementMode: true };
      const { messages } = agent.buildMessages(supplementCtx, []);
      // In supplement mode, user message is already in history — no extra append
      expect(messages.length).toBe(0);
    });

    test('buildMessages does not append current user message when supplementMode is false', () => {
      const agent = new CalendarBotAgent(config, sender);
      const { messages } = agent.buildMessages(ctx, []);
      // ConversationLogger middleware saves the message before pipeline runs — no append here
      expect(messages.length).toBe(0);
    });
  });

  // Test limit=50 — must use group context because buildMessages calls getRecentByChat directly for groups
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
    const logger = new ConversationLogger(chatHistoryRepo);

    logger.logUserMessage(USER_ID, 'add meeting');
    logger.logBotResponse(USER_ID, 'Meeting added!');

    const history = chatHistoryRepo.getRecent(USER_ID);
    expect(history).toHaveLength(2);
    expect(history[0]!.role).toBe('user');
    expect(history[1]!.role).toBe('assistant');
    // User row id is lower than assistant row id — strict ordering
    expect(history[0]!.id).toBeLessThan(history[1]!.id);
  });

  // Confirm no duplicate: current message in history once, not twice
  test('buildMessages does not re-append current message already in history', () => {
    // Simulate middleware having saved the current message before pipeline ran
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

    test('inserts ... placeholder between consecutive user messages', () => {
      const history: ChatHistoryMessage[] = [
        fakeMsg(1, USER_ID, 'user', 'Hello'),
        fakeMsg(2, USER_ID, 'user', 'Anyone there?'),
        fakeMsg(3, USER_ID, 'user', 'Буду завтра'),
      ];
      const groupCtx = makeGroupCtx({ getRecentByChat: () => history });
      const agent = new CalendarBotAgent(config, sender);
      const { messages } = agent.buildMessages(groupCtx, []);
      // 3 user → 2 '...' placeholders → 5 total
      expect(messages).toHaveLength(5);
      expect(messages[0]!.role).toBe('user');
      expect(messages[1]!.role).toBe('assistant');
      expect(messages[1]!.content).toBe('...');
      expect(messages[2]!.role).toBe('user');
      expect(messages[3]!.role).toBe('assistant');
      expect(messages[3]!.content).toBe('...');
      expect(messages[4]!.role).toBe('user');
    });

    test('inserts ... placeholder before leading assistant message', () => {
      ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify([{ type: 'text', text: 'Stale response' }]));
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
      ctx.chatHistory.save(USER_ID, 'user', 'Question');
      ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify([{ type: 'text', text: 'Answer' }]));
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

    test('does not add sender info to tool result messages', () => {
      const toolResult = JSON.stringify([{ type: 'tool_result', tool_use_id: 'abc', content: 'ok' }]);
      const history: ChatHistoryMessage[] = [
        { id: 1, user_id: USER_ID, role: 'tool', content: toolResult, chat_id: 456, created_at: '2026-01-01 10:00:00' },
      ];
      const groupCtx: AgentContext = {
        ...ctx,
        isGroup: true,
        groupChatId: 456,
        chatHistory: { getRecentByChat: () => history } as Partial<ChatHistoryRepository> as ChatHistoryRepository,
      };
      const agent = new CalendarBotAgent(config, sender);
      const { messages } = agent.buildMessages(groupCtx, []);
      // Tool results are arrays, not strings — no sender prefix
      expect(Array.isArray(messages[0]!.content)).toBe(true);
    });
  });
});
