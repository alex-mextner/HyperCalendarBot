// test/services/ai/tool-handlers/history.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleGetHistory } from '../../../../src/services/ai/tool-handlers/history.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('handleGetHistory', () => {
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'en' });
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'test',
      isGroup: false,
      eventService: new EventService(eventRepo, reminderRepo),
      holidayService: new HolidayService(holidayRepo),
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
    };
  });

  test('returns formatted history as text', () => {
    ctx.chatHistory.save(USER_ID, 'user', 'добавь встречу');
    ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify([{ type: 'text', text: 'Встреча создана' }]));

    const result = handleGetHistory(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('добавь встречу');
    expect(result.output).toContain('Встреча создана');
  });

  test('respects limit parameter', () => {
    for (let i = 0; i < 20; i++) ctx.chatHistory.save(USER_ID, 'user', `msg ${i}`);

    const result = handleGetHistory(ctx, { limit: 5 });
    expect(result.success).toBe(true);
    const lines = result
      .output!.trim()
      .split('\n')
      .filter((l) => l.includes('[user]'));
    expect(lines.length).toBe(5);
  });

  test('filters by search text', () => {
    ctx.chatHistory.save(USER_ID, 'user', 'добавь встречу с Иваном');
    ctx.chatHistory.save(USER_ID, 'user', 'что завтра');

    const result = handleGetHistory(ctx, { search: 'встреч' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Иваном');
    expect(result.output).not.toContain('завтра');
  });

  test('returns message when no history found', () => {
    const result = handleGetHistory(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('No history');
  });

  test('formats activity events in output', () => {
    const btnEvent = JSON.stringify({ kind: 'button', label: 'Удалить', detail: 'Спортзал' });
    ctx.chatHistory.save(USER_ID, 'user', btnEvent);

    const result = handleGetHistory(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('[Button: "Удалить"]');
  });
});
