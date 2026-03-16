import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  handleFindUser,
  handleGetHolidays,
  handleGetUserSettings,
  handleUpdateUserSettings,
} from '../../../../src/services/ai/tool-handlers/meta.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('meta tool handlers', () => {
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({
      telegram_id: USER_ID,
      timezone: 'Europe/Kyiv',
      language: 'en',
      username: 'testuser',
    });
    const eventService = new EventService(eventRepo, reminderRepo);
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
    };
  });

  describe('handleGetUserSettings', () => {
    test('returns user settings', () => {
      const result = handleGetUserSettings(ctx);
      expect(result.success).toBe(true);
      expect(result.output).toContain('Europe/Kyiv');
      expect(result.output).toContain('en');
    });
  });

  describe('handleUpdateUserSettings', () => {
    test('updates timezone', () => {
      const result = handleUpdateUserSettings(ctx, { timezone: 'America/New_York' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('America/New_York');
      expect(ctx.user.timezone).toBe('America/New_York');
    });

    test('updates language', () => {
      const result = handleUpdateUserSettings(ctx, { language: 'ru' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('ru');
    });

    test('returns error when nothing to update', () => {
      const result = handleUpdateUserSettings(ctx, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('No settings');
    });
  });

  describe('handleGetHolidays', () => {
    test('returns message when no subscriptions', () => {
      const result = handleGetHolidays(ctx, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('No');
    });
  });

  describe('handleFindUser', () => {
    test('finds existing user by username', () => {
      const result = handleFindUser(ctx, { username: 'testuser' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('telegram_id=123');
    });

    test('finds user with @ prefix', () => {
      const result = handleFindUser(ctx, { username: '@testuser' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('telegram_id=123');
    });

    test('returns error for unknown username', () => {
      const result = handleFindUser(ctx, { username: 'nobody' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('error message includes cleaned username', () => {
      const result = handleFindUser(ctx, { username: '@ghost_user' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ghost_user');
      expect(result.error).not.toContain('@@');
    });
  });
});
