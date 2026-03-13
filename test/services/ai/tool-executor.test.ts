import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('executeTool', () => {
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
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
    };
  });

  test('routes get_events to handler', () => {
    const result = executeTool(ctx, 'get_events', {
      start_date: '2026-03-15T00:00:00Z',
      end_date: '2026-03-15T23:59:59Z',
    });
    expect(result.success).toBe(true);
  });

  test('routes create_event to handler', () => {
    const result = executeTool(ctx, 'create_event', {
      title: 'Test',
      start_at: '2026-03-15T14:00:00Z',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Test');
  });

  test('routes update_event to handler', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Old',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = executeTool(ctx, 'update_event', {
      event_id: event.id,
      title: 'New',
    });
    expect(result.success).toBe(true);
  });

  test('routes delete_event to handler', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Del',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = executeTool(ctx, 'delete_event', { event_id: event.id });
    expect(result.success).toBe(true);
  });

  test('routes get_free_slots to handler', () => {
    const result = executeTool(ctx, 'get_free_slots', {
      date: '2026-03-15T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  test('routes search_events to handler', () => {
    const result = executeTool(ctx, 'search_events', { query: 'test' });
    expect(result.success).toBe(true);
  });

  test('routes set_reminder to handler', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Meeting',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = executeTool(ctx, 'set_reminder', {
      event_id: event.id,
      minutes_before: [15],
    });
    expect(result.success).toBe(true);
  });

  test('routes get_holidays to handler', () => {
    const result = executeTool(ctx, 'get_holidays', {});
    expect(result.success).toBe(true);
  });

  test('routes get_user_settings to handler', () => {
    const result = executeTool(ctx, 'get_user_settings', {});
    expect(result.success).toBe(true);
  });

  test('routes update_user_settings to handler', () => {
    const result = executeTool(ctx, 'update_user_settings', {
      timezone: 'Europe/London',
    });
    expect(result.success).toBe(true);
  });

  test('returns error for unknown tool', () => {
    const result = executeTool(ctx, 'unknown_tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });
});
