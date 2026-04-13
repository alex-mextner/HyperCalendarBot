import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { maskPhone } from '../../../../src/config/constants.ts';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { TelegramSessionRepository } from '../../../../src/database/repositories/telegram-session.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleConnectTelegramStatus } from '../../../../src/services/ai/tool-handlers/settings.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

const MASTER_KEY = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
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

describe('handleConnectTelegramStatus', () => {
  let db: Database;
  let sessionRepo: TelegramSessionRepository;

  beforeEach(() => {
    db = createTestDb();
    sessionRepo = new TelegramSessionRepository(db);
  });

  test('returns connected: false with dismissed_recently: false when no session and never dismissed', () => {
    const ctx = makeCtx(db, {
      telegramSessionRepo: sessionRepo,
      telegramMasterKey: MASTER_KEY,
    });
    const result = handleConnectTelegramStatus(ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ connected: false, dismissed_recently: false });
    expect(result.output).toContain('not connected');
  });

  test('returns dismissed_recently: true when dismissed within 30 days', () => {
    // Create user first via makeCtx, then set dismissed_at, then re-read user
    const userRepo = new UserRepository(db);
    makeCtx(db); // ensures user exists
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    userRepo.setConnectTelegramDismissedAt(USER_ID, fiveDaysAgo);

    const ctx = makeCtx(db, {
      telegramSessionRepo: sessionRepo,
      telegramMasterKey: MASTER_KEY,
    });
    const result = handleConnectTelegramStatus(ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ connected: false, dismissed_recently: true });
  });

  test('returns dismissed_recently: false when dismissed 31 days ago', () => {
    // Create user first via makeCtx, then set dismissed_at, then re-read user
    const userRepo = new UserRepository(db);
    makeCtx(db); // ensures user exists
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    userRepo.setConnectTelegramDismissedAt(USER_ID, thirtyOneDaysAgo);

    const ctx = makeCtx(db, {
      telegramSessionRepo: sessionRepo,
      telegramMasterKey: MASTER_KEY,
    });
    const result = handleConnectTelegramStatus(ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ connected: false, dismissed_recently: false });
  });

  test('returns connected: true with masked phone when active session exists', () => {
    const userRepo = new UserRepository(db);
    userRepo.create({
      telegram_id: USER_ID,
      timezone: 'Europe/Belgrade',
      language: 'en',
      username: 'tester',
    });

    const encryptedSession = Buffer.from('session-data');
    const phoneMasked = maskPhone('+79001234567');
    sessionRepo.upsert(USER_ID, encryptedSession, phoneMasked, 'hash123');

    const ctx = makeCtx(db, {
      telegramSessionRepo: sessionRepo,
      telegramMasterKey: MASTER_KEY,
    });
    const result = handleConnectTelegramStatus(ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      connected: true,
      phone_masked: '+7 ••• 4567',
      status: 'active',
    });
  });

  test('returns not connected for expired session', () => {
    const userRepo = new UserRepository(db);
    userRepo.create({
      telegram_id: USER_ID,
      timezone: 'Europe/Belgrade',
      language: 'en',
      username: 'tester',
    });

    const encryptedSession = Buffer.from('session-data');
    const phoneMasked = maskPhone('+79001234567');
    sessionRepo.upsert(USER_ID, encryptedSession, phoneMasked, 'hash123');
    sessionRepo.updateStatus(USER_ID, 'expired');

    const ctx = makeCtx(db, {
      telegramSessionRepo: sessionRepo,
      telegramMasterKey: MASTER_KEY,
    });
    const result = handleConnectTelegramStatus(ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ connected: false, dismissed_recently: false });
  });

  test('RU output contains подключён', () => {
    const userRepo = new UserRepository(db);
    userRepo.create({
      telegram_id: USER_ID,
      timezone: 'Europe/Belgrade',
      language: 'ru',
      username: 'tester',
    });

    const encryptedSession = Buffer.from('session-data');
    const phoneMasked = maskPhone('+79001234567');
    sessionRepo.upsert(USER_ID, encryptedSession, phoneMasked, 'hash123');

    const ctx = makeCtx(db, {
      telegramSessionRepo: sessionRepo,
      telegramMasterKey: MASTER_KEY,
      user: userRepo.findByTelegramId(USER_ID)!,
    });
    const result = handleConnectTelegramStatus(ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('подключён');
  });

  test('returns not connected when telegramSessionRepo is undefined', () => {
    const ctx = makeCtx(db, {
      telegramSessionRepo: undefined,
      telegramMasterKey: MASTER_KEY,
    });
    const result = handleConnectTelegramStatus(ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ connected: false, dismissed_recently: false });
  });

  test('returns not connected when telegramMasterKey is undefined', () => {
    const userRepo = new UserRepository(db);
    userRepo.create({
      telegram_id: USER_ID,
      timezone: 'Europe/Belgrade',
      language: 'en',
      username: 'tester',
    });

    const encryptedSession = Buffer.from('session-data');
    const phoneMasked = maskPhone('+79001234567');
    sessionRepo.upsert(USER_ID, encryptedSession, phoneMasked, 'hash123');

    const ctx = makeCtx(db, {
      telegramSessionRepo: sessionRepo,
      telegramMasterKey: undefined,
    });
    const result = handleConnectTelegramStatus(ctx);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ connected: false, dismissed_recently: false });
  });
});
