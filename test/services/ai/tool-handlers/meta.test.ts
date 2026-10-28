// meta tool handlers: holidays, user/contact lookup, ask/pick, bot info, day image and calls.
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { t } from '../../../../src/config/constants.ts';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { ContactRepository } from '../../../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
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

    describe('without the service account', () => {
      test('verifies a local bot user named explicitly by @username', async () => {
        ctx.userRepo.create({
          telegram_id: 456,
          timezone: 'UTC',
          language: 'en',
          username: 'alex',
          first_name: 'Alex',
        });
        ctx.messageText = 'Find @alex';
        const result = await handleFindUser(ctx, { username: '@alex' });
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ telegram_id: 456, name: 'Alex' });
        expect(ctx.verifiedRecipientIds?.has(456)).toBe(true);
      });

      test('a bot user without a first name is named by the stored @username, not the lowercased input', async () => {
        ctx.userRepo.create({ telegram_id: 457, timezone: 'UTC', language: 'en', username: 'SamRiver' });
        ctx.messageText = 'Find @samriver';
        const result = await handleFindUser(ctx, { username: '@samriver' });
        expect(result.data).toEqual({ telegram_id: 457, name: 'SamRiver' });
        expect(ctx.verifiedRecipientIds?.has(457)).toBe(true);
      });

      test.each([0, -5])('a users row with invalid telegram_id %d is never verified', async (id) => {
        ctx.userRepo.create({ telegram_id: id, timezone: 'UTC', language: 'en', username: 'broken' });
        ctx.messageText = 'Find @broken';
        const result = await handleFindUser(ctx, { username: '@broken' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('unavailable');
        expect(ctx.verifiedRecipientIds?.has(id) ?? false).toBe(false);
      });

      test('unknown @username: says the lookup is unavailable, never "not found" or "not started", offers the picker, spawns nothing', async () => {
        const spawn = spyOn(Bun, 'spawn');
        try {
          ctx.messageText = 'Find @ghost_user';
          const result = await handleFindUser(ctx, { username: '@ghost_user' });
          expect(result.success).toBe(false);
          expect(result.error).toContain('unavailable');
          expect(result.error).not.toMatch(/not found|started/i);
          expect(result.agentHint).toContain('pick_users');
          expect(ctx.verifiedRecipientIds?.size ?? 0).toBe(0);
          expect(spawn).not.toHaveBeenCalled();
        } finally {
          spawn.mockRestore();
        }
      });

      test('unknown @username error is localized for Russian users', async () => {
        ctx.user = { ...ctx.user, language: 'ru' };
        ctx.messageText = 'Найди @ghost_user';
        const result = await handleFindUser(ctx, { username: 'ghost_user' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('недоступна');
        expect(result.agentHint).toContain('pick_users');
      });
    });

    describe('with the service account', () => {
      test('resolves an @username unknown to the bot through it and marks the ID verified', async () => {
        const asked: string[] = [];
        ctx.resolveUsername = async (username) => {
          asked.push(username);
          return { id: 5000000020, firstName: 'Alex', username: 'ux_consul' };
        };
        ctx.messageText = 'Find @UX_Consul';
        const result = await handleFindUser(ctx, { username: '@UX_Consul' });
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ telegram_id: 5000000020, name: 'Alex' });
        expect(asked).toEqual(['ux_consul']);
        expect(ctx.verifiedRecipientIds?.has(5000000020)).toBe(true);
      });

      test("Telegram's answer wins over a stale users row for the same @username", async () => {
        ctx.userRepo.create({ telegram_id: 5000000021, timezone: 'UTC', language: 'en', username: 'recycled' });
        ctx.resolveUsername = async () => ({ id: 5000000022, username: 'recycled' });
        ctx.messageText = 'Find @recycled';
        const result = await handleFindUser(ctx, { username: 'recycled' });
        expect(result.data).toEqual({ telegram_id: 5000000022, name: 'recycled' });
        expect(ctx.verifiedRecipientIds?.has(5000000021) ?? false).toBe(false);
      });

      test('a username Telegram does not know is reported as not found on Telegram and never verified', async () => {
        ctx.resolveUsername = async () => null;
        ctx.messageText = 'Find @ghost_user';
        const result = await handleFindUser(ctx, { username: '@ghost_user' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('@ghost_user not found on Telegram');
        expect(result.agentHint).toContain('pick_users');
        expect(ctx.verifiedRecipientIds?.size ?? 0).toBe(0);
      });

      test('a lookup that could not run is reported as unavailable, never as not found', async () => {
        ctx.resolveUsername = async () => {
          throw new Error('synthetic FLOOD_WAIT');
        };
        ctx.messageText = 'Find @ghost_user';
        const result = await handleFindUser(ctx, { username: '@ghost_user' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('unavailable');
        expect(result.error).not.toMatch(/not found|FLOOD_WAIT/);
        expect(result.agentHint).toContain('pick_users');
        expect(ctx.verifiedRecipientIds?.size ?? 0).toBe(0);
      });

      test('an answer whose ID names no real person is never verified', async () => {
        ctx.resolveUsername = async () => ({ id: 0, username: 'broken' });
        ctx.messageText = 'Find @broken';
        const result = await handleFindUser(ctx, { username: '@broken' });
        expect(result.success).toBe(false);
        expect(ctx.verifiedRecipientIds?.size ?? 0).toBe(0);
      });
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

    test('ambiguous same-named contacts return an identity conflict, not a raw DB error', () => {
      const contactRepo = new ContactRepository(db);
      contactRepo.add(USER_ID, 'Лена', undefined, 111);
      contactRepo.add(USER_ID, 'лена', undefined, 222);
      ctx.contactRepo = contactRepo;
      const result = handleAddContact(ctx, { name: 'Лена' });
      expect(result.success).toBe(false);
      expect(result.mutationState).toBe('not_applied');
      expect(result.error).toBe(t(ctx.user.language).aiTools.meta.recipientIdentityConflict);
      expect(contactRepo.list(USER_ID)).toHaveLength(2);
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

  describe('handleMakeCall', () => {
    function withCallQueue(enqueue: (userId: number, text: string) => Promise<void>): AgentContext {
      return {
        ...ctx,
        calls: {
          callQueue: { enqueue },
          callSettingsRepo: {
            get: () => null,
            ensureDefaults: () => {},
            setEnabled: () => {},
            setLanguage: () => {},
          },
        },
      };
    }

    test('blocks make_call during live_call', async () => {
      const liveCtx: AgentContext = { ...ctx, inputMode: 'live_call' };
      const result = await handleMakeCall(liveCtx, { text: 'reminder' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('live call');
    });

    test('returns error when callQueue not available', async () => {
      const noQueueCtx: AgentContext = { ...ctx, inputMode: undefined };
      const result = await handleMakeCall(noQueueCtx, { text: 'reminder' });
      expect(result.success).toBe(false);
    });

    test('reports the call as queued once the queue accepted it', async () => {
      const queued: [number, string][] = [];
      const result = await handleMakeCall(
        withCallQueue(async (userId, text) => {
          queued.push([userId, text]);
        }),
        { text: 'Standup in 10 minutes' },
      );
      expect(queued).toEqual([[USER_ID, 'Standup in 10 minutes']]);
      expect(result).toEqual({ success: true, output: t('en').aiTools.meta.callQueued });
    });

    test('fails truthfully when the queue write is rejected', async () => {
      const result = await handleMakeCall(
        withCallQueue(async () => {
          throw new Error('Redis connection lost');
        }),
        { text: 'Standup in 10 minutes' },
      );
      expect(result.success).toBe(false);
      expect(result.output).toBeUndefined();
      expect(result.error).toBe(t('en').aiTools.meta.callQueueFailed);
      expect(result.error).not.toBe(t('en').aiTools.meta.callQueued);
    });
  });
});
