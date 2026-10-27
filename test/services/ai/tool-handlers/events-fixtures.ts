// Shared in-memory fixture for the event tool-handler tests (events*.test.ts): a fresh database
// with one UTC user and the services the handlers read from. Each file calls createEventToolFixture()
// from its own beforeEach, exactly as the former single file did.
import { Database } from 'bun:sqlite';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../../src/services/conversation-logger.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

export const USER_ID = 123;

export function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

export interface EventToolFixture {
  db: Database;
  ctx: AgentContext;
}

export function createEventToolFixture(): EventToolFixture {
  const db = createTestDb();
  const userRepo = new UserRepository(db);
  const eventRepo = new EventRepository(db);
  const eventReminderRepo = new EventReminderRepository(db);
  const chatHistoryRepo = new ChatHistoryRepository(db);
  const holidayRepo = new HolidayRepository(db);
  userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
  const eventService = new EventService({ eventRepo });
  const holidayService = new HolidayService(holidayRepo);
  const ctx: AgentContext = {
    user: userRepo.findByTelegramId(USER_ID)!,
    chatId: USER_ID,
    messageText: '',
    isGroup: false,
    eventService,
    holidayService,
    chatHistory: chatHistoryRepo,
    userRepo,
    eventReminderRepo,
    conversationLogger: new ConversationLogger(chatHistoryRepo),
  };
  return { db, ctx };
}
