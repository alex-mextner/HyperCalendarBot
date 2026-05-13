// test/services/ai/tool-handlers/history.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { SKIP_PERSIST_TOOLS } from '../../../../src/services/ai/tool-executor.ts';
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
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'en' });
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'test',
      isGroup: false,
      eventService: new EventService({ eventRepo }),
      holidayService: new HolidayService(holidayRepo),
      chatHistory: chatHistoryRepo,
      userRepo,
      eventReminderRepo,
      conversationLogger: null as never,
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

  test('in group context returns group chat history, not private DM history', () => {
    const GROUP_CHAT_ID = -100999;
    // Private DM message — must NOT appear in group response
    ctx.chatHistory.save(USER_ID, 'user', 'private message');
    // Group message
    ctx.chatHistory.save(USER_ID, 'user', 'group message', GROUP_CHAT_ID);

    ctx.isGroup = true;
    ctx.groupChatId = GROUP_CHAT_ID;

    const result = handleGetHistory(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('group message');
    expect(result.output).not.toContain('private message');
  });

  test('accepts ISO 8601 before/after timestamps and converts to SQLite format', () => {
    ctx.chatHistory.save(USER_ID, 'user', 'target message');
    const after = new Date(Date.now() - 60000).toISOString(); // 1 min ago in ISO format
    const before = new Date(Date.now() + 60000).toISOString(); // 1 min ahead

    const result = handleGetHistory(ctx, { after, before });
    expect(result.success).toBe(true);
    expect(result.output).toContain('target message');
  });

  test('accepts ISO 8601 with timezone offset', () => {
    ctx.chatHistory.save(USER_ID, 'user', 'offset test message');
    const after = new Date(Date.now() - 60000).toISOString().replace('Z', '+00:00');
    const before = new Date(Date.now() + 60000).toISOString().replace('Z', '+00:00');

    const result = handleGetHistory(ctx, { after, before });
    expect(result.success).toBe(true);
    expect(result.output).toContain('offset test message');
  });

  test('in group context search filter is applied', () => {
    const GROUP_CHAT_ID = -100888;
    ctx.chatHistory.save(USER_ID, 'user', 'встреча с клиентом', GROUP_CHAT_ID);
    ctx.chatHistory.save(USER_ID, 'user', 'погода сегодня', GROUP_CHAT_ID);

    ctx.isGroup = true;
    ctx.groupChatId = GROUP_CHAT_ID;

    const result = handleGetHistory(ctx, { search: 'встреч' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('клиентом');
    expect(result.output).not.toContain('погода');
  });

  test('handleGetHistory.meta has skipPersist: true to prevent recursive embedding', () => {
    expect(handleGetHistory.meta.skipPersist).toBe(true);
  });

  test('SKIP_PERSIST_TOOLS includes get_history', () => {
    expect(SKIP_PERSIST_TOOLS.has('get_history')).toBe(true);
  });

  test('tool result rows stored by other tools are visible in get_history output', () => {
    ctx.chatHistory.save(USER_ID, 'user', 'создай встречу');
    ctx.chatHistory.save(USER_ID, 'tool', 'Event created: Meeting (ID: 42)');
    ctx.chatHistory.save(USER_ID, 'assistant', JSON.stringify([{ type: 'text', text: 'Встреча создана' }]));

    const result = handleGetHistory(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('[tool_result]');
    expect(result.output).toContain('Event created: Meeting (ID: 42)');
  });
});
