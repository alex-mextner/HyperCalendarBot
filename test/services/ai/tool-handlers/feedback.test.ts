import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TelegramMessage } from 'gramio';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { FeedbackRepository } from '../../../../src/database/repositories/feedback.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleSendFeedback } from '../../../../src/services/ai/tool-handlers/feedback.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import { flushPromises } from '../../../helpers/mock-context.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('handleSendFeedback', () => {
  let ctx: AgentContext;
  let feedbackRepo: FeedbackRepository;
  let db: Database;
  const USER_ID = 42;
  const ADMIN_ID = 999;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    feedbackRepo = new FeedbackRepository(db);

    userRepo.create({
      telegram_id: USER_ID,
      timezone: 'UTC',
      language: 'en',
      username: 'testuser',
    });

    const eventService = new EventService({ eventRepo });
    const holidayService = new HolidayService(holidayRepo);

    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      eventReminderRepo,
      feedback: { feedbackContext: undefined, feedbackRepo, botAdminId: ADMIN_ID },
      sendMessageToChat: mock(() => Promise.resolve({} as TelegramMessage)),
      conversationLogger: null as never,
    };
  });

  test('creates thread and first message', async () => {
    const result = await handleSendFeedback(ctx, { type: 'bug', message: 'Something is broken' });

    expect(result.success).toBe(true);
    expect(result.output).toBe('Feedback sent to developer. They will respond in this chat.');

    const thread = feedbackRepo.getOpenThreadForUser(USER_ID);
    expect(thread).not.toBeNull();
    expect(thread!.type).toBe('bug');
    expect(thread!.subject).toBe('Something is broken');

    const messages = feedbackRepo.getMessages(thread!.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sender).toBe('user');
    expect(messages[0]!.text).toBe('Something is broken');
  });

  test('rejects when botAdminId not configured', async () => {
    ctx.feedback = undefined;
    const result = await handleSendFeedback(ctx, { type: 'question', message: 'Hello' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  test('rejects when feedbackRepo not available', async () => {
    ctx.feedback = undefined;
    const result = await handleSendFeedback(ctx, { type: 'feature', message: 'Add dark mode' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  test('rejects when 3 open threads exist', async () => {
    for (let i = 0; i < 3; i++) {
      feedbackRepo.createThread({ user_id: USER_ID, type: 'other', subject: `Thread ${i}` });
    }

    const result = await handleSendFeedback(ctx, { type: 'bug', message: 'Another bug' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Maximum 3 open feedback threads');
  });

  test('subject truncated to 50 chars', async () => {
    const longMessage = 'A'.repeat(60);
    const result = await handleSendFeedback(ctx, { type: 'other', message: longMessage });

    expect(result.success).toBe(true);

    const thread = feedbackRepo.getOpenThreadForUser(USER_ID);
    expect(thread!.subject).toBe(`${'A'.repeat(50)}...`);
  });

  test('subject not truncated when message is exactly 50 chars', async () => {
    const message = 'B'.repeat(50);
    handleSendFeedback(ctx, { type: 'other', message });

    const thread = feedbackRepo.getOpenThreadForUser(USER_ID);
    expect(thread!.subject).toBe('B'.repeat(50));
  });

  test('calls sendMessageToChat with admin notification', async () => {
    const sendMessageToChat = mock(() => Promise.resolve({} as TelegramMessage));
    ctx.sendMessageToChat = sendMessageToChat;

    handleSendFeedback(ctx, { type: 'feature', message: 'Add dark mode' });

    // Give the fire-and-forget a tick to execute
    await flushPromises();

    expect(sendMessageToChat).toHaveBeenCalledTimes(1);
    const [chatId, text, options] = sendMessageToChat.mock.calls[0]! as unknown as [
      number,
      string,
      { [key: string]: unknown },
    ];
    expect(chatId).toBe(ADMIN_ID);
    expect(text).toContain('feature');
    expect(text).toContain('Add dark mode');
    expect(options).toBeDefined();
  });

  test('returns agentHint warning when sendMessageToChat not provided', async () => {
    ctx.sendMessageToChat = undefined;
    const result = await handleSendFeedback(ctx, { type: 'bug', message: 'Crash' });

    expect(result.success).toBe(true);
    expect(result.agentHint).toContain('WARNING');
  });
});
