import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TelegramMessage } from 'gramio';
import { createMessageHandler } from '../../../src/bot/handlers/message.handler.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { FeedbackRepository } from '../../../src/database/repositories/feedback.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

const ADMIN_ID = 999;
const USER_ID = 42;
const GROUP_CHAT_ID = -100555;

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  db.run('INSERT OR IGNORE INTO users (telegram_id) VALUES (?)', [USER_ID]);
  db.run('INSERT OR IGNORE INTO users (telegram_id) VALUES (?)', [ADMIN_ID]);
  return db;
}

function makeDeps(overrides: { [key: string]: unknown } = {}) {
  return {
    agent: { run: mock(() => Promise.resolve({ toolCalls: [], toolResults: [], responseText: '' })) },
    eventService: { getEventsInRange: mock(() => []), getLatestCreated: mock(() => null) },
    holidayService: {},
    chatHistory: {},
    conversationLogger: { logUserMessage: mock(() => {}), logBotResponse: mock(() => {}) },
    userRepo: {
      findByTelegramId: mock((id: number) => ({
        telegram_id: id,
        language: 'en',
        timezone: 'UTC',
        username: id === ADMIN_ID ? 'admin' : 'user42',
        first_name: id === ADMIN_ID ? 'Admin' : 'TestUser',
      })),
    },
    eventReminderRepo: {},
    sceneStorage: { get: mock(() => Promise.resolve(null)), delete: mock(() => {}) },
    botUsername: 'TestBot',
    ...overrides,
  };
}

interface MockCtxOverrides {
  dbUser?: { telegram_id: number; language: string; timezone: string; username?: string; first_name?: string };
  text?: string;
  chatId?: number;
  chat?: { type: string; title?: string };
  from?: { firstName?: string; username?: string; id?: number };
  send?: ReturnType<typeof mock>;
}

function makeAdminCtx(overrides: MockCtxOverrides = {}) {
  return {
    dbUser: {
      telegram_id: ADMIN_ID,
      language: 'en',
      timezone: 'UTC',
      username: 'admin',
      first_name: 'Admin',
    },
    text: 'We fixed your bug!',
    chatId: ADMIN_ID,
    chat: { type: 'private' },
    from: { firstName: 'Admin', username: 'admin', id: ADMIN_ID },
    send: mock(() => Promise.resolve()),
    scene: { enter: mock(() => Promise.resolve()) },
    ...overrides,
  };
}

