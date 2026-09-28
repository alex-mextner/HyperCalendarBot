// Regression tests for #498: a reply or ask_user question must not show an event's UTC
// clock time as the user's local time. Fixtures are synthetic reconstructions of the
// 2026-09-27 incident (user in Europe/Belgrade, UTC+2; clock Sunday 2026-09-27 21:00Z).
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import type OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { correctUtcClockTimes, type EventClock } from '../../../src/services/ai/reply-time-guard.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

const TZ = 'Europe/Belgrade';
const LESSON = 'Урок английского';
const ERRAND = 'Отвезти переноску';

const lesson: EventClock = {
  id: 44,
  title: LESSON,
  startUtc: '2026-09-28T10:30:00.000Z',
  endUtc: '2026-09-28T11:30:00.000Z',
  fromTool: true,
};
const errand: EventClock = {
  id: 43,
  title: ERRAND,
  startUtc: '2026-09-28T18:30:00.000Z',
  endUtc: '2026-09-28T19:30:00.000Z',
  fromTool: true,
};

// The 23:12 'Планы на среду' answer: both events and the free windows built on them in UTC.
const utcDayPlan = [
  '**Понедельник, 28 сентября 2026**',
  `- **10:30 – 11:30** — *${LESSON}* (погода: ☀️ 22 °C, ясно)`,
  `- **18:30 – 19:30** — *${ERRAND}* (погода: ☀️ 17 °C, ясно)`,
  '**Свободные окна:**',
  '- **00:00 – 10:30** — утро.',
  '- **11:30 – 18:30** — перерыв.',
  '- **19:30 – 23:59** — вечер.',
].join('\n');

const localDayPlan = [
  '**Понедельник, 28 сентября 2026**',
  `- **12:30 – 13:30** — *${LESSON}* (погода: ☀️ 22 °C, ясно)`,
  `- **20:30 – 21:30** — *${ERRAND}* (погода: ☀️ 17 °C, ясно)`,
  '**Свободные окна:**',
  '- **00:00 – 12:30** — утро.',
  '- **13:30 – 20:30** — перерыв.',
  '- **21:30 – 23:59** — вечер.',
].join('\n');

// The 23:12 delete confirmation: four lessons named by id, all at their UTC clock times.
const tuesdayLessons: EventClock[] = [
  { id: 11, title: LESSON, startUtc: '2026-09-01T11:30:00.000Z', endUtc: '2026-09-01T12:30:00.000Z', fromTool: true },
  { id: 12, title: LESSON, startUtc: '2026-09-08T11:30:00.000Z', endUtc: '2026-09-08T12:30:00.000Z', fromTool: true },
  { id: 13, title: LESSON, startUtc: '2026-09-29T10:30:00.000Z', endUtc: '2026-09-29T11:30:00.000Z', fromTool: true },
  { id: 14, title: LESSON, startUtc: '2026-09-29T11:30:00.000Z', endUtc: '2026-09-29T12:30:00.000Z', fromTool: true },
];
const utcDeleteQuestion = [
  `Удалить все занятия «${LESSON}», запланированные во вторник?`,
  '• 1 сентября 2026 11:30 – 12:30 (id 11)',
  '• 8 сентября 2026 11:30 – 12:30 (id 12)',
  '• 29 сентября 2026 10:30 – 11:30 (id 13)',
  '• 29 сентября 2026 11:30 – 12:30 (id 14)',
].join('\n');
const localDeleteQuestion = [
  `Удалить все занятия «${LESSON}», запланированные во вторник?`,
  '• 1 сентября 2026 13:30 – 14:30 (id 11)',
  '• 8 сентября 2026 13:30 – 14:30 (id 12)',
  '• 29 сентября 2026 12:30 – 13:30 (id 13)',
  '• 29 сентября 2026 13:30 – 14:30 (id 14)',
].join('\n');

