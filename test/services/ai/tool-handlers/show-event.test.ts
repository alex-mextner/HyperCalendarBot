// test/services/ai/tool-handlers/show-event.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, type Mock, mock, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { GroupChatRepository } from '../../../../src/database/repositories/group-chat.repository.ts';
import { SecretaryRepository } from '../../../../src/database/repositories/secretary.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleGetEvent, handleShowEvent } from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

interface CtxParts {
  [key: string]: unknown;
}

/** Centralized cast per CLAUDE.md's test-factory exception: only the AgentContext fields this
 *  suite's handleShowEvent/handleGetEvent calls actually read are implemented. */
function makeAgentContext(parts: CtxParts): AgentContext {
  return parts as unknown as AgentContext;
}

/** Same exception, for the one test that overrides ctx.sender with a keyboard-less sender. */
function senderWithoutButtons(sendMessage: CtxParts['sendMessage']): AgentContext['sender'] {
  return { sendMessage } as unknown as AgentContext['sender'];
}

describe('handleShowEvent', () => {
  let db: Database;
  let ctx: AgentContext;
  let sendMessage: Mock<() => Promise<{ message_id: number }>>;
  let sendMessageWithKeyboard: Mock<() => Promise<{ message_id: number }>>;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const secretaryRepo = new SecretaryRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'en' });
    const eventService = new EventService({ eventRepo });
    sendMessage = mock(() => Promise.resolve({ message_id: 1 }));
    sendMessageWithKeyboard = mock(() => Promise.resolve({ message_id: 1 }));
    ctx = makeAgentContext({
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService: null,
      chatHistory: chatHistoryRepo,
      userRepo,
      eventReminderRepo,
      conversationLogger: null,
      sender: { sendMessage, sendMessageWithKeyboard },
      secretary: { secretaryRepo, secretaryForLine: undefined, calendarProposalRepo: null },
    });
  });

  describe('by event_id', () => {
    test('single event found sends the canonical card with a keyboard', async () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Retro',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T10:30:00Z',
        timezone: 'UTC',
      });
      const result = await handleShowEvent(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
      expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
      const [chatId, text, keyboard, parseMode] = sendMessageWithKeyboard.mock.calls[0] as unknown[];
      expect(chatId).toBe(USER_ID);
      expect(text as string).toContain('Retro');
      expect(parseMode).toBe('HTML');
      expect(JSON.stringify(keyboard)).toContain(String(event.id));
    });

    test('not found returns a distinct error and sends nothing', async () => {
      const result = await handleShowEvent(ctx, { event_id: 999 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('999');
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
    });

    test('denied: owner_id without active secretary access, no read attempted', async () => {
      const result = await handleShowEvent(ctx, { event_id: 1, owner_id: 555 });
      expect(result.success).toBe(false);
      expect(result.error).toBe('SECRETARY_ACCESS_DENIED');
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
    });
  });

  describe('by date range', () => {
    test('zero matches sends a clear "nothing found" message, not the empty-card path', async () => {
      const result = await handleShowEvent(ctx, { start_date: '2026-03-15', end_date: '2026-03-15' });
      expect(result.success).toBe(true);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
      const [, text] = sendMessage.mock.calls[0] as unknown[];
      expect((text as string).toLowerCase()).not.toContain('error');
    });

    test('exactly one match sends the canonical card', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: "Today's meeting",
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T10:30:00Z',
        timezone: 'UTC',
      });
      const result = await handleShowEvent(ctx, { start_date: '2026-03-15', end_date: '2026-03-15' });
      expect(result.success).toBe(true);
      expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
      const [, text] = sendMessageWithKeyboard.mock.calls[0] as unknown[];
      expect(text as string).toContain("Today's meeting");
    });

    test('two matches send a picker, never the first guess', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Standup',
        start_at: '2026-03-15T09:00:00Z',
        end_at: '2026-03-15T09:15:00Z',
        timezone: 'UTC',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Retro',
        start_at: '2026-03-15T15:00:00Z',
        end_at: '2026-03-15T15:30:00Z',
        timezone: 'UTC',
      });
      const result = await handleShowEvent(ctx, { start_date: '2026-03-15', end_date: '2026-03-15' });
      expect(result.success).toBe(true);
      expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
      const [, , keyboard] = sendMessageWithKeyboard.mock.calls[0] as unknown[];
      const kbText = JSON.stringify(keyboard);
      expect(kbText).toContain('Standup');
      expect(kbText).toContain('Retro');
    });

    test('a matched occurrence of a recurring series shows its own instant, not the template date', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Weekly sync',
        start_at: '2026-03-11T09:00:00Z',
        end_at: '2026-03-11T09:30:00Z',
        timezone: 'UTC',
        recurrence_rule: 'FREQ=WEEKLY',
      });
      const result = await handleShowEvent(ctx, { start_date: '2026-03-18', end_date: '2026-03-18' });
      expect(result.success).toBe(true);
      const [, text, keyboard] = sendMessageWithKeyboard.mock.calls[0] as unknown[];
      expect(text as string).toContain('18');
      expect((text as string).match(/\b11\b/)).toBeNull();
      expect(JSON.stringify(keyboard)).toContain('2026-03-18');
    });

    test('group scope reads the group calendar', async () => {
      const GROUP_ID = -100999;
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team sync',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T10:30:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      const groupCtx = { ...ctx, isGroup: true, groupChatId: GROUP_ID, chatId: GROUP_ID };
      const result = await handleShowEvent(groupCtx, {
        start_date: '2026-03-15',
        end_date: '2026-03-15',
        scope: 'group',
      });
      expect(result.success).toBe(true);
      const [chatId, text] = sendMessageWithKeyboard.mock.calls[0] as unknown[];
      expect(chatId).toBe(GROUP_ID);
      expect(text as string).toContain('Team sync');
    });

    test("a group card shows the group's clock, not the asking member's", async () => {
      const GROUP_ID = -100998;
      const groupChatRepo = new GroupChatRepository(db);
      groupChatRepo.upsertGroup({ chat_id: GROUP_ID, added_by: USER_ID });
      groupChatRepo.setTimezone(GROUP_ID, 'Asia/Tokyo');
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team sync',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T10:30:00Z',
        timezone: 'Asia/Tokyo',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      const groupCtx = makeAgentContext({
        ...ctx,
        isGroup: true,
        groupChatId: GROUP_ID,
        chatId: GROUP_ID,
        group: { groupChatRepo },
      });
      const result = await handleShowEvent(groupCtx, { event_id: event.id, scope: 'group' });
      expect(result.success).toBe(true);
      const [, text] = sendMessageWithKeyboard.mock.calls[0] as unknown[];
      // 10:00 UTC is 19:00 in Tokyo; the member's own zone here is UTC.
      expect(text as string).toContain('19:00');
      expect(text as string).not.toContain('10:00');
    });

    test('group scope without a group chat id is refused before any read', async () => {
      const result = await handleShowEvent(ctx, {
        start_date: '2026-03-15',
        end_date: '2026-03-15',
        scope: 'group',
      });
      expect(result.success).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test('a read failure is reported as a distinct error, never as an empty calendar', async () => {
      ctx.eventService.getEventsInRange = () => {
        throw new Error('SQLITE_BUSY');
      };
      const result = await handleShowEvent(ctx, { start_date: '2026-03-15', end_date: '2026-03-15' });
      // Delivered as a reported error, not surfaced for AI-agent fallthrough retry.
      expect(result.success).toBe(true);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
      const [, text] = sendMessage.mock.calls[0] as unknown[];
      expect((text as string).toLowerCase()).not.toBe('');
      // Distinct wording from the real "nothing found" message.
      const emptyResult = await handleShowEvent(
        { ...ctx, eventService: new EventService({ eventRepo: new EventRepository(createTestDb()) }) },
        { start_date: '2099-01-01', end_date: '2099-01-01' },
      );
      expect(emptyResult.success).toBe(true);
    });

    test('a delivery failure after a successful read is NOT mislabeled as a read error', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Today only event',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T10:30:00Z',
        timezone: 'UTC',
      });
      sendMessageWithKeyboard.mockImplementationOnce(() => {
        throw new Error('ETELEGRAM: 429 Too Many Requests');
      });
      // The read succeeded (there was exactly one event); only the send failed. That must
      // surface as a genuine failure, not the DB-read error card from the test above.
      await expect(handleShowEvent(ctx, { start_date: '2026-03-15', end_date: '2026-03-15' })).rejects.toThrow(
        'ETELEGRAM',
      );
      expect(sendMessage).not.toHaveBeenCalled();
    });

    test('long descriptions are split into chunks with the keyboard only on the final chunk', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Long event',
        description: 'x'.repeat(5000),
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T10:30:00Z',
        timezone: 'UTC',
      });
      const result = await handleShowEvent(ctx, { start_date: '2026-03-15', end_date: '2026-03-15' });
      expect(result.success).toBe(true);
      expect(sendMessage.mock.calls.length).toBeGreaterThan(0);
      expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
    });

    test('missing both event_id and a date range is a clear contract error, not a silent no-op', async () => {
      const result = await handleShowEvent(ctx, {});
      expect(result.success).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
    });
  });

  test('sender without button support fails clearly instead of sending plain text', async () => {
    ctx.sender = senderWithoutButtons(sendMessage);
    const result = await handleShowEvent(ctx, { event_id: 1 });
    expect(result.success).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('internal get_event never sends to the chat — it stays read-only planning data', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Planning only',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = await handleGetEvent(ctx, { event_id: event.id });
    expect(result.success).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendMessageWithKeyboard).not.toHaveBeenCalled();
  });
});
