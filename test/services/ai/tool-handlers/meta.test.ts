import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { ContactRepository } from '../../../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleCalculate } from '../../../../src/services/ai/tool-handlers/calculate.ts';
import {
  handleAddContact,
  handleFindContact,
  handleGetContacts,
  handleUpdateContact,
} from '../../../../src/services/ai/tool-handlers/contacts.ts';
import {
  handleAskUser,
  handleFindUser,
  handleGetBotInfo,
  handleGetHolidays,
  handleMakeCall,
  handlePickUsers,
} from '../../../../src/services/ai/tool-handlers/meta.ts';
import { handleRenderDayImage } from '../../../../src/services/ai/tool-handlers/render.ts';
import {
  getTimezoneSuggestions,
  handleConvertToTimezone,
  handleGetTimezoneInfo,
  validateAndGetOffset,
} from '../../../../src/services/ai/tool-handlers/timezone.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import type { ImageRenderJob } from '../../../../src/worker/image-render.queue.ts';
import { png } from '../../../fixtures/png.ts';

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
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({
      telegram_id: USER_ID,
      timezone: 'Europe/Kyiv',
      language: 'en',
      username: 'testuser',
    });
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

  describe('handleGetHolidays', () => {
    test('returns message when no subscriptions', async () => {
      const result = handleGetHolidays(ctx, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('No');
    });

    test('returns holidays list with English header for en user', async () => {
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

    test('returns Russian holidays list for ru user', async () => {
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

    test('returns resolve-unavailable error for unknown username when no MTProto resolver configured', async () => {
      ctx.messageText = 'Find @nobody';
      const result = await handleFindUser(ctx, { username: 'nobody' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('unavailable');
      expect(result.error).not.toContain('not found');
    });

    test('falls back to MTProto resolver when not in DB', async () => {
      const ctxWithResolver = {
        ...ctx,
        resolveUsername: async (u: string) =>
          u === 'ux_consul' ? { id: 999888, firstName: 'Alex', username: 'ux_consul' } : null,
      };
      ctxWithResolver.messageText = 'Find @ux_consul';
      const result = await handleFindUser(ctxWithResolver, { username: '@ux_consul' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('telegram_id=999888');
      expect(result.output).toContain('MTProto');
    });

    test('returns error when MTProto resolver also fails, with cleaned username', async () => {
      const ctxWithResolver = {
        ...ctx,
        resolveUsername: async (_u: string) => null,
      };
      ctxWithResolver.messageText = 'Find @ghost_user';
      const result = await handleFindUser(ctxWithResolver, { username: '@ghost_user' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(result.error).toContain('ghost_user');
      expect(result.error).not.toContain('@@');
    });
  });

  describe('handleGetContacts', () => {
    test('returns empty message when no contacts', async () => {
      ctx.contactRepo = new ContactRepository(db);
      const result = handleGetContacts(ctx, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('empty');
    });

    test('lists contacts with usernames', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Лена', 'larichkina_b', 716928723);
      ctx.contactRepo = contactRepo;
      const result = handleGetContacts(ctx, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('Лена');
      expect(result.output).toContain('@larichkina_b');
    });

    test('returns error when contactRepo not configured', async () => {
      ctx.contactRepo = undefined;
      const result = handleGetContacts(ctx, {});
      expect(result.success).toBe(false);
    });

    test('blocks in group context without force', async () => {
      ctx.isGroup = true;
      ctx.groupChatId = -100;
      ctx.contactRepo = new ContactRepository(db);
      const result = handleGetContacts(ctx, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('force: true');
    });

    test('allows in group context with force: true', async () => {
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
    test('finds contact by name', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Лена', 'larichkina_b');
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'Лена' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('larichkina_b');
    });

    test('finds contact by @username', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Mextner', 'mextner');
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: '@mextner' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Mextner');
      expect(result.output).toContain('@mextner');
    });

    test('finds contact by username without @', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Mextner', 'mextner');
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'mextner' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Mextner');
    });

    test('prefers name match over username fallback', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Alex', 'alexbot');
      contactRepo.add(USER_ID, 'mextner', 'other_user');
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'mextner' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('name: mextner');
    });

    test('returns error for unknown contact', async () => {
      ctx.contactRepo = new ContactRepository(db);
      const result = handleFindContact(ctx, { name: 'Nobody' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Nobody');
    });

    test('returns multiple matches with confidence scores when several contacts match', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Лена', 'lena_exact', 111);
      contactRepo.add(USER_ID, 'Елена', 'elena_full', 222);
      contactRepo.add(USER_ID, 'Олена', 'olena', 333);
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'Лена' });
      expect(result.success).toBe(true);
      if (!result.data || Array.isArray(result.data) || !('matches' in result.data)) {
        throw new Error('expected matches in result.data');
      }
      const matches = result.data.matches;
      expect(matches.length).toBe(3);
      expect(matches[0]!.name).toBe('Лена');
      expect(matches[0]!.confidence).toBe(1);
      // Both "Елена" and "Олена" are one insertion away from "Лена" → tie at 0.8
      expect(matches[1]!.confidence).toBeCloseTo(0.8, 5);
      expect(matches[2]!.confidence).toBeCloseTo(0.8, 5);
      expect(result.output).toContain('Лена');
      expect(result.output).toContain('(exact)');
      expect(result.output).toContain('80%');
    });

    test('single exact match labels confidence as "exact"', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Лена', 'larichkina_b', 716928723);
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'Лена' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Contact found:');
      expect(result.output).toContain('name: Лена');
      expect(result.output).toContain('telegram_id: 716928723');
      expect(result.output).toContain('(exact)');
      expect(result.output).not.toContain('100%');
      if (!result.data || Array.isArray(result.data) || !('matches' in result.data)) {
        throw new Error('expected matches in result.data');
      }
      expect(result.data.matches.length).toBe(1);
      expect(result.data.matches[0]!.confidence).toBe(1);
    });

    test('caps results at 5 matches', async () => {
      const contactRepo = new ContactRepository(db);
      for (let i = 0; i < 10; i++) {
        contactRepo.add(USER_ID, `Лена${i}`, undefined, i + 1);
      }
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'Лена' });
      expect(result.success).toBe(true);
      if (!result.data || Array.isArray(result.data) || !('matches' in result.data)) {
        throw new Error('expected matches in result.data');
      }
      expect(result.data.matches.length).toBe(5);
    });

    test('single fuzzy match shows confidence percentage in output', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Елена', 'elena_user', 999);
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'Лена' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Contact found:');
      expect(result.output).toContain('name: Елена');
      expect(result.output).toContain('(80%)');
    });

    test('single fuzzy match does not show "exact" label', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Елена', 'elena_user', 999);
      ctx.contactRepo = contactRepo;
      const result = handleFindContact(ctx, { name: 'Лена' });
      expect(result.success).toBe(true);
      expect(result.output).not.toContain('exact');
      expect(result.output).toContain('80%');
    });
  });

  describe('handleAddContact', () => {
    test('adds new contact', async () => {
      ctx.contactRepo = new ContactRepository(db);
      ctx.messageText = 'Save Вова @vova123';
      const result = handleAddContact(ctx, { name: 'Вова', username: 'vova123' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Вова');
      expect(result.output).toContain('@vova123');
    });

    test('upserts existing contact with username', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Вова');
      ctx.contactRepo = contactRepo;
      ctx.messageText = 'Save Вова @vova123';
      const result = handleAddContact(ctx, { name: 'Вова', username: 'vova123' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('vova123');
    });

    test('upserts existing contact without error', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Вова', 'vova');
      ctx.contactRepo = contactRepo;
      const result = handleAddContact(ctx, { name: 'Вова' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Вова');
    });
  });

  describe('handleUpdateContact', () => {
    test('updates preferred_name by current name', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Антон Tikididu', 'Tikididu');
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: 'Антон Tikididu', preferred_name: 'Антон' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Антон');
      const updated = contactRepo.findByName(USER_ID, 'Антон Tikididu');
      expect(updated?.preferred_name).toBe('Антон');
    });

    test('renames contact display name', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'OldName');
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: 'OldName', name: 'NewName' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('NewName');
      expect(contactRepo.findByName(USER_ID, 'NewName')).not.toBeNull();
    });

    test('finds contact by @username', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Вова', 'vova123');
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: '@vova123', preferred_name: 'Вовка' });
      expect(result.success).toBe(true);
      const updated = contactRepo.findByName(USER_ID, 'Вова');
      expect(updated?.preferred_name).toBe('Вовка');
    });

    test('returns error for unknown contact', async () => {
      ctx.contactRepo = new ContactRepository(db);
      const result = handleUpdateContact(ctx, { search: 'Nobody', name: 'Someone' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Nobody');
    });

    test('returns error when no fields provided', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Лена');
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: 'Лена' });
      expect(result.success).toBe(false);
    });

    test('returns error when contactRepo not configured', async () => {
      ctx.contactRepo = undefined;
      const result = handleUpdateContact(ctx, { search: 'Лена', name: 'Лена2' });
      expect(result.success).toBe(false);
    });

    test('refuses to update when search is ambiguous (multiple fuzzy matches)', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Елена', 'elena_user', 111);
      contactRepo.add(USER_ID, 'Олена', 'olena_user', 222);
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: 'Лена', preferred_name: 'Ленок' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Multiple');
      expect(result.error).toContain('Елена');
      expect(result.error).toContain('Олена');
      // Nothing was actually updated
      expect(contactRepo.findByName(USER_ID, 'Елена')?.preferred_name).toBeNull();
      expect(contactRepo.findByName(USER_ID, 'Олена')?.preferred_name).toBeNull();
    });

    test('refuses to update when two contacts phonetically tie (not strict-equal to either)', async () => {
      const contactRepo = new ContactRepository(db);
      // Query "Вофа" phonetically equals both ("фофа") but is strict-equal to neither.
      // Both score 0.99; the tie triggers disambiguation.
      contactRepo.add(USER_ID, 'Вова', 'vova1', 111);
      contactRepo.add(USER_ID, 'Фофа', 'fofa', 222);
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: 'Вофа', preferred_name: 'Вовка' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Multiple');
    });

    test('allows single fuzzy match without ambiguity', async () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Елена', 'elena_user', 111);
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: 'Лена', preferred_name: 'Ленок' });
      expect(result.success).toBe(true);
      expect(contactRepo.findByName(USER_ID, 'Елена')?.preferred_name).toBe('Ленок');
    });

    test('exact match wins over fuzzy alternatives', async () => {
      const contactRepo = new ContactRepository(db);
      // "Лена" exact match alongside a fuzzy "Елена" — should pick the exact one.
      contactRepo.add(USER_ID, 'Лена', 'lena_exact', 111);
      contactRepo.add(USER_ID, 'Елена', 'elena_full', 222);
      ctx.contactRepo = contactRepo;
      const result = handleUpdateContact(ctx, { search: 'Лена', preferred_name: 'Ленусик' });
      expect(result.success).toBe(true);
      expect(contactRepo.findByName(USER_ID, 'Лена')?.preferred_name).toBe('Ленусик');
      expect(contactRepo.findByName(USER_ID, 'Елена')?.preferred_name).toBeNull();
    });
  });

  describe('handleAskUser', () => {
    test('returns stopLoop true', async () => {
      const sendButtons = () => Promise.resolve({ message_id: 1 });
      ctx.sender = { sendMessage: sendButtons as never, editMessageText: (() => {}) as never, sendButtons };
      const result = await handleAskUser(ctx, { question: 'Sure?', options: ['Да', 'Нет'] });
      expect(result.success).toBe(true);
      expect(result.stopLoop).toBe(true);
    });

    test('returns error when sender has no sendButtons', async () => {
      ctx.sender = { sendMessage: (() => {}) as never, editMessageText: (() => {}) as never };
      const result = await handleAskUser(ctx, { question: 'Sure?', options: ['Да', 'Нет'] });
      expect(result.success).toBe(false);
    });
  });

  describe('handlePickUsers', () => {
    test('returns stopLoop true', async () => {
      const sendUserPicker = () => Promise.resolve({ message_id: 1 });
      ctx.sender = { sendMessage: (() => {}) as never, editMessageText: (() => {}) as never, sendUserPicker };
      const result = await handlePickUsers(ctx, { event_id: 1, prompt: 'Pick users' });
      expect(result.success).toBe(true);
      expect(result.stopLoop).toBe(true);
    });

    test('returns error when sender has no sendUserPicker', async () => {
      ctx.sender = { sendMessage: (() => {}) as never, editMessageText: (() => {}) as never };
      const result = await handlePickUsers(ctx, { event_id: 1, prompt: 'Pick users' });
      expect(result.success).toBe(false);
    });
  });

  describe('handleGetBotInfo', () => {
    test('returns capabilities text', async () => {
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
    let renderCalls: ImageRenderJob[];
    let photoCalls: { chatId: number }[];

    beforeEach(() => {
      renderCalls = [];
      photoCalls = [];
      ctx.renderService = {
        renderDirect(job) {
          renderCalls.push(job as unknown as ImageRenderJob);
          return Promise.resolve(png());
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

    test('returns error when renderService not available', async () => {
      ctx.renderService = undefined;
      const result = await handleRenderDayImage(ctx, { date: '2026-03-15' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    test('fetches personal events by default when isGroup=false', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Event',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      const result = await handleRenderDayImage(ctx, { date: '2026-03-15' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('2026-03-15');
    });

    test('fetches group events when scope=group', async () => {
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
      const result = await handleRenderDayImage(gCtx, { date: '2026-03-15', scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('2026-03-15');
    });

    test('scope defaults to group when isGroup=true', async () => {
      const gCtx: AgentContext = {
        ...ctx,
        isGroup: true,
        groupChatId: GROUP_CHAT_ID,
        chatId: GROUP_CHAT_ID,
      };
      const result = await handleRenderDayImage(gCtx, { date: '2026-03-15' });
      expect(result.success).toBe(true);
      // Just verifying it doesn't crash — scope resolved to group
    });
  });
});

describe('handleCalculate', () => {
  test('adds two integers', async () => {
    const r = handleCalculate({ expression: '2 + 31' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('33');
  });

  test('complex arithmetic expression', async () => {
    const r = handleCalculate({ expression: '22 * 60 + 34' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1354');
  });

  test('adds minutes to HH:MM', async () => {
    const r = handleCalculate({ expression: '22:34 + 31min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('23:05');
  });

  test('HH:MM wraps around midnight', async () => {
    const r = handleCalculate({ expression: '23:50 + 30min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('00:20');
  });

  test('subtracts minutes from HH:MM', async () => {
    const r = handleCalculate({ expression: '22:34 - 10min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('22:24');
  });

  test('adds hours to HH:MM', async () => {
    const r = handleCalculate({ expression: '09:00 + 2h' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('11:00');
  });

  test('adds minutes to ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 31min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-18T23:05:00.000Z');
  });

  test('ISO datetime crosses midnight', async () => {
    const r = handleCalculate({ expression: '2026-03-18T23:50:00Z + 20min' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-19T00:10:00.000Z');
  });

  test('adds hours to ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 2hours' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-19T00:34:00.000Z');
  });

  test('subtracts from ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-19T00:05:00Z - 1hour' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-18T23:05:00.000Z');
  });

  test('requires an explicit timezone for datetime arithmetic', () => {
    const r = handleCalculate({ expression: '2026-09-16T17:40 - 2hours' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('explicit Z/offset');
    expect(r.error).toContain('2026-09-17T10:49:00+02:00 + 2hours');
  });

  test('converts dated local IANA time to UTC with the event-date DST offset', () => {
    expect(handleCalculate({ expression: '2026-07-15 12:30 Europe/Belgrade to UTC' })).toMatchObject({
      success: true,
      output: '2026-07-15T10:30:00.000Z',
    });
    expect(handleCalculate({ expression: '2026-01-15 12:30 Europe/Belgrade to UTC' })).toMatchObject({
      success: true,
      output: '2026-01-15T11:30:00.000Z',
    });
  });

  test('accepts explicit UTC offsets including the historical prompt form', () => {
    expect(handleCalculate({ expression: '2026-09-23 12:30 UTC+2 to UTC' })).toMatchObject({
      success: true,
      output: '2026-09-23T10:30:00.000Z',
    });
    expect(handleCalculate({ expression: '12:30 UTC+2 to UTC' })).toMatchObject({ success: true, output: '10:30' });
    expect(handleCalculate({ expression: '12:30 UTC-5 to UTC' })).toMatchObject({ success: true, output: '17:30' });
  });

  test('rejects DST gaps and folds instead of silently picking a different instant', () => {
    const gap = handleCalculate({ expression: '2026-03-29 02:30 Europe/Belgrade to UTC' });
    expect(gap.success).toBe(false);
    expect(gap.error).toContain('does not exist');

    const fold = handleCalculate({ expression: '2026-10-25 02:30 Europe/Belgrade to UTC' });
    expect(fold.success).toBe(false);
    expect(fold.error).toContain('ambiguous');
  });

  test('validates fixed-offset calendar dates and the UTC+14 boundary', () => {
    expect(handleCalculate({ expression: '2026-02-31 12:30 UTC+2 to UTC' }).success).toBe(false);
    expect(handleCalculate({ expression: '2026-09-23 12:30 UTC+14:30 to UTC' }).success).toBe(false);
    expect(handleCalculate({ expression: '12:30:45 UTC+2 to UTC' })).toMatchObject({
      success: true,
      output: '10:30:45',
    });
  });

  test('production-invalid datetime forms return a self-correcting ISO example', () => {
    const invalid = [
      '2026-09-16 17:40 - 2 hours',
      '2026-09-17 18:30 - 2 hours',
      '2026-09-17 10:49 + 2 hours to UTC',
    ];
    for (const expression of invalid) {
      const r = handleCalculate({ expression });
      expect(r.success).toBe(false);
      expect(r.error).toContain('explicit Z/offset');
      expect(r.error).toContain('Local-to-UTC conversion accepts');
    }
  });

  test('canonical local datetime arithmetic uses the explicit offset and returns UTC', () => {
    const r = handleCalculate({ expression: '2026-09-17T10:49:00+02:00 + 2hours' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-09-17T10:49:00.000Z');
  });

  test('adds days to ISO date', async () => {
    const r = handleCalculate({ expression: '2026-03-18 + 7days' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-03-25');
  });

  test('returns error for unparseable expression', async () => {
    const r = handleCalculate({ expression: 'hello world' });
    expect(r.success).toBe(false);
    expect(r.error).toBeDefined();
  });

  test('adds weeks to ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 2weeks' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-04-01T22:34:00.000Z');
  });

  test('adds 1 month to ISO datetime (end-of-month clamp)', async () => {
    const r = handleCalculate({ expression: '2026-01-31T12:00:00Z + 1month' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-02-28T12:00:00.000Z');
  });

  test('subtracts 1 month from ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-31T12:00:00Z - 1month' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-02-28T12:00:00.000Z');
  });

  test('adds 1 year to ISO datetime', async () => {
    const r = handleCalculate({ expression: '2026-03-18T22:34:00Z + 1year' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2027-03-18T22:34:00.000Z');
  });

  test('adds weeks to date-only', async () => {
    const r = handleCalculate({ expression: '2026-03-18 + 2weeks' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-04-01');
  });

  test('adds months to date-only', async () => {
    const r = handleCalculate({ expression: '2026-03-18 + 1month' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2026-04-18');
  });

  test('adds years to date-only', async () => {
    const r = handleCalculate({ expression: '2026-03-18 + 1year' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2027-03-18');
  });

  test('datetime diff less than 60 min', async () => {
    const r = handleCalculate({ expression: '2026-03-21T17:31:07Z - 2026-03-21T17:00:07Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('31 min');
  });

  test('datetime diff exact hours', async () => {
    const r = handleCalculate({ expression: '2026-03-21T18:00:00Z - 2026-03-21T17:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1h');
  });

  test('datetime diff hours and minutes', async () => {
    const r = handleCalculate({ expression: '2026-03-21T19:30:00Z - 2026-03-21T17:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('2h 30min');
  });

  test('datetime diff in days', async () => {
    const r = handleCalculate({ expression: '2026-03-25T12:00:00Z - 2026-03-21T12:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('4 days');
  });

  test('datetime diff 1 day (singular)', async () => {
    const r = handleCalculate({ expression: '2026-03-22T12:00:00Z - 2026-03-21T12:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1 day');
  });

  test('datetime diff days and hours', async () => {
    const r = handleCalculate({ expression: '2026-03-22T18:00:00Z - 2026-03-21T12:00:00Z' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('1 day 6h');
  });

  test('date-only diff', async () => {
    const r = handleCalculate({ expression: '2026-04-10 - 2026-03-21' });
    expect(r.success).toBe(true);
    expect(r.output).toBe('20 days');
  });
});

describe('handleMakeCall', () => {
  test('blocks make_call during live_call', async () => {
    const liveCtx = {
      user: { telegram_id: 1, language: 'en' },
      inputMode: 'live_call',
    } as Partial<AgentContext> as AgentContext;
    const result = handleMakeCall(liveCtx, { text: 'reminder' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('live call');
  });

  test('returns error when callQueue not available', async () => {
    const noQueueCtx = {
      user: { telegram_id: 1, language: 'en' },
      inputMode: undefined,
    } as Partial<AgentContext> as AgentContext;
    const result = handleMakeCall(noQueueCtx, { text: 'reminder' });
    expect(result.success).toBe(false);
  });
});

describe('validateAndGetOffset', () => {
  test('returns offset for valid timezone', async () => {
    const dt = new Date('2026-01-15T12:00:00Z'); // January — unambiguously winter (UTC+2)
    const result = validateAndGetOffset('Europe/Kyiv', dt);
    expect(result.offsetStr).toBe('+02:00');
    expect(result.offsetMinutes).toBe(120);
  });

  test('returns offset for UTC', async () => {
    const dt = new Date('2026-03-20T12:00:00Z');
    const result = validateAndGetOffset('UTC', dt);
    expect(result.offsetStr).toBe('+00:00');
    expect(result.offsetMinutes).toBe(0);
  });

  test('throws RangeError for invalid timezone', async () => {
    const dt = new Date('2026-03-20T12:00:00Z');
    expect(() => {
      validateAndGetOffset('Garbage/Fake', dt);
    }).toThrow(RangeError);
  });

  test('throws RangeError for invalid timezone with specific message', async () => {
    const dt = new Date('2026-03-20T12:00:00Z');
    expect(() => {
      validateAndGetOffset('Invalid/Timezone', dt);
    }).toThrow(/invalid time zone/i);
  });
});

describe('getTimezoneSuggestions', () => {
  test('returns up to 30 suggestions for valid region prefix', async () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(30);
    expect(suggestions.every((s: string) => s.startsWith('America/'))).toBe(true);
  });

  test('returns globally sorted suggestions when no slash', async () => {
    const suggestions = getTimezoneSuggestions('Moscow');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(30);
  });

  test('deduplicates by timezone', async () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    const tzNames = suggestions.map((s: string) => s.split(' ')[0]);
    const unique = new Set(tzNames);
    expect(unique.size).toBe(tzNames.length);
  });

  test('format includes timezone and city name', async () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    expect(suggestions[0]).toMatch(/^[\w/]+ \(.+\)$/);
  });
});

describe('handleGetTimezoneInfo', () => {
  // --- single timezone ---
  test('returns correct info for valid IANA timezone', async () => {
    const result = handleGetTimezoneInfo({ timezone: 'Europe/London' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezone).toBe('Europe/London');
    expect(data.utc_offset).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(typeof data.dst_active).toBe('boolean');
    expect(data.local_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('accepts at parameter and returns offset at that time', async () => {
    // New York in January is UTC-5 (EST, no DST)
    const result = handleGetTimezoneInfo({ timezone: 'America/New_York', at: '2026-01-15T12:00:00Z' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.utc_offset).toBe('-05:00');
    expect(data.dst_active).toBe(false);
  });

  test('detects DST active in summer', async () => {
    // New York in July is UTC-4 (EDT, DST active)
    const result = handleGetTimezoneInfo({ timezone: 'America/New_York', at: '2026-07-15T12:00:00Z' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.utc_offset).toBe('-04:00');
    expect(data.dst_active).toBe(true);
  });

  test('returns error and suggestions for invalid timezone', async () => {
    const result = handleGetTimezoneInfo({ timezone: 'America/Blah' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid timezone');
    expect(result.error).toContain('America/');
  });

  test('returns format error when no slash', async () => {
    const result = handleGetTimezoneInfo({ timezone: 'Moscow' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('IANA');
  });

  test('returns error for invalid at datetime', async () => {
    const result = handleGetTimezoneInfo({ timezone: 'Europe/London', at: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  // --- array of timezones ---
  test('compares two timezones and shows which is ahead', async () => {
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

  test('array: ranks N timezones west to east, no difference fields', async () => {
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

  test('array: returns error if any timezone is invalid', async () => {
    const result = handleGetTimezoneInfo({ timezone: ['Europe/Moscow', 'America/Blah'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('America/Blah');
  });
});

describe('handleConvertToTimezone', () => {
  test('converts UTC datetime to local time in target timezone', async () => {
    const result = handleConvertToTimezone({ datetime: '2026-07-15T14:00:00Z', timezone: 'America/New_York' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezone).toBe('America/New_York');
    expect(data.local_datetime).toBe('2026-07-15T10:00:00-04:00'); // EDT = UTC-4
    expect(data.utc_offset).toBe('-04:00');
  });

  test('converts datetime with offset to another timezone', async () => {
    const result = handleConvertToTimezone({ datetime: '2026-01-15T10:00:00+01:00', timezone: 'Asia/Tokyo' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.local_datetime).toBe('2026-01-15T18:00:00+09:00');
  });

  test('returns error for invalid timezone', async () => {
    const result = handleConvertToTimezone({ datetime: '2026-01-15T10:00:00Z', timezone: 'Europe/Blah' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid timezone');
  });

  test('returns error for invalid datetime', async () => {
    const result = handleConvertToTimezone({ datetime: 'not-a-date', timezone: 'Europe/London' });
    expect(result.success).toBe(false);
  });
});
