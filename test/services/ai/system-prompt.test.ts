import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { buildSystemPrompt } from '../../../src/services/ai/system-prompt.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('buildSystemPrompt', () => {
  let db: Database;
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    const user = userRepo.create({
      telegram_id: USER_ID,
      username: 'testuser',
      first_name: 'Test',
      timezone: 'Europe/Kyiv',
      language: 'en',
    });
    const eventService = new EventService(eventRepo, reminderRepo);
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user,
      chatId: USER_ID,
      messageText: 'hello',
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
    };
  });

  test('includes user timezone', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Europe/Kyiv');
  });

  test('includes user name', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Test');
  });

  test('includes user language', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('en');
  });

  test('includes formatting rules', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('ISO 8601');
  });

  test('includes today events when they exist', () => {
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const eventService = new EventService(eventRepo, reminderRepo);
    eventService.createEvent({
      user_id: USER_ID,
      title: 'Morning Standup',
      start_at: new Date().toISOString(),
      timezone: 'Europe/Kyiv',
    });
    ctx.eventService = eventService;

    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Morning Standup');
  });

  test('includes language instruction for ru user', () => {
    const userRepo = new UserRepository(db);
    userRepo.update(USER_ID, { language: 'ru' });
    ctx.user = userRepo.findByTelegramId(USER_ID)!;

    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Russian');
  });
});
