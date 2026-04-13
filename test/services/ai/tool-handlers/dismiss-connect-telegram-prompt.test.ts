import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleDismissConnectTelegramPrompt } from '../../../../src/services/ai/tool-handlers/settings.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

const USER_ID = 42;

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeCtx(db: Database, overrides: Partial<AgentContext> = {}): AgentContext {
  const userRepo = new UserRepository(db);
  const eventRepo = new EventRepository(db);
  const eventReminderRepo = new EventReminderRepository(db);
  const holidayRepo = new HolidayRepository(db);
  const chatHistoryRepo = new ChatHistoryRepository(db);

  const existingUser = userRepo.findByTelegramId(USER_ID);
  if (!existingUser) {
    userRepo.create({
      telegram_id: USER_ID,
      timezone: 'Europe/Belgrade',
      language: 'en',
      username: 'tester',
    });
  }

  return {
    user: userRepo.findByTelegramId(USER_ID)!,
    chatId: USER_ID,
    messageText: '',
    isGroup: false,
    eventService: new EventService({ eventRepo }),
    holidayService: new HolidayService(holidayRepo),
    chatHistory: chatHistoryRepo,
    userRepo,
    eventReminderRepo,
    conversationLogger: null as never,
    ...overrides,
  } as unknown as AgentContext;
}

describe('handleDismissConnectTelegramPrompt', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  test('sets connect_telegram_dismissed_at to current time', () => {
    const ctx = makeCtx(db);
    const before = Date.now();
    const result = handleDismissConnectTelegramPrompt(ctx);
    const after = Date.now();

    expect(result.success).toBe(true);
    expect(result.output).toContain('30 days');

    const userRepo = new UserRepository(db);
    const user = userRepo.findByTelegramId(USER_ID)!;
    expect(user.connect_telegram_dismissed_at).not.toBeNull();

    const dismissedTime = new Date(user.connect_telegram_dismissed_at!).getTime();
    expect(dismissedTime).toBeGreaterThanOrEqual(before);
    expect(dismissedTime).toBeLessThanOrEqual(after);
  });

  test('idempotent — second call updates timestamp without error', () => {
    const ctx = makeCtx(db);
    const result1 = handleDismissConnectTelegramPrompt(ctx);
    expect(result1.success).toBe(true);

    const userRepo = new UserRepository(db);
    const firstDismissed = userRepo.findByTelegramId(USER_ID)!.connect_telegram_dismissed_at;

    const ctx2 = makeCtx(db);
    const result2 = handleDismissConnectTelegramPrompt(ctx2);
    expect(result2.success).toBe(true);

    const secondDismissed = userRepo.findByTelegramId(USER_ID)!.connect_telegram_dismissed_at;
    expect(secondDismissed).not.toBeNull();
    // Second call should update the timestamp (>= first)
    expect(new Date(secondDismissed!).getTime()).toBeGreaterThanOrEqual(new Date(firstDismissed!).getTime());
  });
});
