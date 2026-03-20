import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleGetFreeSlots } from '../../../../src/services/ai/tool-handlers/slots.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('handleGetFreeSlots', () => {
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
      conversationLogger: null as never,
    };
  });

  test('returns free slots for a day with events', () => {
    ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Morning',
      start_at: '2026-03-15T09:00:00Z',
      end_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = handleGetFreeSlots(ctx, { date: '2026-03-15T00:00:00Z' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Free slots');
  });

  test('returns full day as free when no events', () => {
    const result = handleGetFreeSlots(ctx, { date: '2026-03-15T00:00:00Z' });
    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
  });

  describe('group scope', () => {
    const GROUP_CHAT_ID = -100999;

    function makeGroupCtx(): AgentContext {
      return {
        ...ctx,
        isGroup: true,
        groupChatId: GROUP_CHAT_ID,
        chatId: GROUP_CHAT_ID,
      };
    }

    test('returns free slots for group calendar with scope=group', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Morning',
        start_at: '2026-03-15T09:00:00Z',
        end_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: USER_ID,
      });
      const gCtx = makeGroupCtx();
      const result = handleGetFreeSlots(gCtx, { date: '2026-03-15T00:00:00Z', scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Free slots');
    });

    test('scope defaults to group when isGroup=true', () => {
      // Personal event should not affect group free slots
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal All Day',
        start_at: '2026-03-15T00:00:00Z',
        end_at: '2026-03-15T23:59:59Z',
        timezone: 'UTC',
      });
      const gCtx = makeGroupCtx();
      const result = handleGetFreeSlots(gCtx, { date: '2026-03-15T00:00:00Z' });
      expect(result.success).toBe(true);
      // Group has no events, so full day free
      expect(result.output).toContain('Free slots');
    });

    test('group scope ignores personal events', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Blocker',
        start_at: '2026-03-15T09:00:00Z',
        end_at: '2026-03-15T17:00:00Z',
        timezone: 'UTC',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Short',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: USER_ID,
      });
      const gCtx = makeGroupCtx();
      const result = handleGetFreeSlots(gCtx, { date: '2026-03-15T00:00:00Z', scope: 'group' });
      expect(result.success).toBe(true);
      // Group only has 1h busy, so there should be free slots before and after
      expect(result.output).toContain('Free slots');
    });
  });
});
