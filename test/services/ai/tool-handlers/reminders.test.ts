import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleSetReminder } from '../../../../src/services/ai/tool-handlers/reminders.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('handleSetReminder', () => {
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const eventService = new EventService(eventRepo, reminderRepo);
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
      reminderRepo,
    };
  });

  test('sets reminders for event', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Meeting',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = handleSetReminder(ctx, {
      event_id: event.id,
      minutes_before: [15, 60],
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('15');
    expect(result.output).toContain('60');
  });

  test('returns error for non-existent event', () => {
    const result = handleSetReminder(ctx, {
      event_id: 9999,
      minutes_before: [15],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
