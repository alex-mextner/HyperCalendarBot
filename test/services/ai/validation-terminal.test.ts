import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { BirthdayMetadataRepository } from '../../../src/database/repositories/birthday-metadata.repository.ts';
import { CalendarProposalRepository } from '../../../src/database/repositories/calendar-proposal.repository.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { SecretaryRepository } from '../../../src/database/repositories/secretary.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { UserMemoryRepository } from '../../../src/database/repositories/user-memory.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CreateUserData } from '../../../src/database/types.ts';
import { aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { unverifiedResponseNotice } from '../../../src/services/ai/response-validator.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { _resetToolThrottleForTest } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { BirthdayService } from '../../../src/services/birthday/birthday-service.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

function buildContext(
  db: Database,
  user: CreateUserData,
  messageText: string,
  retryEnqueue: AgentContext['retryEnqueue'],
): AgentContext {
  const userRepo = new UserRepository(db);
  const chatHistory = new ChatHistoryRepository(db);
  return {
    user: userRepo.create(user),
    chatId: user.telegram_id,
    messageText,
    isGroup: false,
    inputMode: 'text',
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    eventReminderRepo: new EventReminderRepository(db),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    conversationLogger: new ConversationLogger(chatHistory),
    userRepo,
    retryEnqueue,
  };
}

type Round = { text: string; tool?: { name: string; input: { [key: string]: unknown } }; error?: Error };
const UNSUPPORTED = 'Nothing else scheduled today.';
const INITIAL = 'There are two invented events today.';

/** A scripted verdict, or one computed from what the validator was shown. */
type Verdict = string | Error | ((validatorInput: string) => string);

function scripted(rounds: Round[], verdicts: Verdict[]) {
  let roundIndex = 0;
  let verdictIndex = 0;
  const counts = { model: 0, validator: 0 };
  const impl = async (options: StreamRoundOptions, callbacks: StreamCallbacks = {}): Promise<StreamRoundResult> => {
    const system = options.messages[0];
    if (typeof system?.content === 'string' && system.content.includes('strict QA validator')) {
      counts.validator++;
      const scriptedVerdict = verdicts[verdictIndex++];
      if (scriptedVerdict instanceof Error) throw scriptedVerdict;
      if (scriptedVerdict === undefined) throw new Error('Missing scripted verdict');
      const shown = options.messages[1]?.content;
      const verdict =
        typeof scriptedVerdict === 'function'
          ? scriptedVerdict(typeof shown === 'string' ? shown : '')
          : scriptedVerdict;
      return {
        text: verdict,
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: verdict },
        providerUsed: 'synthetic-validator',
      };
    }
    counts.model++;
    const round = rounds[roundIndex++];
    if (!round) throw new Error('Missing scripted round');
    callbacks.onTextDelta?.(round.text);
    if (round.error) throw round.error;
    const toolCalls = round.tool
      ? [{ id: `call-${roundIndex}`, name: round.tool.name, arguments: JSON.stringify(round.tool.input) }]
      : [];
    if (round.tool) callbacks.onToolCallStart?.(round.tool.name);
    return {
      text: round.text,
      toolCalls,
      finishReason: round.tool ? 'tool_calls' : 'stop',
      assistantMessage: {
        role: 'assistant',
        content: round.text || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      },
      providerUsed: 'synthetic-agent',
    };
  };
  return { impl, counts };
}

