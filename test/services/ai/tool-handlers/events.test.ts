import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ParticipantRepository } from '../../../../src/database/repositories/participant.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  handleCreateEvent,
  handleDeleteEvent,
  handleGetEvents,
  handleNotifyParticipants,
  handleSearchEvents,
  handleUpdateEvent,
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

describe('event tool handlers', () => {
  let db: Database;
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
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
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
    };
  });

  describe('handleGetEvents', () => {
    test('returns events in range', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Test Event',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      const result = handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Test Event');
    });

    test('returns message when no events found', () => {
      const result = handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No events');
    });
  });

  describe('handleCreateEvent', () => {
    test('creates event and returns details', () => {
      const result = handleCreateEvent(ctx, {
        title: 'New Meeting',
        start_at: '2026-03-15T14:00:00Z',
        end_at: '2026-03-15T15:00:00Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Meeting');
      expect(result.output).toContain('id');
    });

    test('creates event with description and location', () => {
      const result = handleCreateEvent(ctx, {
        title: 'Lunch',
        start_at: '2026-03-15T12:00:00Z',
        description: 'Team lunch',
        location: 'Cafe',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Lunch');
    });
  });

  describe('handleUpdateEvent', () => {
    test('updates event title', () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Old Title',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const result = handleUpdateEvent(ctx, {
        event_id: event.id,
        title: 'New Title',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Title');
    });

    test('returns error for non-existent event', () => {
      const result = handleUpdateEvent(ctx, {
        event_id: 9999,
        title: 'Whatever',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('handleDeleteEvent', () => {
    test('deletes event', () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'To Delete',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const result = handleDeleteEvent(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
    });

    test('returns error for non-existent event', () => {
      const result = handleDeleteEvent(ctx, { event_id: 9999 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('handleSearchEvents', () => {
    test('finds events by title', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Lunch Break',
        start_at: '2026-03-15T12:00:00Z',
        timezone: 'UTC',
      });
      const result = handleSearchEvents(ctx, { query: 'Standup' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Team Standup');
      expect(result.output).not.toContain('Lunch Break');
    });

    test('returns message when nothing found', () => {
      const result = handleSearchEvents(ctx, { query: 'nonexistent' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No events');
    });
  });

  describe('handleUpdateEvent — participant info', () => {
    test('output mentions participant count when event has accepted participants', () => {
      const participantRepo = new ParticipantRepository(db);
      const otherUserId = 999;
      const userRepo = new UserRepository(db);
      userRepo.create({ telegram_id: otherUserId, timezone: 'UTC' });

      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Shared Meeting',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, otherUserId, 'accepted');

      const ctxWithParticipants = { ...ctx, participantRepo };
      const result = handleUpdateEvent(ctxWithParticipants, {
        event_id: event.id,
        title: 'Renamed Meeting',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('1 participant');
      expect(result.output).toContain('notify');
    });

    test('output does not mention participants when event has none', () => {
      const participantRepo = new ParticipantRepository(db);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Solo Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });

      const ctxWithParticipants = { ...ctx, participantRepo };
      const result = handleUpdateEvent(ctxWithParticipants, {
        event_id: event.id,
        title: 'Still Solo',
      });
      expect(result.success).toBe(true);
      expect(result.output).not.toContain('participant');
    });
  });

  describe('handleNotifyParticipants', () => {
    test('sends message to accepted participants', () => {
      const participantRepo = new ParticipantRepository(db);
      const otherUserId = 999;
      const userRepo = new UserRepository(db);
      userRepo.create({ telegram_id: otherUserId, timezone: 'UTC' });

      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, otherUserId, 'accepted');

      const sent: { chatId: number; text: string }[] = [];
      const ctxWithSender = {
        ...ctx,
        participantRepo,
        sender: {
          sendMessage: async (chatId: number, text: string) => {
            sent.push({ chatId, text });
            return { message_id: 1 };
          },
          editMessageText: async () => {},
        },
      };

      const result = handleNotifyParticipants(ctxWithSender, {
        event_id: event.id,
        message: 'Meeting moved to 11:00',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('1 participant');
    });

    test('returns error when event not found', () => {
      const result = handleNotifyParticipants(ctx, {
        event_id: 9999,
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('returns error when no participants', () => {
      const participantRepo = new ParticipantRepository(db);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Solo',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });

      const ctxWithParticipants = { ...ctx, participantRepo };
      const result = handleNotifyParticipants(ctxWithParticipants, {
        event_id: event.id,
        message: 'Test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('no accepted participants');
    });
  });
});
