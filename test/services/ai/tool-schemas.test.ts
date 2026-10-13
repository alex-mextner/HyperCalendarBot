import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository, UNRESOLVED_PLACE } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CalendarEvent } from '../../../src/database/types.ts';
import { executeTool } from '../../../src/services/ai/tool-executor.ts';
import { toolSchemas } from '../../../src/services/ai/tool-schemas.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import type { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';

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

  test('path-less validation issue carries a whole-schema excerpt (#350)', async () => {
    // Object-level refine: neither invitee field given, so the issue has no path.
    const result = await executeTool(ctx, 'send_invitation', { event_id: 1 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Either invitee_id or invitee_username must be provided');
    expect(result.error).toContain('[schema: ');
    expect(result.error).toContain('invitee_username (string, optional)');
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

describe('numeric ID boundary', () => {
  test.each(['1', '0', '-100123', '9007199254740991'])('normalizes %s losslessly', (id) => {
    expect(toolSchemas.delete_event.parse({ event_id: id })).toEqual({ event_id: parseInt(id, 10) });
  });
  test.each([
    null,
    true,
    false,
    '',
    ' ',
    ' 1',
    '1 ',
    '+1',
    '01',
    '-0',
    '1e2',
    '0x10',
    '1.0',
    '1.2',
    '9007199254740992',
    9007199254740992,
    1.5,
  ])('rejects invalid ID %j', (id) => {
    expect(toolSchemas.delete_event.safeParse({ event_id: id }).success).toBe(false);
  });
  test('leaves unrelated and nested fields alone', () => {
    expect(toolSchemas.snooze_event.safeParse({ event_id: 1, minutes: '15' }).success).toBe(false);
    expect(toolSchemas.delete_event.parse({ event_id: 1, arbitrary_id: '2', nested: { event_id: '3' } })).toEqual({
      event_id: 1,
      arbitrary_id: '2',
      nested: { event_id: '3' },
    });
    expect(toolSchemas.remove_trigger.parse({ id: '123' })).toEqual({ id: '123' });
  });
});

/** Records every location-verification request (the picker) made by an event tool. */
function makeLocationVerificationSpy(): {
  service: LocationVerificationService;
  verifiedEventIds: number[];
  verifiedEvents: CalendarEvent[];
} {
  const verifiedEventIds: number[] = [];
  const verifiedEvents: CalendarEvent[] = [];
  const partial: Partial<LocationVerificationService> = {
    verifyEventLocation: async (event) => {
      verifiedEventIds.push(event.id);
      verifiedEvents.push(event);
      return { resolved: true, geocoded: null, cityExtracted: null, candidates: [] };
    },
    refreshInvitationCards: async () => {},
  };
  return { service: partial as unknown as LocationVerificationService, verifiedEventIds, verifiedEvents };
}

/** The resolved-place columns of an event, which only the creator's tap or pin may set. */
function resolvedPlace(event: CalendarEvent | null | undefined) {
  if (!event) return null;
  const { resolved_address, latitude, longitude, google_maps_url, venue_name, location_verified } = event;
  return { resolved_address, latitude, longitude, google_maps_url, venue_name, location_verified };
}

describe('a model payload never confirms a place (#620)', () => {
  const USER_ID = 123;
  /** A place the model made up, in every column the verification service owns. */
  const MODEL_PLACE = {
    resolved_address: 'Far Away 1, Sample City',
    latitude: 10.5,
    longitude: 20.5,
    google_maps_url: 'https://www.google.com/maps/search/?api=1&query=10.5,20.5',
    venue_name: 'Far Away Venue',
  };
  let db: Database;
  let ctx: AgentContext;
  let verifiedEvents: CalendarEvent[];

  beforeEach(() => {
    db = createTestDb();
    const chatHistory = new ChatHistoryRepository(db);
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const spy = makeLocationVerificationSpy();
    verifiedEvents = spy.verifiedEvents;
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      isGroup: false,
      eventService: new EventService({ eventRepo: new EventRepository(db) }),
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory,
      conversationLogger: new ConversationLogger(chatHistory),
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
      locationVerification: spy.service,
    };
  });

  function createEvent(location?: string): number {
    return ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Meeting',
      start_at: '2099-03-15T13:00:00Z',
      timezone: 'UTC',
      location,
    }).id;
  }

  // Each case uses its own location: the executor throttles identical calls across tests.
  test.each<[string, object]>([
    ['Cafe Prague', { location_verified: true, ...MODEL_PLACE }],
    ['Cafe Vienna', { location_verified: 1, ...MODEL_PLACE }],
    ['Cafe Berlin', { location_verified: 'true', ...MODEL_PLACE }],
    ['Cafe Rome', { resolved_address: MODEL_PLACE.resolved_address }],
  ])('update_event to %s keeps the new place unconfirmed and asks the creator', async (location, claimed) => {
    const eventId = createEvent();
    const result = await executeTool(ctx, 'update_event', { event_id: eventId, location, ...claimed });

    expect(result.success).toBe(true);
    const stored = ctx.eventService.getEvent(eventId, USER_ID);
    expect(stored?.location).toBe(location);
    expect(resolvedPlace(stored)).toEqual(UNRESOLVED_PLACE);
    expect(result.output).not.toContain('verified place');
    expect(verifiedEvents.map((event) => [event.id, event.location, resolvedPlace(event)])).toEqual([
      [eventId, location, UNRESOLVED_PLACE],
    ]);
  });

  test('update_event without a new text cannot confirm the typed place', async () => {
    const eventId = createEvent('Cafe Lisbon');
    const result = await executeTool(ctx, 'update_event', { event_id: eventId, location_verified: 1, ...MODEL_PLACE });

    expect(result.success).toBe(true);
    expect(resolvedPlace(ctx.eventService.getEvent(eventId, USER_ID))).toEqual(UNRESOLVED_PLACE);
    expect(verifiedEvents).toEqual([]);
  });

  test('update_event cannot drop a place the creator confirmed', async () => {
    const eventId = createEvent('Cafe Madrid');
    const confirmed = { ...MODEL_PLACE, venue_name: 'Cafe Madrid', location_verified: 1 };
    new EventRepository(db).updateLocationFields(eventId, confirmed);
    const result = await executeTool(ctx, 'update_event', {
      event_id: eventId,
      title: 'Lunch',
      location_verified: 'false',
      resolved_address: null,
      venue_name: null,
    });

    expect(result.success).toBe(true);
    const stored = ctx.eventService.getEvent(eventId, USER_ID);
    expect(stored?.title).toBe('Lunch');
    expect(resolvedPlace(stored)).toEqual(confirmed);
    expect(verifiedEvents).toEqual([]);
  });

  test('update_event removing the location clears the place whatever the model claims', async () => {
    const eventId = createEvent('Cafe Porto');
    new EventRepository(db).updateLocationFields(eventId, { ...MODEL_PLACE, location_verified: 1 });
    const result = await executeTool(ctx, 'update_event', {
      event_id: eventId,
      location: null,
      location_verified: true,
      ...MODEL_PLACE,
    });

    expect(result.success).toBe(true);
    const stored = ctx.eventService.getEvent(eventId, USER_ID);
    expect(stored?.location).toBeNull();
    expect(resolvedPlace(stored)).toEqual(UNRESOLVED_PLACE);
    expect(verifiedEvents).toEqual([]);
  });

  test.each<[string, object]>([
    ['Cafe Oslo', { location_verified: true, ...MODEL_PLACE }],
    ['Cafe Bergen', { location_verified: 1, ...MODEL_PLACE }],
    ['Cafe Tromso', { location_verified: 'true', ...MODEL_PLACE }],
  ])('create_event at %s keeps the place unconfirmed and asks the creator', async (location, claimed) => {
    const result = await executeTool(ctx, 'create_event', {
      title: `Meeting ${location}`,
      start_at: '2099-03-16T13:00:00Z',
      location,
      ...claimed,
    });

    expect(result.success).toBe(true);
    const [created] = ctx.eventService.searchEvents(USER_ID, location);
    if (!created) throw new Error(`create_event at ${location} stored nothing`);
    expect(created.location).toBe(location);
    expect(resolvedPlace(created)).toEqual(UNRESOLVED_PLACE);
    expect(verifiedEvents.map((event) => [event.id, resolvedPlace(event)])).toEqual([[created.id, UNRESOLVED_PLACE]]);
  });
});

describe('boolean tool field boundary', () => {
  const USER_ID = 123;
  let ctx: AgentContext;
  let eventId: number;
  let verifiedEventIds: number[];

  beforeEach(() => {
    const db = createTestDb();
    const chatHistory = new ChatHistoryRepository(db);
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const eventService = new EventService({ eventRepo: new EventRepository(db) });
    const spy = makeLocationVerificationSpy();
    verifiedEventIds = spy.verifiedEventIds;
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory,
      conversationLogger: new ConversationLogger(chatHistory),
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
      locationVerification: spy.service,
    };
    eventId = eventService.createEvent({
      user_id: USER_ID,
      title: 'Meeting',
      start_at: '2099-03-15T13:00:00Z',
      end_at: '2099-03-15T14:00:00Z',
      timezone: 'UTC',
    }).id;
  });

  // Models sometimes serialize booleans as JSON strings; the exact literals must keep their meaning.
  // Each case uses its own location: the executor throttles identical calls across tests.
  test.each<[string | boolean, string, boolean]>([
    ['false', 'Cafe Central', true],
    ['true', 'At home', false],
    [false, 'Cafe Sacher', true],
    [true, 'At Ira', false],
  ])('update_event location_abstract %j updates the event with boolean semantics', async (flag, location, verified) => {
    const result = await executeTool(ctx, 'update_event', {
      event_id: eventId,
      location,
      location_abstract: flag,
    });
    expect(result.success).toBe(true);
    expect(ctx.eventService.getEvent(eventId, USER_ID)?.location).toBe(location);
    expect(verifiedEventIds.includes(eventId)).toBe(verified);
  });

  test.each([
    'yes',
    '1',
    'False',
    'TRUE',
    ' true',
    '',
    'no',
    '0',
  ])('update_event rejects location_abstract %j without touching the event', async (flag) => {
    const result = await executeTool(ctx, 'update_event', {
      event_id: eventId,
      location: 'Cafe Central',
      location_abstract: flag,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('location_abstract');
    expect(ctx.eventService.getEvent(eventId, USER_ID)?.location).toBeNull();
    expect(verifiedEventIds).toEqual([]);
  });

  test.each<[string | boolean, string, number]>([
    ['false', 'Cafe Mozart', 1],
    ['true', 'At Lena', 0],
    [false, 'Cafe Landtmann', 1],
    [true, 'At Alex', 0],
  ])('create_event location_abstract %j creates the event with boolean semantics', async (flag, location, verified) => {
    const result = await executeTool(ctx, 'create_event', {
      title: `Meeting ${location}`,
      start_at: '2099-03-16T13:00:00Z',
      location,
      location_abstract: flag,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain(`location: ${location}`);
    expect(verifiedEventIds).toHaveLength(verified);
  });

  test('every advertised boolean tool field accepts only the exact string literals', () => {
    const schemasByName = new Map<string, z.ZodType>(Object.entries(toolSchemas));
    const checked = new Set<string>();
    for (const tool of [...getToolDefinitions(), ...getToolDefinitions('live_call')]) {
      if (tool.type !== 'function') continue;
      const properties = tool.function.parameters?.properties;
      if (!properties || typeof properties !== 'object') continue;
      for (const [field, advertised] of Object.entries(properties)) {
        if (Reflect.get(advertised, 'type') !== 'boolean') continue;
        const schema = schemasByName.get(tool.function.name);
        if (!(schema instanceof z.ZodObject)) throw new Error(`${tool.function.name} has no object schema`);
        const fieldSchema = schema.shape[field];
        if (!fieldSchema) throw new Error(`${tool.function.name}.${field} is not validated`);
        const label = `${tool.function.name}.${field}`;
        expect([label, fieldSchema.safeParse('true').data]).toEqual([label, true]);
        expect([label, fieldSchema.safeParse('false').data]).toEqual([label, false]);
        expect([label, fieldSchema.safeParse(true).data]).toEqual([label, true]);
        expect([label, fieldSchema.safeParse(false).data]).toEqual([label, false]);
        for (const rejected of ['yes', '', '1', 'False', 1, null]) {
          expect([label, rejected, fieldSchema.safeParse(rejected).success]).toEqual([label, rejected, false]);
        }
        checked.add(label);
      }
    }
    expect([...checked]).toContain('create_event.location_abstract');
    expect([...checked]).toContain('update_event.location_abstract');
  });
});

test('advertised numeric ID schema stays numeric', () => {
  for (const tool of getToolDefinitions()) {
    if (tool.type !== 'function') continue;
    const properties = tool.function.parameters?.properties;
    if (!properties || typeof properties !== 'object') continue;
    for (const [field, schema] of Object.entries(properties)) {
      if (field.endsWith('_id')) expect(['number', 'integer']).toContain(Reflect.get(schema, 'type'));
    }
  }
});