describe('correctUtcClockTimes', () => {
  test('rewrites event times printed in UTC and the free windows derived from them', () => {
    expect(correctUtcClockTimes(utcDayPlan, [lesson, errand], TZ)).toBe(localDayPlan);
  });

  test('rewrites each line named by an event id with that event’s own clock', () => {
    expect(correctUtcClockTimes(utcDeleteQuestion, tuesdayLessons, TZ)).toBe(localDeleteQuestion);
  });

  test('leaves a reply that already shows local times untouched', () => {
    expect(correctUtcClockTimes(localDayPlan, [lesson, errand], TZ)).toBe(localDayPlan);
  });

  test('prefers the longest title when one title contains another', () => {
    const shortTitle: EventClock = {
      id: 7,
      title: 'Урок',
      startUtc: '2026-09-28T08:30:00.000Z',
      endUtc: '2026-09-28T09:30:00.000Z',
      fromTool: true,
    };
    // 10:30 is the short-titled event's local start, but the line names the lesson.
    expect(correctUtcClockTimes(`10:30 – 11:30 ${LESSON}`, [shortTitle, lesson], TZ)).toBe(`12:30 – 13:30 ${LESSON}`);
  });

  test.each([
    ['a time labelled UTC', `${LESSON}: 12:30 (10:30 UTC)`],
    ['a time labelled «по UTC»', `${LESSON} в 10:30 по UTC`],
    ['a range labelled UTC after its end', `${LESSON}: 10:30–11:30 UTC`],
    ['a range labelled UTC before its start', `${LESSON}: UTC 10:30 – 11:30`],
    ['a time after «UTC:»', `${LESSON} (UTC: 10:30)`],
    ['a time labelled «по Гринвичу»', `${LESSON} начинается в 10:30 по Гринвичу`],
    ['an ISO timestamp', `${LESSON}: 2026-09-28T10:30:00.000Z`],
    ['a time with no event named on its line', 'В Токио сейчас 10:30'],
  ])('does not touch %s', (_label, text) => {
    expect(correctUtcClockTimes(text, [lesson, errand], TZ)).toBe(text);
  });

  test('a schedule-window event alone never triggers a rewrite', () => {
    // Without a tool result the model may be quoting another event entirely.
    const text = `- 18:30 – 19:30 ${ERRAND}\n- свободно 19:30 – 23:59`;
    expect(correctUtcClockTimes(text, [{ ...errand, fromTool: false }], TZ)).toBe(text);
    const withToolEvent = `- 10:30 – 11:30 ${LESSON}\n${text}`;
    expect(correctUtcClockTimes(withToolEvent, [lesson, { ...errand, fromTool: false }], TZ)).toBe(
      `- 12:30 – 13:30 ${LESSON}\n- 20:30 – 21:30 ${ERRAND}\n- свободно 21:30 – 23:59`,
    );
  });

  test('does nothing for a user whose zone has no offset', () => {
    expect(correctUtcClockTimes(utcDayPlan, [lesson, errand], 'UTC')).toBe(utcDayPlan);
  });

  test('skips a line when same-titled events map one UTC time to different local times', () => {
    const winter: EventClock = {
      id: 1,
      title: LESSON,
      startUtc: '2026-01-15T10:30:00.000Z',
      endUtc: null,
      fromTool: true,
    };
    const summer: EventClock = {
      id: 2,
      title: LESSON,
      startUtc: '2026-07-15T10:30:00.000Z',
      endUtc: null,
      fromTool: true,
    };
    const text = `${LESSON} — 10:30`;
    expect(correctUtcClockTimes(text, [winter, summer], TZ)).toBe(text);
  });

  test('keeps unnamed lines when a UTC time is also a real local time of a named event', () => {
    const coffee: EventClock = {
      id: 9,
      title: 'Кофе с соседкой',
      startUtc: '2026-09-28T08:30:00.000Z',
      endUtc: '2026-09-28T09:00:00.000Z',
      fromTool: true,
    };
    const text = [`- 10:30 – 11:00 Кофе с соседкой`, `- 10:30 – 11:30 ${LESSON}`, '- свободно 00:00 – 10:30'].join(
      '\n',
    );
    const expected = [`- 10:30 – 11:00 Кофе с соседкой`, `- 12:30 – 13:30 ${LESSON}`, '- свободно 00:00 – 10:30'].join(
      '\n',
    );
    expect(correctUtcClockTimes(text, [coffee, lesson], TZ)).toBe(expected);
  });
});

// ── Production path: executeTool evidence + ask_user + agent delivery ──────────

type ScriptedRound =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; callId: string; name: string; input: { [key: string]: unknown }; text?: string };

