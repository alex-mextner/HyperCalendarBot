import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, type Mock, mock, setSystemTime, test } from 'bun:test';
import { Scene } from '@gramio/scenes';
import type { InlineKeyboard } from 'gramio';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';
import type { BotCallbackContext } from '../../../src/bot/types.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { User } from '../../../src/database/types.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';

// Replay of 2026-09-27 (synthetic ids): on Sunday night the user asked to cancel "all English on
// Tuesday". The model listed two PAST Tuesdays and the two lessons of the coming Tuesday, printed
// UTC clock times as local, and after the tap deleted all four.
const NOW = new Date('2026-09-27T21:12:13Z');
const ACTOR = 7001;
const OTHER_MEMBER = 7002;
const GROUP_CHAT = -100500;

interface Sent {
  chatId: number;
  text: string;
  buttons: { label: string; data: string }[];
}

/** The callback fields the delete-confirmation route reads from a button tap. */
interface Tap {
  data: string;
  chatId: number;
  dbUser: User;
  from: { id: number };
  answer: Mock<() => Promise<void>>;
  editText: Mock<(text: string, opts?: { [key: string]: unknown }) => Promise<void>>;
  message: { id: number; text: string; entities: []; chat: { id: number; type: 'private' } };
}

function keyboardButtons(keyboard: InlineKeyboard): { label: string; data: string }[] {
  return keyboard
    .toJSON()
    .inline_keyboard.flat()
    .map((button) => ({ label: button.text, data: 'callback_data' in button ? String(button.callback_data) : '' }));
}

