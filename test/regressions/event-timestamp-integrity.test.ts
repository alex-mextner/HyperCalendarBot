import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { GroupChatRepository } from '../../src/database/repositories/group-chat.repository.ts';
import { HolidayRepository } from '../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { _resetToolThrottleForTest, executeTool } from '../../src/services/ai/tool-executor.ts';
import { handleCreateEvent, handleUpdateEvent } from '../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import { ConversationLogger } from '../../src/services/conversation-logger.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { HolidayService } from '../../src/services/holiday/holiday-service.ts';

const BAD_DATE = '22:59 local Europe/Belgrade to UTC';
const VALID_DATE = '2035-01-01T12:00:00Z';

describe('event timestamp integrity before writes', () => {
  let db: Database;
  let repo: EventRepository;
  let ctx: AgentContext;

  beforeEach(() => {
    _resetToolThrottleForTest();
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    const user = userRepo.create({ telegram_id: 1001, timezone: 'UTC', language: 'en' });
    repo = new EventRepository(db);
    const history = new ChatHistoryRepository(db);
    ctx = {
      user,
      userRepo,
      chatId: 1001,
      isGroup: false,
      messageText: 'Synthetic timestamp fixture',
      eventService: new EventService({ eventRepo: repo }),
      eventReminderRepo: new EventReminderRepository(db),
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: history,
      conversationLogger: new ConversationLogger(history),
    };
  });
  afterEach(() => db.close());

  const count = () => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get()?.n;
  const validEvent = () =>
    repo.create({ user_id: 1001, title: 'Synthetic fixture', start_at: VALID_DATE, timezone: 'UTC' });

  test.each([
    BAD_DATE,
    '2035-02-30T12:00:00Z',
    '2035-01-01T12:00:00',
    'tomorrow',
    '',
  ])('tool rejects %s without leaving a row', async (start_at) => {
    const result = await executeTool(ctx, 'create_event', { title: 'Synthetic fixture', start_at });
    expect(result.success).toBe(false);
    expect(result.mutationState).toBe('not_applied');
    expect(count()).toBe(0);
  });

  test.each([false, true])('direct handler does not insert invalid date even with force=%s', async (force) => {
    const result = await handleCreateEvent(ctx, { title: 'Synthetic fixture', start_at: BAD_DATE, force });
    expect(count()).toBe(0);
    expect(result.success).toBe(false);
    expect(result.mutationState).toBe('not_applied');
    expect(result.error).toContain('INVALID_EVENT_DATETIME');
  });

  test('repository barrier rejects malformed create before SQL INSERT', () => {
    expect(() =>
      repo.create({ user_id: 1001, title: 'Synthetic fixture', start_at: BAD_DATE, timezone: 'UTC' }),
    ).toThrow('INVALID_EVENT_DATETIME');
    expect(count()).toBe(0);
  });

  test('invalid end timestamp cannot leave a created row', async () => {
    const result = await handleCreateEvent(ctx, { title: 'Synthetic fixture', start_at: VALID_DATE, end_at: BAD_DATE });
    expect(result.success).toBe(false);
    expect(result.mutationState).toBe('not_applied');
    expect(count()).toBe(0);
  });

  test('direct update handler leaves the original row untouched', async () => {
    const event = validEvent();
    const result = await handleUpdateEvent(ctx, {
      event_id: event.id,
      start_at: BAD_DATE,
      title: 'Must not be written',
    });
    expect(result.success).toBe(false);
    expect(result.mutationState).toBe('not_applied');
    expect(repo.findById(event.id, 1001)).toEqual(event);
  });

  test('repository update rejects invalid end timestamp before any changed field is stored', () => {
    const event = validEvent();
    expect(() => repo.update(event.id, 1001, { title: 'Must not be written', end_at: BAD_DATE })).toThrow(
      'INVALID_EVENT_DATETIME',
    );
    expect(repo.findById(event.id, 1001)).toEqual(event);
  });

  test.each([
    '2036-02-29T12:00:00Z',
    '2035-01-01T12:00:00+02:00',
    '2035-01-01',
  ])('valid existing format %s remains supported', (start_at) => {
    const event = repo.create({
      user_id: 1001,
      title: 'Synthetic fixture',
      start_at,
      all_day: start_at.length === 10,
      timezone: 'UTC',
    });
    expect(event.start_at).toBe(start_at);
    expect(count()).toBe(1);
  });

  test('nullable end-at deletion is still allowed', () => {
    const event = repo.create({
      user_id: 1001,
      title: 'Synthetic fixture',
      start_at: VALID_DATE,
      end_at: '2035-01-01T13:00:00Z',
      timezone: 'UTC',
    });
    expect(repo.update(event.id, 1001, { end_at: null })?.end_at).toBeNull();
  });
  test('full update executor rejects malformed dates as not-applied', async () => {
    const event = validEvent();
    const result = await executeTool(ctx, 'update_event', {
      event_id: event.id,
      start_at: BAD_DATE,
      title: 'Must not be written',
    });
    expect(result.success).toBe(false);
    expect(result.mutationState).toBe('not_applied');
    expect(repo.findById(event.id, 1001)).toEqual(event);
  });

  test('group repository and direct handler reject invalid updates without changing any field', async () => {
    new GroupChatRepository(db).upsertGroup({ chat_id: -1001, title: 'Synthetic group', added_by: 1001 });
    const event = repo.create({
      user_id: 1001,
      title: 'Group fixture',
      start_at: VALID_DATE,
      timezone: 'UTC',
      owner_type: 'group',
      group_id: -1001,
      created_by: 1001,
    });
    expect(() => repo.updateInGroup(event.id, -1001, { start_at: BAD_DATE, title: 'Must not be written' })).toThrow(
      'INVALID_EVENT_DATETIME',
    );
    ctx.isGroup = true;
    ctx.groupChatId = -1001;
    const result = await handleUpdateEvent(ctx, {
      event_id: event.id,
      scope: 'group',
      start_at: BAD_DATE,
      title: 'Must not be written',
    });
    expect(result.success).toBe(false);
    expect(result.mutationState).toBe('not_applied');
    expect(repo.findByIdInGroup(event.id, -1001)).toEqual(event);
  });
});
