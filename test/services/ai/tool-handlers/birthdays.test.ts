import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { BirthdayMetadataRepository } from '../../../../src/database/repositories/birthday-metadata.repository.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { NotificationPreferencesRepository } from '../../../../src/database/repositories/notification-preferences.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleCreateBirthdayEvent } from '../../../../src/services/ai/tool-handlers/birthdays.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { BirthdayService } from '../../../../src/services/birthday/birthday-service.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('handleCreateBirthdayEvent', () => {
  let db: Database;
  let birthdayService: BirthdayService;
  let ctx: AgentContext;
  const OWNER_ID = 1;
  const CELEBRANT_ID = 42;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    const metaRepo = new BirthdayMetadataRepository(db);
    const eventReminderRepo = new EventReminderRepository(db);
    const prefsRepo = new NotificationPreferencesRepository(db);

    userRepo.create({ telegram_id: OWNER_ID, first_name: 'Alice', timezone: 'UTC' });
    userRepo.create({ telegram_id: CELEBRANT_ID, first_name: 'Ivan', username: 'ivan_t', timezone: 'UTC' });

    birthdayService = new BirthdayService(eventRepo, metaRepo, eventReminderRepo, prefsRepo);
    const eventService = new EventService(eventRepo, reminderRepo);
    const holidayService = new HolidayService(holidayRepo);

    ctx = {
      user: userRepo.findByTelegramId(OWNER_ID)!,
      chatId: OWNER_ID,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      conversationLogger: null as never,
      userRepo,
      reminderRepo,
      birthdayService,
    };
  });

  test('creates birthday event successfully', () => {
    const result = handleCreateBirthdayEvent(ctx, {
      celebrant_id: CELEBRANT_ID,
      date: { day: 10, month: 5 },
      year: 1996,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Ivan');

    const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all();
    expect(events.length).toBe(1);
  });

  test('returns conflict error when date differs in personal calendar', () => {
    handleCreateBirthdayEvent(ctx, {
      celebrant_id: CELEBRANT_ID,
      date: { day: 10, month: 5 },
    });
    const result = handleCreateBirthdayEvent(ctx, {
      celebrant_id: CELEBRANT_ID,
      date: { day: 11, month: 5 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('no-ops and reports existing when same date', () => {
    handleCreateBirthdayEvent(ctx, {
      celebrant_id: CELEBRANT_ID,
      date: { day: 10, month: 5 },
    });
    const result = handleCreateBirthdayEvent(ctx, {
      celebrant_id: CELEBRANT_ID,
      date: { day: 10, month: 5 },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('already');

    const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all();
    expect(events.length).toBe(1);
  });

  test('uses custom_name when provided', () => {
    const result = handleCreateBirthdayEvent(ctx, {
      celebrant_id: CELEBRANT_ID,
      date: { day: 10, month: 5 },
      custom_name: 'Ваня',
    });
    expect(result.success).toBe(true);

    const event = db.prepare("SELECT title FROM events WHERE event_type = 'birthday'").get() as { title: string };
    expect(event.title).toContain('Ваня');
  });

  test('returns error when birthdayService is not available', () => {
    const ctxNoBirthday = { ...ctx, birthdayService: undefined };
    const result = handleCreateBirthdayEvent(ctxNoBirthday, {
      celebrant_id: CELEBRANT_ID,
      date: { day: 10, month: 5 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('unavailable');
  });

  test('falls back to celebrant_id when user not found in DB', () => {
    const result = handleCreateBirthdayEvent(ctx, {
      celebrant_id: 99999,
      date: { day: 1, month: 1 },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('99999');
  });

  test('english locale produces english output', () => {
    ctx.user = { ...ctx.user, language: 'en' };
    const result = handleCreateBirthdayEvent(ctx, {
      celebrant_id: CELEBRANT_ID,
      date: { day: 15, month: 8 },
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Birthday created');
  });
});