describe('bot-rendered delete confirmation', () => {
  let db: Database;
  let user: User;
  let eventService: EventService;
  let sent: Sent[];
  let continuations: { text: string; chatId: number }[];
  let ids: { sep1: number; sep8: number; lessonWithAlex: number; lesson: number };

  function context(overrides: Partial<AgentContext> = {}): AgentContext {
    return {
      user,
      chatId: ACTOR,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: new ChatHistoryRepository(db),
      userRepo: new UserRepository(db),
      eventReminderRepo: new EventReminderRepository(db),
      conversationLogger: new ConversationLogger(new ChatHistoryRepository(db)),
      sender: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => {},
        sendMessageWithKeyboard: async (chatId: number, text: string, keyboard: InlineKeyboard) => {
          sent.push({ chatId, text, buttons: keyboardButtons(keyboard) });
          return { message_id: 50 };
        },
      },
      ...overrides,
    };
  }

  // A tap carries only the fields the delete-confirmation route reads, so the one cast to the full
  // callback context lives here instead of at every call site.
  function callbackHandler(): (press: Tap) => Promise<void> {
    const handler = createCallbackHandler(
      eventService,
      new Scene('unused'),
      new HolidayService(new HolidayRepository(db)),
      new NotificationPreferencesService(new NotificationPreferencesRepository(db)),
      {
        agentContinuation: {
          agent: {
            run: async (ctx: AgentContext) => {
              continuations.push({ text: ctx.messageText, chatId: ctx.chatId });
              return { responseText: '', toolCalls: [], toolResults: [] };
            },
          },
          buildContext: (u, chatId, messageText, groupInfo) =>
            context({
              user: u,
              chatId,
              messageText,
              isGroup: groupInfo?.isGroup ?? false,
              groupChatId: groupInfo?.groupChatId,
            }),
        },
      },
    );
    return async (press) => {
      await handler(press as unknown as BotCallbackContext);
    };
  }

  function tap(data: string, message: Sent, clickerId = ACTOR): Tap {
    return {
      data,
      chatId: message.chatId,
      dbUser: clickerId === ACTOR ? user : { ...user, telegram_id: clickerId },
      from: { id: clickerId },
      answer: mock(() => Promise.resolve()),
      editText: mock((_text: string, _opts?: { [key: string]: unknown }) => Promise.resolve()),
      message: { id: 50, text: message.text, entities: [], chat: { id: message.chatId, type: 'private' } },
    };
  }

  function alive(eventId: number): boolean {
    return eventService.getEvent(eventId, ACTOR) !== null;
  }

  beforeEach(() => {
    setSystemTime(NOW);
    _resetToolThrottleForTest();
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    user = users.create({ telegram_id: ACTOR, timezone: 'Europe/Belgrade', language: 'ru' });
    users.create({ telegram_id: OTHER_MEMBER, timezone: 'Europe/Belgrade', language: 'ru' });
    eventService = new EventService({ eventRepo: new EventRepository(db) });
    const lesson = (title: string, start: string, end: string) =>
      eventService.createEvent({ user_id: ACTOR, title, start_at: start, end_at: end, timezone: 'Europe/Belgrade' }).id;
    ids = {
      sep1: lesson('Английский', '2026-09-01T11:30:00.000Z', '2026-09-01T12:30:00.000Z'),
      sep8: lesson('Английский', '2026-09-08T11:30:00.000Z', '2026-09-08T12:30:00.000Z'),
      lessonWithAlex: lesson('Английский с Алексом', '2026-09-29T10:30:00.000Z', '2026-09-29T11:30:00.000Z'),
      lesson: lesson('Английский', '2026-09-29T11:30:00.000Z', '2026-09-29T12:30:00.000Z'),
    };
    sent = [];
    continuations = [];
  });

  afterEach(() => {
    setSystemTime();
  });

  async function askAll(ctx = context()): Promise<Sent> {
    const result = await executeTool(ctx, 'ask_user', {
      question: 'Удалить все занятия «Английский», запланированные во вторник?',
      options: ['Да', 'Нет'],
      event_ids: [ids.sep1, ids.sep8, ids.lessonWithAlex, ids.lesson],
    });
    expect(result.success).toBe(true);
    expect(result.stopLoop).toBe(true);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  }

  test('the list shows local times, marks the past Tuesdays and offers upcoming-only separately', async () => {
    const message = await askAll();

    expect(message.text).toContain('«Английский» — вт, 1 сентября, 13:30–14:30 · уже прошло');
    expect(message.text).toContain('«Английский» — вт, 8 сентября, 13:30–14:30 · уже прошло');
    expect(message.text).toContain('«Английский с Алексом» — вт, 29 сентября, 12:30–13:30');
    expect(message.text).toContain('«Английский» — вт, 29 сентября, 13:30–14:30');
    expect(message.text).not.toContain('10:30');
    expect(message.text).not.toMatch(/\bid\b|#\d/);
    expect(message.buttons.map((button) => button.label)).toEqual([
      '🗑 Только предстоящие (2)',
      'Вкл. прошедшие (4)',
      'Отмена',
    ]);
  });

  test('tapping upcoming-only deletes the coming Tuesday and keeps the past ones', async () => {
    const message = await askAll();
    const upcomingOnly = message.buttons[0]!.data;
    const ctx = tap(upcomingOnly, message);
    await callbackHandler()(ctx);

    expect(alive(ids.lessonWithAlex)).toBe(false);
    expect(alive(ids.lesson)).toBe(false);
    expect(alive(ids.sep1)).toBe(true);
    expect(alive(ids.sep8)).toBe(true);
    const [edited] = ctx.editText.mock.calls[0]!;
    expect(edited).toStartWith(message.text);
    expect(edited).toContain('✅ Удалено: 2');
    expect(edited).toContain('Прошедшие не тронуты: 2');
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.text).toContain('If you show a picture, show 2026-09-29.');

    // The model then tries the past ones anyway: refused, rows stay.
    const again = await executeTool(context({ messageText: 'Да' }), 'delete_event', { event_id: ids.sep1 });
    expect(again.success).toBe(false);
    expect(again.mutationState).toBe('not_applied');
    expect(alive(ids.sep1)).toBe(true);
  });

  test('past events are deleted only with the explicit including-past button', async () => {
    const message = await askAll();
    await callbackHandler()(tap(message.buttons[1]!.data, message));
    expect(Object.values(ids).map(alive)).toEqual([false, false, false, false]);
  });

  test('a delete without a tap on the bot list is refused, also after a typed "Да"', async () => {
    const skipped = await executeTool(context({ messageText: '24 сентября удали урок' }), 'delete_event', {
      event_id: ids.lesson,
    });
    expect(skipped.success).toBe(false);
    expect(skipped.mutationState).toBe('not_applied');

    await askAll();
    const typed = await executeTool(context({ messageText: 'Да' }), 'delete_event', { event_id: ids.lesson });
    expect(typed.success).toBe(false);
    expect(alive(ids.lesson)).toBe(true);
  });

  test('cancel deletes nothing and keeps the list', async () => {
    const message = await askAll();
    const ctx = tap(message.buttons[2]!.data, message);
    await callbackHandler()(ctx);
    expect(Object.values(ids).map(alive)).toEqual([true, true, true, true]);
    expect(ctx.editText.mock.calls[0]![0]).toStartWith(message.text);
    expect(continuations).toHaveLength(0);
  });

  test("another group member's tap or an expired list deletes nothing", async () => {
    const groupCtx = context({ chatId: GROUP_CHAT, isGroup: true, groupChatId: GROUP_CHAT });
    const message = await askAll(groupCtx);
    const foreign = tap(message.buttons[1]!.data, message, OTHER_MEMBER);
    await callbackHandler()(foreign);
    expect(foreign.answer).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
    expect(Object.values(ids).map(alive)).toEqual([true, true, true, true]);

    setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    await callbackHandler()(tap(message.buttons[1]!.data, message));
    expect(Object.values(ids).map(alive)).toEqual([true, true, true, true]);
  });

  // Replay of 2026-09-23: six events confirmed, the model deleted five and replied "all deleted".
  // Now the tap deletes every confirmed event, and one that cannot be deleted is named everywhere.
  test('every confirmed event is deleted by the tap, and a failed one is reported, not hidden', async () => {
    const message = await askAll();
    eventService.deleteEvent(ids.lesson, ACTOR); // gone before the tap, e.g. from another device
    const ctx = tap(message.buttons[1]!.data, message);
    await callbackHandler()(ctx);

    expect([ids.sep1, ids.sep8, ids.lessonWithAlex].map(alive)).toEqual([false, false, false]);
    const [edited] = ctx.editText.mock.calls[0]!;
    expect(edited).toContain('✅ Удалено: 3');
    expect(edited).toContain('⚠️ Не удалось удалить: «Английский»');
    const report = continuations[0]!.text;
    expect(report).toContain(`Failed: #${ids.lesson} «Английский»`);
    expect(report).toContain(`#${ids.lessonWithAlex} «Английский с Алексом»`);
  });

  test('a tap can be used once', async () => {
    const message = await askAll();
    await callbackHandler()(tap(message.buttons[0]!.data, message));
    const second = tap(message.buttons[1]!.data, message);
    await callbackHandler()(second);
    expect(alive(ids.sep1)).toBe(true);
    expect(second.answer).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
  });

  test('an unknown id sends nothing and names the id', async () => {
    const result = await executeTool(context(), 'ask_user', {
      question: 'Удалить?',
      options: ['Да'],
      event_ids: [999_999],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('999999');
    expect(sent).toHaveLength(0);
  });

  test('an event created earlier in the same run can be undone without a confirmation', async () => {
    const ctx = context();
    const created = await executeTool(ctx, 'create_event', {
      title: 'Дубль',
      start_at: '2026-09-30T10:00:00.000Z',
      end_at: '2026-09-30T11:00:00.000Z',
    });
    expect(created.success).toBe(true);
    const createdId = [...(ctx.createdEventIds ?? [])][0]!;
    const undone = await executeTool(ctx, 'delete_event', { event_id: createdId });
    expect(undone.success).toBe(true);
    expect(alive(createdId)).toBe(false);
  });

  test('a code-defined intent workflow deletes after its own confirmation', async () => {
    const result = await executeTool(context({ toolOrigin: 'intent_workflow' }), 'delete_event', {
      event_id: ids.lesson,
    });
    expect(result.success).toBe(true);
    expect(alive(ids.lesson)).toBe(false);
  });

  test('on a call the spoken list approves only upcoming events', async () => {
    const call = context({ inputMode: 'live_call' });
    const spoken = await executeTool(call, 'ask_user', {
      question: 'Удалить?',
      options: ['Да', 'Нет'],
      event_ids: [ids.sep1, ids.lesson],
    });
    expect(spoken.awaitingInput).toEqual(expect.objectContaining({ kind: 'speech' }));
    expect(String(spoken.output)).toContain('13:30–14:30');
    expect((await executeTool(call, 'delete_event', { event_id: ids.lesson })).success).toBe(true);
    expect((await executeTool(call, 'delete_event', { event_id: ids.sep1 })).success).toBe(false);
    expect(alive(ids.sep1)).toBe(true);
  });
});
