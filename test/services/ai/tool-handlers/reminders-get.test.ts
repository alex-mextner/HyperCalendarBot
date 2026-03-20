import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleGetReminders } from '../../../../src/services/ai/tool-handlers/reminders.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('handleGetReminders', () => {
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

  test('returns reminders for event', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Meeting',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
      reminder_minutes: [15, 60],
    });
    const result = handleGetReminders(ctx, { event_id: event.id });
    expect(result.success).toBe(true);
    expect(result.output).toContain('15min before');
    expect(result.output).toContain('1h before');
    expect(result.output).toContain('Meeting');
  });

  test('returns error for non-existent event', () => {
    const result = handleGetReminders(ctx, { event_id: 9999 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('returns no reminders message when none set', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Quick Note',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    // Remove default reminders
    ctx.reminderRepo.removeByEventId(event.id);

    const result = handleGetReminders(ctx, { event_id: event.id });
    expect(result.success).toBe(true);
    expect(result.output).toContain('No reminders');
    expect(result.output).toContain('Quick Note');
  });

  test('formats hours and minutes correctly', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Long Reminder',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    ctx.reminderRepo.removeByEventId(event.id);
    ctx.reminderRepo.setForEvent(event.id, [90, 120]);

    const result = handleGetReminders(ctx, { event_id: event.id });
    expect(result.success).toBe(true);
    expect(result.output).toContain('1h 30m before');
    expect(result.output).toContain('2h before');
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

    test('returns reminders for group event with scope=group', () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
        reminder_minutes: [15, 60],
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: USER_ID,
      });
      const gCtx = makeGroupCtx();
      const result = handleGetReminders(gCtx, { event_id: event.id, scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Standup');
      expect(result.output).toContain('15min before');
    });

    test('scope defaults to group when isGroup=true', () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Default',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
        reminder_minutes: [30],
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: USER_ID,
      });
      const gCtx = makeGroupCtx();
      const result = handleGetReminders(gCtx, { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Default');
    });

    test('returns error for personal event when scope=group', () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Only',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const gCtx = makeGroupCtx();
      const result = handleGetReminders(gCtx, { event_id: event.id, scope: 'group' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
