import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { ContactRepository } from '../../../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  getTimezoneSuggestions,
  handleAddContact,
  handleAskUser,
  handleCalculate,
  handleConvertToTimezone,
  handleFindContact,
  handleFindUser,
  handleGetBotInfo,
  handleGetContacts,
  handleGetHolidays,
  handleGetTimezoneInfo,
  handleMakeCall,
  handlePickUsers,
  handleRenderDayImage,
  handleUpdateContact,
  validateAndGetOffset,
} from '../../../../src/services/ai/tool-handlers/meta.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('meta tool handlers', () => {
  let ctx: AgentContext;
  let db: Database;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({
      telegram_id: USER_ID,
      timezone: 'Europe/Kyiv',
      language: 'en',
      username: 'testuser',
    });
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

  describe('handleGetHolidays', () => {
    test('returns message when no subscriptions', () => {
      const result = handleGetHolidays(ctx, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('No');
    });

    test('returns holidays list with English header for en user', () => {
      const mockCtx = {
        ...ctx,
        holidayService: {
          getUpcomingHolidays: () => [{ date: '2026-01-01', name: 'New Year', countryName: 'Russia' }],
          getHolidaysForDate: () => [],
        },
      } as unknown as typeof ctx;
      const result = handleGetHolidays(mockCtx, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('Upcoming holidays:');
      expect(result.output).toContain('2026-01-01');
      expect(result.output).toContain('New Year');
    });

    test('returns Russian holidays list for ru user', () => {
      const mockCtx = {
        ...ctx,
        user: { ...ctx.user, language: 'ru' as const },
        holidayService: {
          getUpcomingHolidays: () => [{ date: '2026-01-01', name: 'Новый год', countryName: 'Россия' }],
          getHolidaysForDate: () => [],
        },
      } as unknown as typeof ctx;
      const result = handleGetHolidays(mockCtx, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('Новый год');
      expect(result.output).toContain('Праздники:');
    });
  });

  describe('handleFindUser', () => {
    test('finds existing user by username', async () => {
      const result = await handleFindUser(ctx, { username: 'testuser' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('telegram_id=123');
    });

    test('finds user with @ prefix', async () => {
      const result = await handleFindUser(ctx, { username: '@testuser' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('telegram_id=123');
    });

    test('returns error for unknown username when no resolver', async () => {
      const result = await handleFindUser(ctx, { username: 'nobody' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('error message includes cleaned username', async () => {
      const result = await handleFindUser(ctx, { username: '@ghost_user' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ghost_user');
      expect(result.error).not.toContain('@@');
    });

    test('falls back to MTProto resolver when not in DB', async () => {
      const ctxWithResolver = {
        ...ctx,
        resolveUsername: async (u: string) =>
          u === 'ux_consul' ? { id: 999888, firstName: 'Alex', username: 'ux_consul' } : null,
      };
      const result = await handleFindUser(ctxWithResolver, { username: '@ux_consul' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('telegram_id=999888');
      expect(result.output).toContain('MTProto');
    });

    test('returns error when MTProto resolver also fails', async () => {
      const ctxWithResolver = {
        ...ctx,
        resolveUsername: async (_u: string) => null,
      };
      const result = await handleFindUser(ctxWithResolver, { username: 'ghost_user' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('handleGetContacts', () => {
    test('returns empty message when no contacts', () => {
      ctx.contactRepo = new ContactRepository(db);
      const result = handleGetContacts(ctx, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('empty');
    });

    test('lists contacts with usernames', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Лена', 'larichkina_b', 716928723);
      ctx.contactRepo = contactRepo;
      const result = handleGetContacts(ctx, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('Лена');
      expect(result.output).toContain('@larichkina_b');
    });

    test('returns error when contactRepo not configured', () => {
      ctx.contactRepo = undefined;
      const result = handleGetContacts(ctx, {});
      expect(result.success).toBe(false);
    });

    test('blocks in group context without force', () => {
      ctx.isGroup = true;
      ctx.groupChatId = -100;
      ctx.contactRepo = new ContactRepository(db);
      const result = handleGetContacts(ctx, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('force: true');
    });

    test('allows in group context with force: true', () => {
      ctx.isGroup = true;
      ctx.groupChatId = -100;
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Лена', 'larichkina_b', 716928723);
      ctx.contactRepo = contactRepo;
      const result = handleGetContacts(ctx, { force: true });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Лена');
    });
  });

  describe('handleFindContact', () => {
    test('finds contact by name', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Лена', 'larichkina_b');
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'Лена' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('larichkina_b');
    });

    test('finds contact by @username', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Mextner', 'mextner');
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: '@mextner' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Mextner');
      expect(result.output).toContain('@mextner');
    });

    test('finds contact by username without @', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Mextner', 'mextner');
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'mextner' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Mextner');
    });

    test('prefers name match over username fallback', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Alex', 'alexbot');
      contactRepo.add(USER_ID, 'mextner', 'other_user');
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'mextner' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('name: mextner');
    });

    test('returns error for unknown contact', () => {
      ctx.contactRepo = new ContactRepository(db);
      const result = handleFindContact(ctx, { name: 'Nobody' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Nobody');
    });
  });

  describe('handleAddContact', () => {
    test('adds new contact', () => {
      ctx.contactRepo = new ContactRepository(db);
      const result = handleAddContact(ctx, { name: 'Вова', username: 'vova123' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Вова');
      expect(result.output).toContain('@vova123');
    });

    test('upserts existing contact with username', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Вова');
      ctx.contactRepo = contactRepo;
      const result = handleAddContact(ctx, { name: 'Вова', username: 'vova123' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('vova123');
    });

    test('upserts existing contact without error', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Вова', 'vova');
      ctx.contactRepo = contactRepo;
      const result = handleAddContact(ctx, { name: 'Вова' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Вова');
    });
  });

  describe('handleUpdateContact', () => {
    test('updates preferred_name by current name', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Антон Tikididu', 'Tikididu');
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: 'Антон Tikididu', preferred_name: 'Антон' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Антон');
      const updated = contactRepo.findByName(USER_ID, 'Антон Tikididu');
      expect(updated?.preferred_name).toBe('Антон');
    });

    test('renames contact display name', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'OldName');
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: 'OldName', name: 'NewName' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('NewName');
      expect(contactRepo.findByName(USER_ID, 'NewName')).not.toBeNull();
    });

    test('finds contact by @username', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Вова', 'vova123');
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: '@vova123', preferred_name: 'Вовка' });
      expect(result.success).toBe(true);
      const updated = contactRepo.findByName(USER_ID, 'Вова');
      expect(updated?.preferred_name).toBe('Вовка');
    });

    test('returns error for unknown contact', () => {
      ctx.contactRepo = new ContactRepository(db);
      const result = handleUpdateContact(ctx, { search: 'Nobody', name: 'Someone' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Nobody');
    });

    test('returns error when no fields provided', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Лена');
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: 'Лена' });
      expect(result.success).toBe(false);
    });

    test('returns error when contactRepo not configured', () => {
      ctx.contactRepo = undefined;
      const result = handleUpdateContact(ctx, { search: 'Лена', name: 'Лена2' });
      expect(result.success).toBe(false);
    });
  });

  describe('handleAskUser', () => {
    test('returns stopLoop true', () => {
      const sendButtons = () => Promise.resolve({ message_id: 1 });
      ctx.sender = { sendMessage: sendButtons as never, editMessageText: (() => {}) as never, sendButtons };
      const result = handleAskUser(ctx, { question: 'Sure?', options: ['Да', 'Нет'] });
      expect(result.success).toBe(true);
      expect(result.stopLoop).toBe(true);
    });

    test('returns error when sender has no sendButtons', () => {
      ctx.sender = { sendMessage: (() => {}) as never, editMessageText: (() => {}) as never };
      const result = handleAskUser(ctx, { question: 'Sure?', options: ['Да', 'Нет'] });
      expect(result.success).toBe(false);
    });
  });

  describe('handlePickUsers', () => {
    test('returns stopLoop true', () => {
      const sendUserPicker = () => Promise.resolve({ message_id: 1 });
      ctx.sender = { sendMessage: (() => {}) as never, editMessageText: (() => {}) as never, sendUserPicker };
      const result = handlePickUsers(ctx, { event_id: 1, prompt: 'Pick users' });
      expect(result.success).toBe(true);
      expect(result.stopLoop).toBe(true);
    });

    test('returns error when sender has no sendUserPicker', () => {
      ctx.sender = { sendMessage: (() => {}) as never, editMessageText: (() => {}) as never };
      const result = handlePickUsers(ctx, { event_id: 1, prompt: 'Pick users' });
      expect(result.success).toBe(false);
    });
  });

  describe('handleGetBotInfo', () => {
    test('returns capabilities text', () => {
      const result = handleGetBotInfo();
      expect(result.success).toBe(true);
      expect(result.output).toContain('voice');
      expect(result.output).toContain('group');
      expect(result.output).toContain('@mxtnr');
      expect(result.output).toContain('feedback');
    });
  });

  describe('handleRenderDayImage', () => {
    const GROUP_CHAT_ID = -100999;
    let renderCalls: Record<string, unknown>[];
    let photoCalls: { chatId: number }[];

    beforeEach(() => {
      renderCalls = [];
      photoCalls = [];
      ctx.renderService = {
        renderDirect(opts: Record<string, unknown>) {
          renderCalls.push(opts);
          return Promise.resolve(Buffer.from('png'));
        },
      };
      ctx.sender = {
        sendMessage: (() => Promise.resolve({ message_id: 1 })) as never,
        editMessageText: (() => Promise.resolve()) as never,
        sendPhoto(chatId: number) {
          photoCalls.push({ chatId });
          return Promise.resolve({ message_id: 1 });
        },
      };
    });

    test('returns error when renderService not available', () => {
      ctx.renderService = undefined;
      const result = handleRenderDayImage(ctx, { date: '2026-03-15' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('fetches personal events by default when isGroup=false', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Event',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      const result = handleRenderDayImage(ctx, { date: '2026-03-15' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('2026-03-15');
    });

    test('fetches group events when scope=group', () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Only',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Event',
        start_at: '2026-03-15T14:00:00Z',
        end_at: '2026-03-15T15:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: USER_ID,
      });
      const gCtx: AgentContext = {
        ...ctx,
        isGroup: true,
        groupChatId: GROUP_CHAT_ID,
        chatId: GROUP_CHAT_ID,
      };
      const result = handleRenderDayImage(gCtx, { date: '2026-03-15', scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('2026-03-15');
    });

    test('scope defaults to group when isGroup=true', () => {
      const gCtx: AgentContext = {
        ...ctx,
        isGroup: true,
        groupChatId: GROUP_CHAT_ID,
        chatId: GROUP_CHAT_ID,
      };
      const result = handleRenderDayImage(gCtx, { date: '2026-03-15' });
      expect(result.success).toBe(true);
      // Just verifying it doesn't crash — scope resolved to group
    });
  });
});

describe('handleCalculate', () => {
  test('adds two integers', () => {
    const r = handleCalculate({ expression: '2 + 31' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('33');
  });

  test('complex arithmetic expression', () => {
    const r = handleCalculate({ expression: '22 * 60 + 34' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1354');
  });

  test('adds minutes to HH:MM', () => {
    const r = handleCalculate({ expression: '22:34 + 31min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('23:05');
  });

  test('HH:MM wraps around midnight', () => {
    const r = handleCalculate({ expression: '23:50 + 30min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('00:20');
  });

  test('subtracts minutes from HH:MM', () => {
    const r = handleCalculate({ expression: '22:34 - 10min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('22:24');
  });

  test('adds hours to HH:MM', () => {
    const r = handleCalculate({ expression: '09:00 + 2h' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('11:00');
  });

  test('adds minutes to ISO datetime', () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 31min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-18T23:05:00.000Z');
  });

  test('ISO datetime crosses midnight', () => {
    const r = handleCalculate({ expression: '2026-03-18T23:50:00Z + 20min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-19T00:10:00.000Z');
  });

  test('adds hours to ISO datetime', () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 2hours' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-19T00:34:00.000Z');
  });

  test('subtracts from ISO datetime', () => {
    const r = handleCalculate({ expression: '2026-03-19T00:05:00Z - 1hour' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-18T23:05:00.000Z');
  });

  test('adds days to ISO date', () => {
    const r = handleCalculate({ expression: '2026-03-18 + 7days' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-25');
  });

  test('returns error for unparseable expression', () => {
    const r = handleCalculate({ expression: 'hello world' });
    expect(r.success).toBe(false);
    expect(r.error).toBeDefined();
  });

  test('adds weeks to ISO datetime', () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 2weeks' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-04-01T22:34:00.000Z');
  });

  test('adds 1 month to ISO datetime (end-of-month clamp)', () => {
    const r = handleCalculate({ expression: '2026-01-31T12:00:00Z + 1month' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-02-28T12:00:00.000Z');
  });

  test('subtracts 1 month from ISO datetime', () => {
    const r = handleCalculate({ expression: '2026-03-31T12:00:00Z - 1month' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-02-28T12:00:00.000Z');
  });

  test('adds 1 year to ISO datetime', () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 1year' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2027-03-18T22:34:00.000Z');
  });

  test('adds weeks to date-only', () => {
    const r = handleCalculate({ expression: '2026-03-18 + 2weeks' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-04-01');
  });

  test('adds months to date-only', () => {
    const r = handleCalculate({ expression: '2026-03-18 + 1month' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-04-18');
  });

  test('adds years to date-only', () => {
    const r = handleCalculate({ expression: '2026-03-18 + 1year' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2027-03-18');
  });

  test('datetime diff less than 60 min', () => {
    const r = handleCalculate({ expression: '2026-03-21T17:31:07Z - 2026-03-21T17:00:07Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('31 min');
  });

  test('datetime diff exact hours', () => {
    const r = handleCalculate({ expression: '2026-03-21T18:00:00Z - 2026-03-21T17:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1h');
  });

  test('datetime diff hours and minutes', () => {
    const r = handleCalculate({ expression: '2026-03-21T19:30:00Z - 2026-03-21T17:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2h 30min');
  });

  test('datetime diff in days', () => {
    const r = handleCalculate({ expression: '2026-03-25T12:00:00Z - 2026-03-21T12:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('4 days');
  });

  test('datetime diff 1 day (singular)', () => {
    const r = handleCalculate({ expression: '2026-03-22T12:00:00Z - 2026-03-21T12:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1 day');
  });

  test('datetime diff days and hours', () => {
    const r = handleCalculate({ expression: '2026-03-22T18:00:00Z - 2026-03-21T12:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1 day 6h');
  });

  test('date-only diff', () => {
    const r = handleCalculate({ expression: '2026-04-10 - 2026-03-21' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('20 days');
  });
});

describe('handleMakeCall', () => {
  test('blocks make_call during live_call', () => {
    const liveCtx = { user: { telegram_id: 1, language: 'en' }, inputMode: 'live_call' } as unknown as AgentContext;
    const result = handleMakeCall(liveCtx, { text: 'reminder' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('live call');
  });

  test('returns error when callQueue not available', () => {
    const noQueueCtx = { user: { telegram_id: 1, language: 'en' }, inputMode: undefined } as unknown as AgentContext;
    const result = handleMakeCall(noQueueCtx, { text: 'reminder' });
    expect(result.success).toBe(false);
  });
});

describe('validateAndGetOffset', () => {
  test('returns offset for valid timezone', () => {
    const dt = new Date('2026-01-15T12:00:00Z'); // January — unambiguously winter (UTC+2)
    const result = validateAndGetOffset('Europe/Kyiv', dt);
    expect(result.offsetStr).toBe('+02:00');
    expect(result.offsetMinutes).toBe(120);
  });

  test('returns offset for UTC', () => {
    const dt = new Date('2026-03-20T12:00:00Z');
    const result = validateAndGetOffset('UTC', dt);
    expect(result.offsetStr).toBe('+00:00');
    expect(result.offsetMinutes).toBe(0);
  });

  test('throws RangeError for invalid timezone', () => {
    const dt = new Date('2026-03-20T12:00:00Z');
    expect(() => {
      validateAndGetOffset('Garbage/Fake', dt);
    }).toThrow(RangeError);
  });

  test('throws RangeError for invalid timezone with specific message', () => {
    const dt = new Date('2026-03-20T12:00:00Z');
    expect(() => {
      validateAndGetOffset('Invalid/Timezone', dt);
    }).toThrow(/invalid time zone/i);
  });
});

describe('getTimezoneSuggestions', () => {
  test('returns up to 30 suggestions for valid region prefix', () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(30);
    expect(suggestions.every((s: string) => s.startsWith('America/'))).toBe(true);
  });

  test('returns globally sorted suggestions when no slash', () => {
    const suggestions = getTimezoneSuggestions('Moscow');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(30);
  });

  test('deduplicates by timezone', () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    const tzNames = suggestions.map((s: string) => s.split(' ')[0]);
    const unique = new Set(tzNames);
    expect(unique.size).toBe(tzNames.length);
  });

  test('format includes timezone and city name', () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    expect(suggestions[0]).toMatch(/^[\w/]+ \(.+\)$/);
  });
});

describe('handleGetTimezoneInfo', () => {
  // --- single timezone ---
  test('returns correct info for valid IANA timezone', () => {
    const result = handleGetTimezoneInfo({ timezone: 'Europe/London' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezone).toBe('Europe/London');
    expect(data.utc_offset).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(typeof data.dst_active).toBe('boolean');
    expect(data.local_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('accepts at parameter and returns offset at that time', () => {
    // New York in January is UTC-5 (EST, no DST)
    const result = handleGetTimezoneInfo({ timezone: 'America/New_York', at: '2026-01-15T12:00:00Z' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.utc_offset).toBe('-05:00');
    expect(data.dst_active).toBe(false);
  });

  test('detects DST active in summer', () => {
    // New York in July is UTC-4 (EDT, DST active)
    const result = handleGetTimezoneInfo({ timezone: 'America/New_York', at: '2026-07-15T12:00:00Z' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.utc_offset).toBe('-04:00');
    expect(data.dst_active).toBe(true);
  });

  test('returns error and suggestions for invalid timezone', () => {
    const result = handleGetTimezoneInfo({ timezone: 'America/Blah' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid timezone');
    expect(result.error).toContain('America/');
  });

  test('returns format error when no slash', () => {
    const result = handleGetTimezoneInfo({ timezone: 'Moscow' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('IANA');
  });

  test('returns error for invalid at datetime', () => {
    const result = handleGetTimezoneInfo({ timezone: 'Europe/London', at: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  // --- array of timezones ---
  test('compares two timezones and shows which is ahead', () => {
    const result = handleGetTimezoneInfo({
      timezone: ['Europe/Moscow', 'America/New_York'],
      at: '2026-01-15T12:00:00Z', // winter: Moscow +03:00, NY -05:00
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezones).toHaveLength(2);
    expect(data.difference_minutes).toBe(480);
    expect(data.difference_hours).toBe(8);
    expect(data.ahead).toContain('Europe/Moscow');
    expect(data.ahead).toContain('ahead');
  });

  test('array: ranks N timezones west to east, no difference fields', () => {
    const result = handleGetTimezoneInfo({
      timezone: ['Asia/Tokyo', 'America/New_York', 'Europe/London'],
      at: '2026-01-15T12:00:00Z',
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezones).toHaveLength(3);
    // ranked west→east: NY (-05:00), London (+00:00), Tokyo (+09:00)
    expect(data.ahead).toContain('Asia/Tokyo');
    expect(data.timezones[0].timezone).toBe('America/New_York');
    expect(data.timezones[2].timezone).toBe('Asia/Tokyo');
    // no difference fields for N>2
    expect(data.difference_minutes).toBeUndefined();
    expect(data.difference_hours).toBeUndefined();
  });

  test('array: returns error if any timezone is invalid', () => {
    const result = handleGetTimezoneInfo({ timezone: ['Europe/Moscow', 'America/Blah'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('America/Blah');
  });
});

describe('handleConvertToTimezone', () => {
  test('converts UTC datetime to local time in target timezone', () => {
    const result = handleConvertToTimezone({ datetime: '2026-07-15T14:00:00Z', timezone: 'America/New_York' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezone).toBe('America/New_York');
    expect(data.local_datetime).toBe('2026-07-15T10:00:00-04:00'); // EDT = UTC-4
    expect(data.utc_offset).toBe('-04:00');
  });

  test('converts datetime with offset to another timezone', () => {
    const result = handleConvertToTimezone({ datetime: '2026-01-15T10:00:00+01:00', timezone: 'Asia/Tokyo' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.local_datetime).toBe('2026-01-15T18:00:00+09:00');
  });

  test('returns error for invalid timezone', () => {
    const result = handleConvertToTimezone({ datetime: '2026-01-15T10:00:00Z', timezone: 'Europe/Blah' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid timezone');
  });

  test('returns error for invalid datetime', () => {
    const result = handleConvertToTimezone({ datetime: 'not-a-date', timezone: 'Europe/London' });
    expect(result.success).toBe(false);
  });
});