function scriptedStream(script: ScriptedRound[]) {
  let round = 0;
  return async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}): Promise<StreamRoundResult> => {
    const system = opts.messages[0];
    if (
      system?.role === 'system' &&
      typeof system.content === 'string' &&
      system.content.includes('strict QA validator')
    ) {
      return {
        text: 'APPROVE',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: 'APPROVE' },
        providerUsed: 'mock-validator',
      };
    }
    const current = script[round++];
    if (!current) throw new Error(`Scripted stream ran out of rounds (call ${round})`);
    if (current.kind === 'text') {
      cbs.onTextDelta?.(current.text);
      return {
        text: current.text,
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: current.text },
        providerUsed: 'mock',
      };
    }
    cbs.onTextDelta?.(current.text ?? '');
    cbs.onToolCallStart?.(current.name);
    const args = JSON.stringify(current.input);
    const assistantMessage: OpenAI.ChatCompletionMessageParam = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: current.callId, type: 'function', function: { name: current.name, arguments: args } }],
    };
    return {
      text: '',
      toolCalls: [{ id: current.callId, name: current.name, arguments: args }],
      finishReason: 'tool_calls',
      assistantMessage,
      providerUsed: 'mock',
    };
  };
}

describe('UTC-as-local guard on delivered text', () => {
  const USER_ID = 900001;
  let ctx: AgentContext;
  let sender: TelegramSender;
  let delivered: string;
  let askedQuestions: string[];

  beforeEach(() => {
    setSystemTime(new Date('2026-09-27T21:00:00Z'));
    _resetToolThrottleForTest();
    aiFailureNotices.reset();
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: TZ, language: 'ru' });
    const chatHistoryRepo = new ChatHistoryRepository(db);
    delivered = '';
    askedQuestions = [];
    sender = {
      sendMessage: mock(() => Promise.resolve({ message_id: 42 })),
      editMessageText: mock(async (_chatId: number, _messageId: number, text: string) => {
        delivered = text;
      }),
      sendButtons: async (_chatId: number, text: string) => {
        askedQuestions.push(text);
        return { message_id: 43 };
      },
    };
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'Планы на понедельник',
      isGroup: false,
      eventService: new EventService({ eventRepo: new EventRepository(db) }),
      holidayService: new HolidayService(new HolidayRepository(db)),
      eventReminderRepo: new EventReminderRepository(db),
      chatHistory: chatHistoryRepo,
      conversationLogger: new ConversationLogger(chatHistoryRepo),
      userRepo,
      sender,
    };
  });

  afterEach(() => {
    setSystemTime();
  });

  function createEvent(title: string, startAt: string, endAt: string) {
    return ctx.eventService.createEvent({ user_id: USER_ID, title, start_at: startAt, end_at: endAt, timezone: TZ });
  }

  function lastAssistantText(): string {
    const rows = ctx.chatHistory.getRecent(USER_ID, 30).filter((row) => row.role === 'assistant');
    return rows.at(-1)?.content ?? '';
  }

  test('a day plan built on get_events is delivered and saved with local times', async () => {
    const first = createEvent(LESSON, lesson.startUtc, lesson.endUtc!);
    const second = createEvent(ERRAND, errand.startUtc, errand.endUtc!);
    const plan = utcDayPlan.replace(`*${LESSON}*`, `*${first.title}*`).replace(`*${ERRAND}*`, `*${second.title}*`);
    const impl = scriptedStream([
      { kind: 'tool', callId: 'read', name: 'get_events', input: { start_date: '2026-09-28', end_date: '2026-09-28' } },
      { kind: 'text', text: plan },
    ]);

    const result = await new CalendarBotAgent({}, sender, { streamImpl: impl }).run(ctx);

    for (const text of [result.responseText, delivered, lastAssistantText()]) {
      expect(text).toContain('12:30 – 13:30');
      expect(text).toContain('20:30 – 21:30');
      expect(text).toContain('13:30 – 20:30');
      expect(text).not.toContain('10:30 – 11:30');
      expect(text).not.toContain('11:30 – 18:30');
    }
  });

  test('an event known only from the schedule window is corrected next to a just-created one', async () => {
    const errandRow = createEvent(ERRAND, errand.startUtc, errand.endUtc!);
    ctx.recentEventsWindow = ctx.eventService.getEventsInRange(
      USER_ID,
      '2026-09-13T00:00:00.000Z',
      '2026-10-11T23:59:59.000Z',
    );
    expect(ctx.recentEventsWindow.map((occ) => occ.event.id)).toEqual([errandRow.id]);
    const reply = [
      '*28 сентября 2026*',
      `- **10:30 – 11:30** — *${LESSON}* (напоминание за 15 мин).`,
      `- **18:30 – 19:30** — *${ERRAND}* (напоминание за 15 мин).`,
      'Свободные окна:',
      '- **00:00 – 10:30** — утро и день до занятия.',
    ].join('\n');
    const impl = scriptedStream([
      {
        kind: 'tool',
        callId: 'create',
        name: 'create_event',
        input: { title: LESSON, start_at: lesson.startUtc, end_at: lesson.endUtc },
      },
      { kind: 'text', text: reply },
    ]);

    const result = await new CalendarBotAgent({}, sender, { streamImpl: impl }).run(ctx);

    for (const text of [result.responseText, lastAssistantText()]) {
      expect(text).toContain(`12:30 – 13:30** — *${LESSON}*`);
      expect(text).toContain(`20:30 – 21:30** — *${ERRAND}*`);
      expect(text).toContain('00:00 – 12:30');
    }
  });

  test('narration in a tool round is corrected in the execution log too', async () => {
    createEvent(LESSON, lesson.startUtc, lesson.endUtc!);
    const impl = scriptedStream([
      {
        kind: 'tool',
        callId: 'read',
        name: 'get_events',
        input: { start_date: '2026-09-28', end_date: '2026-09-28' },
      },
      {
        kind: 'tool',
        callId: 'read-again',
        name: 'get_events',
        input: { start_date: '2026-09-28', end_date: '2026-09-29' },
        text: `Вижу: ${LESSON} 10:30–11:30, проверю следующий день.`,
      },
      { kind: 'text', text: `${LESSON}: 10:30–11:30` },
    ]);

    await new CalendarBotAgent({}, sender, { streamImpl: impl }).run(ctx);

    expect(delivered).toContain(`${LESSON} 12:30–13:30, проверю`);
    expect(delivered).not.toContain('10:30');
  });

  test('a malformed event row never breaks the reply', async () => {
    ctx.surfacedEvents = [
      { id: 5, title: LESSON, date: '2026-09-28', time: '10:30', all_day: false, end_at: 'garbage' },
    ];
    const impl = scriptedStream([{ kind: 'text', text: `${LESSON}: 10:30` }]);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toContain(`${LESSON}: 10:30`);
  });

  test('ask_user buttons get the same correction as the question', async () => {
    const id = createEvent(LESSON, lesson.startUtc, lesson.endUtc!).id;
    let buttons: string[] = [];
    sender.sendButtons = async (_chatId: number, _text: string, options: string[]) => {
      buttons = options;
      return { message_id: 44 };
    };
    expect((await executeTool(ctx, 'get_event', { event_id: id })).success).toBe(true);
    await executeTool(ctx, 'ask_user', {
      question: `Перенести ${LESSON}?`,
      options: [`Оставить ${LESSON} в 10:30`, 'Нет'],
    });
    expect(buttons[0]).toBe(`Оставить ${LESSON} в 12:30`);
  });

  test('a bare-time ask_user button follows the question it answers', async () => {
    const id = createEvent(LESSON, lesson.startUtc, lesson.endUtc!).id;
    let question = '';
    let buttons: string[] = [];
    sender.sendButtons = async (_chatId: number, text: string, options: string[]) => {
      question = text;
      buttons = options;
      return { message_id: 45 };
    };
    expect((await executeTool(ctx, 'get_event', { event_id: id })).success).toBe(true);
    await executeTool(ctx, 'ask_user', { question: `${LESSON} в 10:30. Оставить так?`, options: ['10:30', 'Нет'] });
    expect(question).toBe(`${LESSON} в 12:30. Оставить так?`);
    // The user must not confirm 10:30 under a question that now says 12:30.
    expect(buttons).toEqual(['12:30', 'Нет', 'Отмена']);
  });

  test('an ask_user confirmation after search_events is sent with local times', async () => {
    const ids = tuesdayLessons.map((clock) => createEvent(LESSON, clock.startUtc, clock.endUtc!).id);
    const question = utcDeleteQuestion.replace(/\(id (\d+)\)/g, (_m, n: string) => `(id ${ids[Number(n) - 11]})`);
    const expected = localDeleteQuestion.replace(/\(id (\d+)\)/g, (_m, n: string) => `(id ${ids[Number(n) - 11]})`);

    expect((await executeTool(ctx, 'search_events', { query: LESSON })).success).toBe(true);
    const asked = await executeTool(ctx, 'ask_user', { question, options: ['Да', 'Нет'] });

    expect(asked.success).toBe(true);
    expect(askedQuestions).toEqual([expected]);
    expect(asked.agentHint).toContain(expected);
  });
});
