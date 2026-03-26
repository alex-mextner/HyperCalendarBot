// test/services/ai/tool-handlers/action-log.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ActionLogRepository } from '../../../../src/database/repositories/action-log.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleGetActionLog } from '../../../../src/services/ai/tool-handlers/action-log.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 123;

describe('handleGetActionLog', () => {
  let ctx: AgentContext;
  let actionLogRepo: ActionLogRepository;

  beforeEach(() => {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const holidayRepo = new HolidayRepository(db);
    actionLogRepo = new ActionLogRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'en' });
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'test',
      isGroup: false,
      eventService: new EventService({ eventRepo, reminderRepo }),
      holidayService: new HolidayService(holidayRepo),
      chatHistory: null as never,
      userRepo,
      reminderRepo,
      conversationLogger: null as never,
      actionLogRepo,
    };
  });

  test('returns not-found message when log is empty', () => {
    const result = handleGetActionLog(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('No action log entries found');
  });

  test('returns not-found in Russian for ru user', () => {
    ctx.user = { ...ctx.user, language: 'ru' };
    const result = handleGetActionLog(ctx, {});
    expect(result.output).toContain('Записей в логе действий не найдено');
  });

  test('returns formatted entries', () => {
    actionLogRepo.insert({
      user_id: USER_ID,
      chat_id: USER_ID,
      action_type: 'ai_tool',
      action_name: 'create_event',
      input_summary: 'Meeting tomorrow',
      result_summary: 'id: 1\ntitle: Meeting',
      target_event_id: 1,
    });

    const result = handleGetActionLog(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('ai_tool:create_event');
    expect(result.output).toContain('Meeting tomorrow');
    expect(result.output).toContain('event_id: 1');
  });

  test('filters by event_id', () => {
    actionLogRepo.insert({
      user_id: USER_ID,
      chat_id: USER_ID,
      action_type: 'ai_tool',
      action_name: 'create_event',
      target_event_id: 10,
    });
    actionLogRepo.insert({
      user_id: USER_ID,
      chat_id: USER_ID,
      action_type: 'ai_tool',
      action_name: 'delete_event',
      target_event_id: 20,
    });

    const result = handleGetActionLog(ctx, { event_id: 10 });
    expect(result.output).toContain('create_event');
    expect(result.output).not.toContain('delete_event');
  });

  test('filters by action_type', () => {
    actionLogRepo.insert({
      user_id: USER_ID,
      chat_id: USER_ID,
      action_type: 'command',
      action_name: '/add',
    });
    actionLogRepo.insert({
      user_id: USER_ID,
      chat_id: USER_ID,
      action_type: 'ai_tool',
      action_name: 'create_event',
    });

    const result = handleGetActionLog(ctx, { action_type: 'command' });
    expect(result.output).toContain('/add');
    expect(result.output).not.toContain('create_event');
  });

  test('includes telegram link for supergroup messages', () => {
    actionLogRepo.insert({
      user_id: USER_ID,
      chat_id: -1001234567890,
      action_type: 'ai_tool',
      action_name: 'create_event',
      message_id: 42,
    });

    const result = handleGetActionLog(ctx, {});
    expect(result.output).toContain('https://t.me/c/1234567890/42');
  });

  test('returns error when actionLogRepo is not available', () => {
    ctx.actionLogRepo = undefined;
    const result = handleGetActionLog(ctx, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  test('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      actionLogRepo.insert({
        user_id: USER_ID,
        chat_id: USER_ID,
        action_type: 'command',
        action_name: `/cmd${i}`,
      });
    }

    const result = handleGetActionLog(ctx, { limit: 3 });
    // Count entries by counting the action_type: markers
    const entries = result.output!.split('command:').length - 1;
    expect(entries).toBe(3);
  });

  test('shows success/failure status', () => {
    actionLogRepo.insert({
      user_id: USER_ID,
      chat_id: USER_ID,
      action_type: 'ai_tool',
      action_name: 'delete_event',
      success: false,
    });

    const result = handleGetActionLog(ctx, {});
    expect(result.output).toContain('✗');
  });
});
