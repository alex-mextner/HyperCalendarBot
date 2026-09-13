import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { executeTool } from '../../../src/services/ai/tool-executor.ts';
import { toolSchemas } from '../../../src/services/ai/tool-schemas.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('toolSchemas', () => {
  test('has schema for every tool that the executor handles', () => {
    // All tools from the ToolInputMap should have a schema entry
    const expectedTools = [
      'supplement_skip',
      'end_conversation',
      'get_events',
      'create_event',
      'update_event',
      'attach_pending_location_to_event',
      'delete_event',
      'get_free_slots',
      'search_events',
      'create_birthday_event',
      'get_upcoming',
      'snooze_event',
      'get_event',
      'notify_participants',
      'get_reminders',
      'set_reminder',
      'find_user',
      'ask_user',
      'pick_users',
      'get_contacts',
      'add_contact',
      'find_contact',
      'update_contact',
      'render_day_image',
      'render_week_image',
      'render_month_image',
      'render_table',
      'end_call',
      'make_call',
      'get_holidays',
      'manage_settings',
      'share_event',
      'send_invitation',
      'get_invitation_status',
      'share_agenda',
      'set_event_visibility',
      'propose_edit',
      'cancel_invitation',
      'resend_invitation',
      'get_google_calendar_status',
      'list_google_calendars',
      'lookup_stress',
      'send_feedback',
      'get_bot_info',
      'calculate',
      'get_timezone_info',
      'convert_to_timezone',
      'list_calendar_access',
      'manage_secretaries',
      'propose_calendar_change',
      'get_history',
      'get_action_log',
      'schedule_ai_call',
      'schedule_ai_calls_list',
      'schedule_ai_call_cancel',
      'add_trigger',
      'list_triggers',
      'remove_trigger',
      'set_reaction',
      'remember_user_fact',
      'resume_scene',
      'cancel_scene',
    ];

    for (const tool of expectedTools) {
      expect(toolSchemas[tool as keyof typeof toolSchemas]).toBeDefined();
    }
  });

  test('create_event schema validates required fields', () => {
    const schema = toolSchemas.create_event;

    const valid = schema.safeParse({ title: 'Meeting', start_at: '2026-03-15T14:00:00Z' });
    expect(valid.success).toBe(true);

    const missingTitle = schema.safeParse({ start_at: '2026-03-15T14:00:00Z' });
    expect(missingTitle.success).toBe(false);

    const missingStartAt = schema.safeParse({ title: 'Meeting' });
    expect(missingStartAt.success).toBe(false);
  });

  test('create_event schema accepts optional fields', () => {
    const schema = toolSchemas.create_event;
    const result = schema.safeParse({
      title: 'Meeting',
      start_at: '2026-03-15T14:00:00Z',
      end_at: '2026-03-15T15:00:00Z',
      description: 'Weekly sync',
      location: 'Room 3',
      all_day: false,
      recurrence_rule: 'FREQ=WEEKLY',
      reminder_minutes: [15, 60],
      force: true,
      scope: 'personal',
    });
    expect(result.success).toBe(true);
  });

  test('create_event schema rejects wrong types', () => {
    const schema = toolSchemas.create_event;
    const result = schema.safeParse({
      title: 123,
      start_at: '2026-03-15T14:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  test('get_events schema rejects missing required fields', () => {
    const schema = toolSchemas.get_events;

    const noEndDate = schema.safeParse({ start_date: '2026-03-15T00:00:00Z' });
    expect(noEndDate.success).toBe(false);

    const noStartDate = schema.safeParse({ end_date: '2026-03-15T23:59:59Z' });
    expect(noStartDate.success).toBe(false);

    const empty = schema.safeParse({});
    expect(empty.success).toBe(false);
  });

  test('set_reminder schema validates array of numbers', () => {
    const schema = toolSchemas.set_reminder;

    const valid = schema.safeParse({ event_id: 1, minutes_before: [15, 60] });
    expect(valid.success).toBe(true);

    const wrongType = schema.safeParse({ event_id: 1, minutes_before: 'fifteen' });
    expect(wrongType.success).toBe(false);

    const mixedArray = schema.safeParse({ event_id: 1, minutes_before: [15, 'sixty'] });
    expect(mixedArray.success).toBe(false);
  });

  test('share_event schema validates enum values', () => {
    const schema = toolSchemas.share_event;

    const valid = schema.safeParse({ event_id: 1, target_type: 'user', target_id: 42 });
    expect(valid.success).toBe(true);

    const invalidTargetType = schema.safeParse({ event_id: 1, target_type: 'channel', target_id: 42 });
    expect(invalidTargetType.success).toBe(false);
  });

  test('send_feedback schema validates feedback type enum', () => {
    const schema = toolSchemas.send_feedback;

    const valid = schema.safeParse({ type: 'bug', message: 'Something broke' });
    expect(valid.success).toBe(true);

    const invalidType = schema.safeParse({ type: 'complaint', message: 'Not happy' });
    expect(invalidType.success).toBe(false);
  });

  test('manage_settings schema validates action enum', () => {
    const schema = toolSchemas.manage_settings;

    const getAll = schema.safeParse({ action: 'get' });
    expect(getAll.success).toBe(true);

    const update = schema.safeParse({ action: 'update', category: 'general', updates: { language: 'en' } });
    expect(update.success).toBe(true);

    const invalidAction = schema.safeParse({ action: 'delete' });
    expect(invalidAction.success).toBe(false);
  });

  test('send_invitation schema requires an invitee_id or invitee_username', () => {
    const schema = toolSchemas.send_invitation;

    const missingBoth = schema.safeParse({ event_id: 1 });
    expect(missingBoth.success).toBe(false);

    const withId = schema.safeParse({ event_id: 1, invitee_id: 42 });
    expect(withId.success).toBe(true);

    const withUsername = schema.safeParse({ event_id: 1, invitee_username: 'bob' });
    expect(withUsername.success).toBe(true);
  });

  test('passthrough allows extra fields', () => {
    const schema = toolSchemas.get_events;
    const result = schema.safeParse({
      start_date: '2026-03-15T00:00:00Z',
      end_date: '2026-03-15T23:59:59Z',
      extra_field: 'hello',
    });
    expect(result.success).toBe(true);
  });

  test('create_birthday_event schema validates nested object', () => {
    const schema = toolSchemas.create_birthday_event;

    const valid = schema.safeParse({ celebrant_id: 42, date: { day: 15, month: 3 } });
    expect(valid.success).toBe(true);

    const missingDay = schema.safeParse({ celebrant_id: 42, date: { month: 3 } });
    expect(missingDay.success).toBe(false);

    const wrongDateType = schema.safeParse({ celebrant_id: 42, date: '2026-03-15' });
    expect(wrongDateType.success).toBe(false);
  });

  test('get_timezone_info schema accepts string or array', () => {
    const schema = toolSchemas.get_timezone_info;

    const single = schema.safeParse({ timezone: 'Europe/Moscow' });
    expect(single.success).toBe(true);

    const array = schema.safeParse({ timezone: ['Europe/Moscow', 'America/New_York'] });
    expect(array.success).toBe(true);

    const wrongType = schema.safeParse({ timezone: 42 });
    expect(wrongType.success).toBe(false);
  });

  test('remember_user_fact schema validates type enum', () => {
    const schema = toolSchemas.remember_user_fact;

    const valid = schema.safeParse({ type: 'append', content: 'Likes coffee' });
    expect(valid.success).toBe(true);

    const invalidType = schema.safeParse({ type: 'delete', content: 'No more coffee' });
    expect(invalidType.success).toBe(false);
  });
});

describe('dispatchTool validation integration', () => {
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const eventService = new EventService({ eventRepo });
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
      eventReminderRepo,
      conversationLogger: null as never,
    };
  });

  test('returns validation error for malformed get_events input', async () => {
    const result = await executeTool(ctx, 'get_events', { start_date: 123 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  test('returns validation error for missing required fields', async () => {
    const result = await executeTool(ctx, 'create_event', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  test('returns validation error for wrong enum value', async () => {
    const result = await executeTool(ctx, 'send_feedback', { type: 'complaint', message: 'test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });

  test('passes valid input through to handler', async () => {
    const result = await executeTool(ctx, 'get_events', {
      start_date: '2026-03-15T00:00:00Z',
      end_date: '2026-03-15T23:59:59Z',
    });
    expect(result.success).toBe(true);
  });

  test('passes valid input with extra fields through to handler', async () => {
    const result = await executeTool(ctx, 'get_events', {
      start_date: '2026-03-15T00:00:00Z',
      end_date: '2026-03-15T23:59:59Z',
      extra_ai_field: 'ignored',
    });
    expect(result.success).toBe(true);
  });

  test('returns validation error for completely garbage input', async () => {
    const result = await executeTool(ctx, 'calculate', 'not an object');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input');
  });
});
