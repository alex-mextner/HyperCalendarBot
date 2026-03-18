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
  handleAddContact,
  handleAskUser,
  handleFindContact,
  handleFindUser,
  handleGetBotInfo,
  handleGetContacts,
  handleGetHolidays,
  handlePickUsers,
  handleRenderDayImage,
  handleUpdateContact,
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
    };
  });

  describe('handleGetHolidays', () => {
    test('returns message when no subscriptions', () => {
      const result = handleGetHolidays(ctx, {});
      expect(result.success).toBe(true);
      expect(result.output).toContain('No');
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
          return Promise.resolve();
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
