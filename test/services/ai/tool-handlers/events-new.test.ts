import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  handleGetEvent,
  handleGetUpcoming,
  handleSnoozeEvent,
} from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('handleGetUpcoming', () => {
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
    const eventService = new EventService({ eventRepo, reminderRepo });
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

  test('returns upcoming events', () => {
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Future Meeting',
      start_at: futureDate,
      end_at: new Date(Date.now() + 7200_000).toISOString(),
      timezone: 'UTC',
    });
    const result = handleGetUpcoming(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('Future Meeting');
    expect(result.output).toContain('Next 1');
  });

  test('returns no events message when empty', () => {
    const result = handleGetUpcoming(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('No upcoming events');
  });

  test('respects limit parameter', () => {
    for (let i = 1; i <= 3; i++) {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: `Event ${i}`,
        start_at: new Date(Date.now() + i * 3600_000).toISOString(),
        timezone: 'UTC',
      });
    }
    const result = handleGetUpcoming(ctx, { limit: 2 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Next 2');
    expect(result.output).toContain('Event 1');
    expect(result.output).toContain('Event 2');
    expect(result.output).not.toContain('Event 3');
  });

  test('defaults to limit 5', () => {
    for (let i = 1; i <= 7; i++) {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: `Event ${i}`,
        start_at: new Date(Date.now() + i * 3600_000).toISOString(),
        timezone: 'UTC',
      });
    }
    const result = handleGetUpcoming(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('Next 5');
    expect(result.output).not.toContain('Event 6');
  });

  test('includes location when present', () => {
    ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Office Meeting',
      start_at: new Date(Date.now() + 3600_000).toISOString(),
      location: 'Room 42',
      timezone: 'UTC',
    });
    const result = handleGetUpcoming(ctx, {});
    expect(result.success).toBe(true);
    expect(result.output).toContain('Room 42');
  });
});

describe('handleSnoozeEvent', () => {
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
    const eventService = new EventService({ eventRepo, reminderRepo });
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

  test('snoozes event by specified minutes', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Standup',
      start_at: '2026-03-15T10:00:00.000Z',
      end_at: '2026-03-15T10:30:00.000Z',
      timezone: 'UTC',
    });
    const result = handleSnoozeEvent(ctx, { event_id: event.id, minutes: 15 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('snoozed by 15 min');
    expect(result.output).toContain('2026-03-15T10:15:00.000Z');
  });

  test('defaults to 10 minutes', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Call',
      start_at: '2026-03-15T10:00:00.000Z',
      timezone: 'UTC',
    });
    const result = handleSnoozeEvent(ctx, { event_id: event.id });
    expect(result.success).toBe(true);
    expect(result.output).toContain('snoozed by 10 min');
    expect(result.output).toContain('2026-03-15T10:10:00.000Z');
  });

  test('returns error for non-existent event', () => {
    const result = handleSnoozeEvent(ctx, { event_id: 9999 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('shifts both start and end when end_at exists', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Meeting',
      start_at: '2026-03-15T14:00:00.000Z',
      end_at: '2026-03-15T15:00:00.000Z',
      timezone: 'UTC',
    });
    handleSnoozeEvent(ctx, { event_id: event.id, minutes: 30 });
    const updated = ctx.eventService.getEvent(event.id, USER_ID)!;
    expect(updated.start_at).toBe('2026-03-15T14:30:00.000Z');
    expect(updated.end_at).toBe('2026-03-15T15:30:00.000Z');
  });
});

describe('handleGetEvent', () => {
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
    const eventService = new EventService({ eventRepo, reminderRepo });
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

  test('returns event details', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Doctor Appointment',
      start_at: '2026-03-15T09:00:00Z',
      end_at: '2026-03-15T10:00:00Z',
      description: 'Annual checkup',
      location: 'Hospital',
      timezone: 'UTC',
    });
    const result = handleGetEvent(ctx, { event_id: event.id });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Doctor Appointment');
    expect(result.output).toContain('Annual checkup');
    expect(result.output).toContain('Hospital');
  });

  test('returns error for non-existent event', () => {
    const result = handleGetEvent(ctx, { event_id: 9999 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('includes reminders when present', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Reminder Test',
      start_at: '2026-03-15T09:00:00Z',
      timezone: 'UTC',
      reminder_minutes: [15, 60],
    });
    const result = handleGetEvent(ctx, { event_id: event.id });
    expect(result.success).toBe(true);
    expect(result.output).toContain('reminders');
    expect(result.output).toContain('15min');
    expect(result.output).toContain('60min');
  });

  test('includes recurrence rule when present', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Weekly Sync',
      start_at: '2026-03-15T09:00:00Z',
      timezone: 'UTC',
      recurrence_rule: 'FREQ=WEEKLY',
    });
    const result = handleGetEvent(ctx, { event_id: event.id });
    expect(result.success).toBe(true);
    expect(result.output).toContain('FREQ=WEEKLY');
  });
});