describe('validation rejection is terminal for unverified prose (#284)', () => {
  let db: Database;
  let ctx: AgentContext;
  let delivered: string[];
  let sender: TelegramSender;
  const enqueue = mock(async () => true);

  beforeEach(() => {
    _resetToolThrottleForTest();
    aiFailureNotices.reset();
    enqueue.mockClear();
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    // No day word: scripted writes use arbitrary dates the weekday guard would reject after "today".
    ctx = buildContext(db, { telegram_id: 456, timezone: 'UTC', language: 'en' }, 'Show my events', enqueue);
    delivered = [];
    sender = {
      sendMessage: async (_chatId, text) => {
        delivered.push(text);
        return { message_id: 42 };
      },
      editMessageText: async (_chatId, _messageId, text) => {
        delivered.push(text);
      },
    };
  });

  afterEach(() => db.close());

  function expectNoRejectedProse(response: string) {
    expect(response).not.toContain(UNSUPPORTED);
    expect(JSON.stringify(ctx.chatHistory.getRecent(ctx.user.telegram_id))).not.toContain(UNSUPPORTED);
    expect(delivered.at(-1)).not.toContain(UNSUPPORTED);
    expect(enqueue).not.toHaveBeenCalled();
  }

  test.each(['en', 'ru'])('twice-rejected %s answer is replaced in delivery and history', async (language) => {
    ctx.user.language = language;
    const script = scripted([{ text: INITIAL }, { text: UNSUPPORTED }], ['REJECT: no evidence', 'REJECT: no evidence']);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);
    expectNoRejectedProse(result.responseText);
    expect(result.responseText).toBe(unverifiedResponseNotice(language, 'UTC', []));
    expect(result.metrics?.termination).toBe('unverified');
    expect(JSON.stringify(ctx.chatHistory.getRecent(ctx.user.telegram_id))).toContain(
      unverifiedResponseNotice(language, 'UTC', []),
    );
    expect(script.counts.model).toBe(2);
  });

  test('confirmed write survives rejected narration and is not replayed', async () => {
    const script = scripted(
      [
        {
          text: '',
          tool: {
            name: 'create_event',
            input: { title: 'Synthetic evidence test', start_at: '2030-01-01T12:00:00Z' },
          },
        },
        { text: UNSUPPORTED },
        { text: UNSUPPORTED },
      ],
      [],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);
    expectNoRejectedProse(result.responseText);
    expect(result.responseText).toContain('Completed:');
    expect(result.toolCalls.filter((call) => call.name === 'create_event')).toHaveLength(1);
    expect(result.toolResults[0]?.success).toBe(true);
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get();
    expect(count?.n).toBe(1);
  });

  test('approved retry is retained instead of replaced by an apology', async () => {
    const answer = 'Which date should I check?';
    const script = scripted([{ text: INITIAL }, { text: answer }], ['REJECT: no evidence', 'APPROVE']);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);
    expect(result.responseText).toBe(answer);
    expect(JSON.stringify(ctx.chatHistory.getRecent(ctx.user.telegram_id))).toContain(answer);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('retry provider error does not enqueue the original request for explanation repair', async () => {
    const script = scripted(
      [{ text: INITIAL }, { text: UNSUPPORTED, error: new Error('Synthetic retry outage') }],
      ['REJECT: no evidence'],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);
    expectNoRejectedProse(result.responseText);
    expect(result.responseText).toBe(unverifiedResponseNotice('en', 'UTC', []));
  });

  test('early stop cannot bypass the outstanding rejection', async () => {
    const script = scripted(
      [{ text: INITIAL }, { text: UNSUPPORTED, tool: { name: 'end_conversation', input: {} } }],
      ['REJECT: no evidence'],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);
    expectNoRejectedProse(result.responseText);
    expect(result.responseText).toBe(unverifiedResponseNotice('en', 'UTC', []));
  });
  test('quiet implicit repair failure does not speak or erase an outstanding notice', async () => {
    ctx.wasExplicitInvocation = false;
    aiFailureNotices.decide(ctx.user.telegram_id, 'en', { hardOutage: false, willRetry: true, isRetryAttempt: false });
    const script = scripted(
      [{ text: INITIAL }, { text: UNSUPPORTED, error: new Error('Synthetic repair outage') }],
      ['REJECT: no evidence'],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);
    expect(result.responseText).toBe('');
    expect(result.metrics?.termination).toBe('error');
    expect(JSON.stringify(ctx.chatHistory.getRecent(ctx.user.telegram_id))).not.toContain(
      unverifiedResponseNotice('en', 'UTC', []),
    );
    expect(JSON.stringify(ctx.chatHistory.getRecent(ctx.user.telegram_id))).not.toContain(UNSUPPORTED);
    expect(aiFailureNotices.takeNotice(ctx.user.telegram_id)).toBe('stall');
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('ordinary write confirmation still uses zero validator calls', async () => {
    const script = scripted(
      [
        {
          text: '',
          tool: { name: 'create_event', input: { title: 'Synthetic fast path', start_at: '2035-01-01T12:00:00Z' } },
        },
        { text: 'Created the event.' },
      ],
      [new Error('Validator must not be called')],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);
    expect(result.responseText).toBe('Created the event.');
    expect(script.counts).toEqual({ model: 2, validator: 0 });
  });

  test('validator outage after repair read stays bounded and is not approved', async () => {
    const script = scripted(
      [
        { text: INITIAL },
        { text: '', tool: { name: 'get_events', input: { start_date: '2035-01-01', end_date: '2035-01-01' } } },
        { text: 'No events in the requested interval.' },
      ],
      ['REJECT: no evidence', new Error('Synthetic validator outage')],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);
    expect(result.responseText).toBe(unverifiedResponseNotice('en', 'UTC', []));
    expect(script.counts).toEqual({ model: 3, validator: 2 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// Anonymized from production turns on 2026-09-27: the first draft was rejected,
// the retry read the calendar and answered from those reads, and the LLM
// re-validation (which saw only tool names) rejected the correct answer anyway.
describe('re-validation accepts answers grounded in the same run (#492)', () => {
  const LESSON = 'Английский с Томом';
  let db: Database;
  let ctx: AgentContext;
  let delivered: string[];
  let sender: TelegramSender;
  const enqueue = mock(async () => true);
  const eventIds: { [key: string]: number } = {};

  function addEvent(key: string, title: string, start: string, end: string, description?: string) {
    const repo = new EventRepository(db);
    const event = repo.create({
      user_id: ctx.user.telegram_id,
      title,
      start_at: start,
      end_at: end,
      timezone: 'Europe/Belgrade',
      description,
    });
    eventIds[key] = event.id;
  }

  function setUp(now: string, messageText: string) {
    setSystemTime(new Date(now));
    ctx = buildContext(db, { telegram_id: 777, timezone: 'Europe/Belgrade', language: 'ru' }, messageText, enqueue);
  }

  function history(): string {
    return JSON.stringify(ctx.chatHistory.getRecent(ctx.user.telegram_id));
  }

  beforeEach(() => {
    _resetToolThrottleForTest();
    aiFailureNotices.reset();
    enqueue.mockClear();
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    delivered = [];
    sender = {
      sendMessage: async (_chatId, text) => {
        delivered.push(text);
        return { message_id: 42 };
      },
      editMessageText: async (_chatId, _messageId, text) => {
        delivered.push(text);
      },
    };
  });

  afterEach(() => {
    setSystemTime();
    db.close();
  });

  /** Sunday 2026-09-27, 23:00 in Belgrade (UTC+2): the lessons are stored in UTC. */
  function seedLessons() {
    setUp('2026-09-27T21:00:00Z', 'А английский когда?');
    addEvent('pastLesson', 'Английский', '2026-08-27T10:30:00Z', '2026-08-27T11:30:00Z');
    addEvent('today', LESSON, '2026-09-27T10:30:00Z', '2026-09-27T11:30:00Z');
    addEvent('errand', 'Отвезти посылку', '2026-09-28T18:30:00Z', '2026-09-28T19:30:00Z');
    addEvent('tuesday', LESSON, '2026-09-29T10:30:00Z', '2026-09-29T11:30:00Z');
    addEvent('tuesdayLater', 'Английский', '2026-09-29T11:30:00Z', '2026-09-29T12:30:00Z');
  }

  /** The retry's real tool sequence, including the two failing conversions. */
  function lessonReads(): Round[] {
    return [
      { text: '', tool: { name: 'search_events', input: { query: 'Английский', scope: 'personal' } } },
      { text: '', tool: { name: 'calculate', input: { expression: '2026-09-29 10:30 Europe/Belgrade to UTC' } } },
      {
        text: '',
        tool: {
          name: 'get_events',
          input: { start_date: '2026-09-28T00:00:00.000Z', end_date: '2026-09-28T23:59:59.999Z', scope: 'personal' },
        },
      },
      { text: '', tool: { name: 'calculate', input: { expression: '2026-09-27 10:30 UTC to Europe/Belgrade' } } },
      { text: '', tool: { name: 'calculate', input: { expression: '2026-09-27 10:30 UTC to Europe/Belgrade' } } },
      {
        text: '',
        tool: {
          name: 'get_events',
          input: { start_date: '2026-09-27T00:00:00.000Z', end_date: '2026-10-05T23:59:59.999Z', scope: 'personal' },
        },
      },
    ];
  }

  const TOOL_LESS_DRAFT = `Следующее занятие — во вторник, 29 сентября, 12:30 («${LESSON}»).`;

  test('lesson answer backed by search_events + get_events is delivered, not replaced', async () => {
    seedLessons();
    const answer = [
      `**${LESSON}**`,
      '- **Сегодня, 27 сентября** — 10:30 – 11:30 (UTC) → 12:30 – 13:30 по вашему времени (Europe/Belgrade).',
      '- **Завтра, 28 сентября** — урок отсутствует.',
      '- **29 сентября** — 10:30 – 11:30 (UTC) → 12:30 – 13:30 (Europe/Belgrade) и ещё один «Английский» в 13:30 – 14:30 (Europe/Belgrade).',
      'Итого, на завтра (28 сентября) уроков английского нет. Если хотите перенести одно из будущих занятий на завтра, дайте знать, и я создам/перенесу событие.',
    ].join('\n');
    const script = scripted(
      [{ text: TOOL_LESS_DRAFT }, ...lessonReads(), { text: answer }],
      [
        'REJECT: Assistant gave calendar details without calling a tool.',
        "REJECT: The assistant claims facts about the user's calendar, events, free slots, reminders, holidays, contacts, or settings without calling the matching tool.",
      ],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toBe(answer);
    expect(result.metrics?.termination).not.toBe('unverified');
    expect(history()).toContain('урок отсутствует');
    expect(script.counts.validator).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('participation answer quoting the get_event result is delivered', async () => {
    setUp('2026-09-27T11:34:37Z', 'Добавь меня тоже во встречу, а то меня в ней нет.');
    addEvent('meeting', 'Встреча', '2026-09-27T13:00:00Z', '2026-09-27T14:00:00Z', 'Оля, Петя, Катя, Гоша');
    const answer =
      'Событие уже включает вас: в описании указано «Гоша», а как создатель встречи вы автоматически являетесь её участником. Если хотите добавить ещё кого‑то — дайте знать!';
    const script = scripted(
      [
        { text: 'Вы уже участвуете в этой встрече — ваше имя уже указано в описании.' },
        { text: '', tool: { name: 'get_event', input: { event_id: eventIds.meeting } } },
        { text: answer },
      ],
      ['REJECT: event details without a tool call', 'REJECT: claims participation without evidence'],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toBe(answer);
    expect(history()).toContain('«Гоша»');
    expect(script.counts.validator).toBe(1);
  });

  test('a time the reads never returned is still rejected, and the notice shows what the reads found', async () => {
    seedLessons();
    const invented = `${LESSON} — в среду, 30 сентября, в 15:00.`;
    const script = scripted(
      [{ text: TOOL_LESS_DRAFT }, ...lessonReads(), { text: invented }],
      ['REJECT: calendar details without a tool call', 'REJECT: 15:00 is not in the tool results'],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(script.counts.validator).toBe(2);
    expect(result.metrics?.termination).toBe('unverified');
    expect(result.responseText).not.toContain('15:00');
    expect(history()).not.toContain('15:00');
    // Verified local times from the reads, never the stored UTC clock or a past lesson.
    expect(result.responseText).toMatch(/12:30\s+Английский с Томом/);
    expect(result.responseText).toMatch(/2026-09-28 20:30\s+Отвезти посылку/);
    expect(result.responseText).toMatch(/2026-09-29 12:30\s+Английский с Томом/);
    expect(result.responseText).toMatch(/2026-09-29 13:30\s+Английский/);
    expect(result.responseText).not.toContain('10:30');
    expect(result.responseText).not.toContain('2026-08-27');
    expect(history()).toMatch(/2026-09-29 12:30\s+Английский с Томом/);
  });

  test('a completed-write claim backed only by reads still goes to the validator and is blocked', async () => {
    seedLessons();
    const claim = `Удалил «${LESSON}» 29 сентября в 12:30.`;
    const script = scripted(
      [{ text: TOOL_LESS_DRAFT }, ...lessonReads(), { text: claim }],
      ['REJECT: calendar details without a tool call', 'REJECT: claims a deletion without delete_event'],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(script.counts.validator).toBe(2);
    expect(result.responseText).not.toContain('Удалил');
    expect(history()).not.toContain('Удалил');
    const remaining = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events').get();
    expect(remaining?.n).toBe(5);
  });

  // #515, anonymized from 2026-09-27 21:15Z: after the week-plan fast path, the
  // supplement read 27.09–04.10 and 27.09–30.09, then called 22.09 free.
  function weekReads(): Round[] {
    return [
      {
        text: '',
        tool: {
          name: 'get_events',
          input: { start_date: '2026-09-27T00:00:00.000Z', end_date: '2026-10-04T23:59:59.999Z', scope: 'personal' },
        },
      },
      {
        text: '',
        tool: {
          name: 'get_events',
          input: { start_date: '2026-09-27T00:00:00.000Z', end_date: '2026-09-30T23:59:59.999Z', scope: 'personal' },
        },
      },
    ];
  }

  function seedWeekPlan(supplement: boolean) {
    seedLessons();
    ctx.messageText = 'План на неделю';
    addEvent('concert', 'Концерт', '2026-09-22T16:30:00Z', '2026-09-22T18:30:00Z');
    if (supplement) {
      ctx.supplementMode = true;
      ctx.supplementAutoResponse = `2026-09-22 18:30  Концерт\n12:30  ${LESSON}`;
    }
  }

  test('a supplement calling a day free that its reads never covered is dropped (#515)', async () => {
    seedWeekPlan(true);
    const script = scripted([...weekReads(), { text: '**Вторник 22 сентября** – свободный весь день' }], []);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toBe('');
    expect(script.counts.validator).toBe(0);
  });

  test('a supplement calling tomorrow free without any read is dropped (#515)', async () => {
    seedWeekPlan(true);
    const script = scripted([{ text: '28 сентября – свободный весь день' }], []);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toBe('');
    expect(script.counts.validator).toBe(0);
  });

  test('a dropped supplement still reports the calendar change it made (#515)', async () => {
    seedWeekPlan(true);
    const script = scripted(
      [
        { text: '', tool: { name: 'create_event', input: { title: 'Пробежка', start_at: '2026-09-30T05:00:00Z' } } },
        { text: 'Добавил пробежку. Вторник 22 сентября – свободный весь день.' },
      ],
      [],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toContain('Выполнено: Создание события');
    expect(result.responseText).not.toContain('22 сентября');
    expect(script.counts.validator).toBe(0);
    const created = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE title = 'Пробежка'").get();
    expect(created?.n).toBe(1);
  });

  test('a supplement that fails after a write still reports the change (#515)', async () => {
    seedWeekPlan(true);
    const script = scripted(
      [
        { text: '', tool: { name: 'create_event', input: { title: 'Пробежка', start_at: '2026-09-30T05:00:00Z' } } },
        { text: '', error: new Error('Synthetic supplement outage') },
      ],
      [],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toContain('Выполнено: Создание события');
    const created = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE title = 'Пробежка'").get();
    expect(created?.n).toBe(1);
  });

  test('a supplement whose write needs a receipt reports it instead of going silent (#515)', async () => {
    seedWeekPlan(true);
    const script = scripted(
      [
        { text: '', tool: { name: 'create_event', input: { title: 'Пробежка', start_at: '2026-09-30T05:00:00Z' } } },
        { text: '', tool: { name: 'delete_event', input: { event_id: 999_999 } } },
        { text: 'Добавил пробежку.' },
      ],
      [],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toContain('Выполнено: Создание события');
    expect(result.responseText).toContain('Не выполнено: Удаление события');
  });

  test('a supplement backed by its own reads is still delivered (#515)', async () => {
    seedWeekPlan(true);
    const text = 'Во вторник, 29 сентября, в 12:30 и 13:30 — английский.';
    const script = scripted([...weekReads(), { text }], []);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toBe(text);
    expect(script.counts.validator).toBe(0);
  });

  test('a first answer whose days and times the reads cover ships with zero validator calls (#515)', async () => {
    seedWeekPlan(false);
    const text = `Вторник, 29 сентября: 12:30 «${LESSON}», 13:30 «Английский». 30 сентября свободно.`;
    const script = scripted([...weekReads(), { text }], []);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toBe(text);
    expect(script.counts.validator).toBe(0);
  });

  test('a first answer naming a day no read covered is validated instead of shipped (#515)', async () => {
    seedWeekPlan(false);
    const grounded = '22 сентября в 18:30 — «Концерт».';
    const script = scripted(
      [
        ...weekReads(),
        { text: 'Вторник 22 сентября – свободный весь день.' },
        { text: '', tool: { name: 'get_events', input: { start_date: '2026-09-22', end_date: '2026-09-22' } } },
        { text: grounded },
      ],
      ['REJECT: 22 September was not read'],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(script.counts.validator).toBe(1);
    expect(result.responseText).toBe(grounded);
    expect(history()).not.toContain('свободный весь день');
  });

  test('a first answer calling tomorrow empty after reading other days is validated (#515)', async () => {
    seedWeekPlan(false);
    const grounded = '28 сентября в 20:30 — «Отвезти посылку».';
    const script = scripted(
      [
        { text: '', tool: { name: 'get_events', input: { start_date: '2026-09-29', end_date: '2026-09-30' } } },
        { text: 'Завтра, 28 сентября, ничего не запланировано.' },
        { text: '', tool: { name: 'get_events', input: { start_date: '2026-09-28', end_date: '2026-09-28' } } },
        { text: grounded },
      ],
      ['REJECT: 28 September was not read'],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(script.counts.validator).toBe(1);
    expect(result.responseText).toBe(grounded);
    expect(history()).not.toContain('ничего не запланировано');
  });
});

// Anonymized from the production turn of 2026-09-29: asked what the bot knows
// about them, the user got a true answer built from the prompt's profile and
// saved facts. The validator was never shown those, rejected the answer and its
// retry as unsupported personal data, and the user got a calendar dead end.
describe('answers about the user are checked against the profile the agent saw (#740)', () => {
  const USER_ID = 789;
  const FACTS = ['Играю на виолончели в оркестре', 'Аллергия на орехи'];
  let db: Database;
  let delivered: string[];
  let sender: TelegramSender;

  beforeEach(() => {
    _resetToolThrottleForTest();
    aiFailureNotices.reset();
    setSystemTime(new Date('2026-09-29T15:41:18Z'));
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    delivered = [];
    sender = {
      sendMessage: async (_chatId, text) => {
        delivered.push(text);
        return { message_id: 42 };
      },
      editMessageText: async (_chatId, _messageId, text) => {
        delivered.push(text);
      },
    };
  });

  afterEach(() => {
    setSystemTime();
    db.close();
  });

  function profileContext(language: 'en' | 'ru', messageText: string): AgentContext {
    const user = { telegram_id: USER_ID, first_name: 'Мира', timezone: 'Europe/Lisbon', language };
    const ctx = buildContext(
      db,
      user,
      messageText,
      mock(async () => true),
    );
    const userMemoryRepo = new UserMemoryRepository(db);
    for (const fact of FACTS) userMemoryRepo.append(USER_ID, fact);
    const birthdayService = new BirthdayService(
      new EventRepository(db),
      new BirthdayMetadataRepository(db),
      new EventReminderRepository(db),
      new NotificationPreferencesRepository(db),
    );
    ctx.birthday = { birthdayService, userMemoryRepo };
    return ctx;
  }

  /** A validator can confirm a fact about the user only when its input shows that fact. */
  function approvesShownProfile(validatorInput: string): string {
    const shown = ['Мира', 'Europe/Lisbon', ...FACTS].every((fact) => validatorInput.includes(fact));
    return shown ? 'APPROVE' : 'REJECT: personal data without calling calendar tools';
  }

  /** Reject when the response mentions a user fact absent from the profile. */
  function rejectsFabricatedFacts(validatorInput: string): string {
    const profileMatch = validatorInput.match(/<user_profile>\n([\s\S]*?)\n<\/user_profile>/);
    const profile = profileMatch?.[1] ?? '';
    const responseMatch = validatorInput.match(/<assistant_response>\n([\s\S]*?)\n<\/assistant_response>/);
    const response = responseMatch?.[1] ?? '';
    // "пианино" / "piano" is a fabricated fact not in FACTS or the profile
    if (
      (response.includes('пианино') || response.toLowerCase().includes('piano')) &&
      !(profile.includes('пианино') || profile.toLowerCase().includes('piano'))
    ) {
      return 'REJECT: claimed user plays piano but this is not in <user_profile>';
    }
    return approvesShownProfile(validatorInput);
  }

  test.each([
    [
      'ru' as const,
      'А что ты знаешь обо мне',
      'Вот что я о тебе знаю, Мира: твой часовой пояс — Europe/Lisbon, язык — русский. Ещё я помню, что ты играешь на виолончели в оркестре и что у тебя аллергия на орехи.',
    ],
    [
      'en' as const,
      'what do you know about me',
      "Here's what I know about you, Mira: your timezone is Europe/Lisbon and you speak English. I also remember that you play the cello in an orchestra and that you're allergic to nuts.",
    ],
  ])('a tool-less %s answer drawn from the profile and saved facts reaches the user', async (language, question, answer) => {
    const ctx = profileContext(language, question);
    const script = scripted([{ text: answer }, { text: answer }], [approvesShownProfile, approvesShownProfile]);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toBe(answer);
    expect(result.responseText).not.toContain(unverifiedResponseNotice(language, 'Europe/Lisbon', []));
    expect(result.metrics?.termination).not.toBe('unverified');
    expect(delivered.at(-1)).toBe(answer);
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).toContain(answer);
    expect(script.counts).toEqual({ model: 1, validator: 1 });
  });

  test('a tool-less answer that fabricates a user fact is rejected and the user gets the unverified notice', async () => {
    const fabricatedAnswer =
      'Ты играешь на пианино и на виолончели. Твой часовой пояс — Europe/Lisbon, язык — русский.';
    const ctx = profileContext('ru', 'А что ты знаешь обо мне');
    const script = scripted(
      [{ text: fabricatedAnswer }, { text: fabricatedAnswer }],
      [rejectsFabricatedFacts, rejectsFabricatedFacts],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.metrics?.termination).toBe('unverified');
    expect(result.responseText).toContain(unverifiedResponseNotice('ru', 'Europe/Lisbon', []));
    expect(script.counts).toEqual({ model: 2, validator: 2 });
  });

  test('a long User Info does not hide the newest saved fact from the validator', async () => {
    const ctx = profileContext('ru', 'А что ты знаешь обо мне');
    // Saved facts that fill the prompt's memory budget, the newest one last.
    const userMemoryRepo = new UserMemoryRepository(db);
    for (let index = 0; index < 7; index++) userMemoryRepo.append(USER_ID, `Старый факт ${index}: ${'о'.repeat(230)}`);
    const newest = 'Учу португальский';
    userMemoryRepo.append(USER_ID, newest);
    // A secretary for many calendars and a long place name make User Info long.
    ctx.secretary = {
      secretaryRepo: new SecretaryRepository(db),
      secretaryForLine: Array.from({ length: 60 }, (_, index) => `Календарь ${index} (@owner${index})`).join(', '),
      calendarProposalRepo: new CalendarProposalRepository(db),
    };
    ctx.user.city = `Лиссабон, ${'район '.repeat(150)}`;
    const answer = 'Мира, я помню, что ты учишь португальский.';
    const approvesNewestFact = (validatorInput: string) =>
      validatorInput.includes(newest) ? 'APPROVE' : 'REJECT: personal data without calling calendar tools';
    const script = scripted([{ text: answer }, { text: answer }], [approvesNewestFact, approvesNewestFact]);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toBe(answer);
    expect(result.metrics?.termination).not.toBe('unverified');
    expect(script.counts).toEqual({ model: 1, validator: 1 });
  });

  test('the re-validation after a retry sees a fact the retry just saved', async () => {
    const newFact = 'Учу португальский';
    const ctx = profileContext('ru', 'Запомни, что я учу португальский, и скажи, что ты обо мне знаешь');
    const answer = 'Запомнил: ты учишь португальский. Ещё я знаю, что ты играешь на виолончели в оркестре.';
    const approvesSavedFact = (validatorInput: string) =>
      validatorInput.includes(newFact) ? 'APPROVE' : 'REJECT: claims a fact about the user that is not saved';
    const script = scripted(
      [
        { text: answer },
        { text: '', tool: { name: 'remember_user_fact', input: { type: 'append', content: newFact } } },
        { text: answer },
      ],
      [approvesSavedFact, approvesSavedFact],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toBe(answer);
    expect(result.metrics?.termination).not.toBe('unverified');
    expect(script.counts).toEqual({ model: 3, validator: 2 });
  });

  // The real fast validator, shown a saved fact that names the event, approved these tool-less
  // answers in 8 runs of 8 each; without the profile it rejected them 8 of 8.
  test.each([
    ['По пятницам у меня репетиция оркестра в 19:00', 'В пятницу в 19:00 у тебя репетиция оркестра.'],
    ['По пятницам у меня репетиция оркестра', 'В пятницу у тебя репетиция оркестра.'],
  ])('a saved fact does not stand in for a calendar read: %s', async (savedEvent, answer) => {
    const ctx = profileContext('ru', 'Что у меня в пятницу?');
    new UserMemoryRepository(db).append(USER_ID, savedEvent);
    const approvesWhatTheProfileSays = (validatorInput: string) =>
      validatorInput.includes(savedEvent) ? 'APPROVE' : 'REJECT: calendar data without a read';
    const script = scripted(
      [{ text: answer }, { text: answer }],
      [approvesWhatTheProfileSays, approvesWhatTheProfileSays],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.metrics?.termination).toBe('unverified');
    expect(result.responseText).not.toContain(answer);
  });

  /** Approves only when the profile block the validator was shown holds `fact`. */
  function approvesWhenProfileShows(fact: string): (validatorInput: string) => string {
    return (validatorInput) => {
      const profile = validatorInput.match(/<user_profile>\n([\s\S]*?)\n<\/user_profile>/)?.[1] ?? '';
      return profile.includes(fact) ? 'APPROVE' : 'REJECT: personal data without calling calendar tools';
    };
  }

  // A clock time or a date is not the calendar: a saved fact or the zone's offset carries them too.
  test.each([
    ['Встаю в 7:30', 'Мира, я помню, что ты встаёшь в 7:30.', 'Встаю в 7:30'],
    ['Отпуск с 10 августа', 'Я помню, что у тебя отпуск с 10 августа.', 'Отпуск с 10 августа'],
    ['', 'Твой часовой пояс — Asia/Kolkata (UTC+5:30).', 'UTC+5:30'],
  ])('a tool-less answer about the user with a time or date is checked against the profile: %s %s', async (savedFact, answer, shownFact) => {
    const ctx = profileContext('ru', 'А что ты знаешь обо мне');
    ctx.user.timezone = 'Asia/Kolkata';
    if (savedFact) new UserMemoryRepository(db).append(USER_ID, savedFact);
    const approves = approvesWhenProfileShows(shownFact);
    const script = scripted([{ text: answer }, { text: answer }], [approves, approves]);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.responseText).toBe(answer);
    expect(result.metrics?.termination).not.toBe('unverified');
    expect(script.counts).toEqual({ model: 1, validator: 1 });
  });

  // With no day named, the calendar is still spoken of by a quoted title, an event id or the word itself.
  test.each([
    ['В твоём календаре есть репетиция оркестра.'],
    ['У тебя есть событие «Репетиция оркестра».'],
    ['Репетиция оркестра записана под id 42.'],
    ['На этой неделе у тебя репетиция оркестра.'],
    ['Каждую пятницу у тебя репетиция оркестра.'],
    ['У тебя есть событие: репетиция оркестра.'],
  ])('a saved fact does not stand in for a calendar read without a day: %s', async (answer) => {
    const savedEvent = 'По пятницам у меня репетиция оркестра';
    const ctx = profileContext('ru', 'Что у меня в календаре?');
    new UserMemoryRepository(db).append(USER_ID, savedEvent);
    const approves = approvesWhenProfileShows(savedEvent);
    const script = scripted([{ text: answer }, { text: answer }], [approves, approves]);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.metrics?.termination).toBe('unverified');
    expect(result.responseText).not.toContain(answer);
  });

  // The question names the day, a date or a part of one, so an answer that drops it still speaks
  // of the calendar.
  test.each([
    ['Что у меня в пятницу?', 'По пятницам у меня репетиция оркестра в 19:00', 'У тебя репетиция оркестра в 19:00.'],
    ['Что у меня в пятницу?', 'По пятницам у меня репетиция оркестра в 19:00', 'Репетиция оркестра в 19:00.'],
    ['Что у меня вечером?', 'По вечерам у меня репетиция в 19:00', 'В 19:00 у тебя репетиция.'],
    ['Что у меня 10 августа?', '10 августа у меня репетиция оркестра', '10 августа у тебя репетиция оркестра.'],
  ])('a saved fact does not answer a question about a day: %s → %s', async (question, savedEvent, answer) => {
    const ctx = profileContext('ru', question);
    new UserMemoryRepository(db).append(USER_ID, savedEvent);
    const approves = approvesWhenProfileShows(savedEvent);
    const script = scripted([{ text: answer }, { text: answer }], [approves, approves]);
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);

    expect(result.metrics?.termination).toBe('unverified');
    expect(result.responseText).not.toContain(answer);
  });
});