describe('Admin reply delivery with group fallback', () => {
  let db: Database;
  let feedbackRepo: FeedbackRepository;

  beforeEach(() => {
    db = createTestDb();
    feedbackRepo = new FeedbackRepository(db);
  });

  test('shows "Reply sent." when direct delivery succeeds', async () => {
    const threadId = feedbackRepo.createThread({
      user_id: USER_ID,
      type: 'bug',
      subject: 'Test bug',
    });
    feedbackRepo.addMessage({ thread_id: threadId, sender: 'user', text: 'Something broke' });

    const sendMessageToUser = mock(() => Promise.resolve());
    const adminReplySession = new Map<number, { threadId: number; userId: number; chatId?: number }>();
    adminReplySession.set(ADMIN_ID, { threadId, userId: USER_ID });

    const ctx = makeAdminCtx();
    const deps = makeDeps({
      feedbackRepo,
      adminReplySession,
      botAdminId: ADMIN_ID,
      sendMessageToUser,
    });

    const handler = createMessageHandler(deps as never);
    await handler(ctx as never);

    expect(sendMessageToUser).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessageToUser.mock.calls[0]! as unknown as [number, string];
    expect(chatId).toBe(USER_ID);
    expect(text).toContain('We fixed your bug!');

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [reply] = ctx.send.mock.calls[0]! as unknown as [string];
    expect(reply).toBe('Reply sent.');
  });

  test('falls back to group when direct delivery fails and chat_id is set', async () => {
    const threadId = feedbackRepo.createThread({
      user_id: USER_ID,
      type: 'bug',
      subject: 'Group bug',
      chat_id: GROUP_CHAT_ID,
    });
    feedbackRepo.addMessage({ thread_id: threadId, sender: 'user', text: 'Bug from group' });

    const sendMessageToUser = mock(() => Promise.reject(new Error('Forbidden: bot was blocked by the user')));
    const sendMessageToChat = mock(() => Promise.resolve({ message_id: 1 } as TelegramMessage));
    const adminReplySession = new Map<number, { threadId: number; userId: number; chatId?: number }>();
    adminReplySession.set(ADMIN_ID, { threadId, userId: USER_ID, chatId: GROUP_CHAT_ID });

    const ctx = makeAdminCtx();
    const deps = makeDeps({
      feedbackRepo,
      adminReplySession,
      botAdminId: ADMIN_ID,
      sendMessageToUser,
      sendMessageToChat,
    });

    const handler = createMessageHandler(deps as never);
    await handler(ctx as never);

    // Direct delivery failed
    expect(sendMessageToUser).toHaveBeenCalledTimes(1);

    // Group fallback succeeded
    expect(sendMessageToChat).toHaveBeenCalledTimes(1);
    const [groupChatId, groupText] = sendMessageToChat.mock.calls[0]! as unknown as [number, string];
    expect(groupChatId).toBe(GROUP_CHAT_ID);
    expect(groupText).toContain('We fixed your bug!');
    expect(groupText).toContain('Ответ разработчика');

    const [reply] = ctx.send.mock.calls[0]! as unknown as [string];
    expect(reply).toContain('group');
  });

  test('shows error when direct delivery fails and no group fallback available', async () => {
    const threadId = feedbackRepo.createThread({
      user_id: USER_ID,
      type: 'bug',
      subject: 'Private bug',
    });
    feedbackRepo.addMessage({ thread_id: threadId, sender: 'user', text: 'Bug from DM' });

    const sendMessageToUser = mock(() => Promise.reject(new Error('Forbidden: bot was blocked by the user')));
    const adminReplySession = new Map<number, { threadId: number; userId: number; chatId?: number }>();
    adminReplySession.set(ADMIN_ID, { threadId, userId: USER_ID });

    const ctx = makeAdminCtx();
    const deps = makeDeps({
      feedbackRepo,
      adminReplySession,
      botAdminId: ADMIN_ID,
      sendMessageToUser,
    });

    const handler = createMessageHandler(deps as never);
    await handler(ctx as never);

    expect(sendMessageToUser).toHaveBeenCalledTimes(1);

    const [reply] = ctx.send.mock.calls[0]! as unknown as [string];
    expect(reply).toContain('Delivery failed');
  });

  test('shows error when both direct and group delivery fail', async () => {
    const threadId = feedbackRepo.createThread({
      user_id: USER_ID,
      type: 'bug',
      subject: 'Unreachable bug',
      chat_id: GROUP_CHAT_ID,
    });
    feedbackRepo.addMessage({ thread_id: threadId, sender: 'user', text: 'Unreachable' });

    const sendMessageToUser = mock(() => Promise.reject(new Error('Forbidden: bot was blocked')));
    const sendMessageToChat = mock(() => Promise.reject(new Error('Forbidden: bot was kicked from the group')));
    const adminReplySession = new Map<number, { threadId: number; userId: number; chatId?: number }>();
    adminReplySession.set(ADMIN_ID, { threadId, userId: USER_ID, chatId: GROUP_CHAT_ID });

    const ctx = makeAdminCtx();
    const deps = makeDeps({
      feedbackRepo,
      adminReplySession,
      botAdminId: ADMIN_ID,
      sendMessageToUser,
      sendMessageToChat,
    });

    const handler = createMessageHandler(deps as never);
    await handler(ctx as never);

    expect(sendMessageToUser).toHaveBeenCalledTimes(1);
    expect(sendMessageToChat).toHaveBeenCalledTimes(1);

    const [reply] = ctx.send.mock.calls[0]! as unknown as [string];
    expect(reply).toContain('Delivery failed');
  });

  test('saves admin message to thread regardless of delivery outcome', async () => {
    const threadId = feedbackRepo.createThread({
      user_id: USER_ID,
      type: 'bug',
      subject: 'Test',
    });

    const sendMessageToUser = mock(() => Promise.reject(new Error('Forbidden')));
    const adminReplySession = new Map<number, { threadId: number; userId: number; chatId?: number }>();
    adminReplySession.set(ADMIN_ID, { threadId, userId: USER_ID });

    const ctx = makeAdminCtx();
    const deps = makeDeps({
      feedbackRepo,
      adminReplySession,
      botAdminId: ADMIN_ID,
      sendMessageToUser,
    });

    const handler = createMessageHandler(deps as never);
    await handler(ctx as never);

    // Message is saved to the thread even if delivery failed
    const messages = feedbackRepo.getMessages(threadId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sender).toBe('admin');
    expect(messages[0]!.text).toContain('We fixed your bug!');
  });
});
