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

  test('instructs AI to always use tools for event data', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('ALWAYS use tools');
    expect(prompt).toContain('get_events');
  });

  test('includes get_upcoming rule', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('get_upcoming');
  });

  test('includes snooze_event rule', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('snooze_event');
  });

  test('includes get_reminders rule', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('get_reminders');
  });

  test('includes UTC offset explicitly to prevent AI timezone guessing', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toMatch(/UTC\+\d/);
    expect(prompt).toContain('Current UTC time');
    expect(prompt).toContain('subtract');
  });

  test('instructs to create events immediately without confirmation', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('create immediately');
    expect(prompt).not.toContain('always confirm the details before creating');
  });

  test('instructs to use pick_users and find_contact for invitations', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('pick_users');
    expect(prompt).toContain('find_contact');
    expect(prompt).toContain('EXACT sequence');
  });

  test('includes language instruction for ru user', () => {
    const userRepo = new UserRepository(db);
    userRepo.update(USER_ID, { language: 'ru' });
    ctx.user = userRepo.findByTelegramId(USER_ID)!;

    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Russian');
  });
});
