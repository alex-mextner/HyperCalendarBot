/**
 * A deploy restart must not swallow a turn that is still streaming: every
 * in-flight run is aborted into its normal failure path (notice, durable retry
 * or write evidence, debug log) before the process closes its queues and DB.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { AGENT_DRAIN_SETTLE_MS, aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { AiDebugLogger } from '../../../src/services/ai/debug-logger.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import type { AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

const USER_ID = 716_000_001;
const REQUEST = 'Завтра в 20:30 отвезти переноску';
// Bounds the abort phase only; a drain that never settles fails the test by its timeout.
const DRAIN_BOUND_MS = 2_000;

/** Round 1 calls one tool; round 2 never answers — the provider is still streaming at shutdown. */
function stalledAfterTool(tool: { name: string; input: { [key: string]: unknown } }) {
  const secondRound = Promise.withResolvers<void>();
  const impl = async (opts: StreamRoundOptions, _cbs?: StreamCallbacks): Promise<StreamRoundResult> => {
    const toolRoundDone = opts.messages.some((message) => message.role === 'tool');
    if (!toolRoundDone) {
      const call = { id: 'call-1', name: tool.name, arguments: JSON.stringify(tool.input) };
      return {
        text: '',
        toolCalls: [call],
        finishReason: 'tool_calls',
        assistantMessage: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }],
        },
        providerUsed: 'mock',
      };
    }
    secondRound.resolve();
    return Promise.withResolvers<StreamRoundResult>().promise;
  };
  return { impl, secondRoundStarted: secondRound.promise };
}

function makeSender() {
  const delivered: string[] = [];
  const deleted: number[] = [];
  const sender: TelegramSender = {
    sendMessage: mock((_chatId: number, text: string) => {
      delivered.push(text);
      return Promise.resolve({ message_id: 42 });
    }),
    editMessageText: mock((_chatId: number, _messageId: number, text: string) => {
      delivered.push(text);
      return Promise.resolve();
    }),
    deleteMessage: mock((_chatId: number, messageId: number) => {
      deleted.push(messageId);
      return Promise.resolve();
    }),
  };
  return { sender, delivered, deleted };
}

describe('agent drain on shutdown', () => {
  let ctx: AgentContext;
  let eventRepo: EventRepository;
  let enqueued: string[];
  let logsDir: string;

  beforeEach(() => {
    // Sunday evening in Belgrade, the moment a release replaced the container.
    setSystemTime(new Date('2026-09-27T17:12:38Z'));
    aiFailureNotices.reset();
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    const chatHistory = new ChatHistoryRepository(db);
    eventRepo = new EventRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'Europe/Belgrade', language: 'ru' });
    enqueued = [];
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: REQUEST,
      isGroup: false,
      eventService: new EventService({ eventRepo }),
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory,
      conversationLogger: new ConversationLogger(chatHistory),
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
      // The retry lives in Redis: it only counts once that write has completed,
      // which is at least one macrotask after the call.
      retryEnqueue: async (message: string) => {
        const stored = Promise.withResolvers<void>();
        setImmediate(stored.resolve);
        await stored.promise;
        enqueued.push(message);
        return true;
      },
    };
    chatHistory.save(USER_ID, 'user', REQUEST);
    logsDir = mkdtempSync(path.join(tmpdir(), 'agent-drain-'));
  });

  afterEach(() => {
    setSystemTime();
    rmSync(logsDir, { recursive: true, force: true });
  });

  test('a read-only turn still streaming at shutdown tells the user and queues its retry before drain resolves', async () => {
    const probe = makeSender();
    const { impl, secondRoundStarted } = stalledAfterTool({
      name: 'calculate',
      input: { expression: '2026-09-28 20:30 Europe/Belgrade to UTC' },
    });
    const agent = new CalendarBotAgent({}, probe.sender, { streamImpl: impl });

    const running = agent.run(ctx);
    await secondRoundStarted;

    await agent.drain(DRAIN_BOUND_MS);
    expect(enqueued).toEqual([REQUEST]);
    await running;
    expect(probe.delivered.join('\n')).toContain(t('ru').agent_restarting(true));
  });

  test('a turn with no retry route says the request was not done instead of blaming the AI', async () => {
    ctx.retryEnqueue = undefined;
    const probe = makeSender();
    const { impl, secondRoundStarted } = stalledAfterTool({
      name: 'calculate',
      input: { expression: '2026-09-28 20:30 Europe/Belgrade to UTC' },
    });
    const agent = new CalendarBotAgent({}, probe.sender, { streamImpl: impl });

    const running = agent.run(ctx);
    await secondRoundStarted;
    await agent.drain(DRAIN_BOUND_MS);
    await running;

    const text = probe.delivered.join('\n');
    expect(text).toContain(t('ru').agent_restarting(false));
    expect(text).not.toContain(t('ru').ai_degraded);
  });

  test('a turn that already created the event reports it and is not replayed', async () => {
    const probe = makeSender();
    const { impl, secondRoundStarted } = stalledAfterTool({
      name: 'create_event',
      input: { title: 'Отвезти переноску', start_at: '2026-09-28T18:30:00Z', end_at: '2026-09-28T19:30:00Z' },
    });
    const agent = new CalendarBotAgent({}, probe.sender, { streamImpl: impl });

    const running = agent.run(ctx);
    await secondRoundStarted;
    await agent.drain(DRAIN_BOUND_MS);
    await running;

    const created = eventRepo.getInRange(USER_ID, '2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z');
    expect(created.map((event) => event.title)).toEqual(['Отвезти переноску']);
    expect(enqueued).toEqual([]);
    const text = probe.delivered.join('\n');
    expect(text).toContain(t('ru').writeOutcomes.interrupted);
    expect(text).not.toContain(t('ru').agent_restarting(true));
  });

  test('the aborted turn leaves its debug chat log on disk', async () => {
    const probe = makeSender();
    const { impl, secondRoundStarted } = stalledAfterTool({
      name: 'calculate',
      input: { expression: '2026-09-28 20:30 Europe/Belgrade to UTC' },
    });
    const debugLogger = new AiDebugLogger(true, logsDir);
    const agent = new CalendarBotAgent({ debugLogger }, probe.sender, { streamImpl: impl });

    const running = agent.run(ctx);
    await secondRoundStarted;
    await agent.drain(DRAIN_BOUND_MS);
    await running;

    const chatDir = path.join(logsDir, 'chats', String(USER_ID));
    const files = readdirSync(chatDir);
    expect(files).toHaveLength(1);
    const log = readFileSync(path.join(chatDir, files[0]!), 'utf8');
    expect(log).toContain(`MESSAGE: ${REQUEST}`);
    expect(log).toContain('TOOL CALL: calculate');
    expect(log).toContain('## ROUND 2');
    expect(log).toContain('## FINAL');
  });

  test('a turn whose history write fails after the failure path still leaves its debug log', async () => {
    const probe = makeSender();
    const { impl, secondRoundStarted } = stalledAfterTool({
      name: 'calculate',
      input: { expression: '2026-09-28 20:30 Europe/Belgrade to UTC' },
    });
    const debugLogger = new AiDebugLogger(true, logsDir);
    const agent = new CalendarBotAgent({ debugLogger }, probe.sender, { streamImpl: impl });

    const running = agent.run(ctx);
    await secondRoundStarted;
    // The notice cannot be saved: the database went away under the turn.
    ctx.conversationLogger.logAiTurn = () => {
      throw new Error('database is closed');
    };
    await agent.drain(DRAIN_BOUND_MS);
    expect(
      await running.then(
        () => 'resolved',
        (err: unknown) => String(err),
      ),
    ).toContain('database is closed');

    const chatDir = path.join(logsDir, 'chats', String(USER_ID));
    const log = readFileSync(path.join(chatDir, readdirSync(chatDir)[0]!), 'utf8');
    expect(log).toContain('TOOL CALL: calculate');
    expect(log).toContain('## END — no FINAL logged for this turn');
  });

  test('a scheduled retry cut short by a restart is told so and queued again', async () => {
    ctx.retryAttempt = 1;
    const probe = makeSender();
    const { impl, secondRoundStarted } = stalledAfterTool({
      name: 'calculate',
      input: { expression: '2026-09-28 20:30 Europe/Belgrade to UTC' },
    });
    const agent = new CalendarBotAgent({}, probe.sender, { streamImpl: impl });

    const running = agent.run(ctx);
    await secondRoundStarted;
    await agent.drain(DRAIN_BOUND_MS);
    await running;

    expect(enqueued).toEqual([REQUEST]);
    expect(probe.delivered.join('\n')).toContain(t('ru').agent_restarting(true));
  });

  test('a retry whose budget is spent ends with the give-up line alone, not a restart notice on top', async () => {
    ctx.retryAttempt = 3;
    const giveUp = t('ru').agent_give_up(true);
    const probe = makeSender();
    // The last attempt: the pipeline sends its give-up line and schedules nothing.
    ctx.retryEnqueue = async () => {
      await probe.sender.sendMessage(USER_ID, giveUp);
      return false;
    };
    const { impl, secondRoundStarted } = stalledAfterTool({
      name: 'calculate',
      input: { expression: '2026-09-28 20:30 Europe/Belgrade to UTC' },
    });
    const agent = new CalendarBotAgent({}, probe.sender, { streamImpl: impl });

    const running = agent.run(ctx);
    await secondRoundStarted;
    await agent.drain(DRAIN_BOUND_MS);
    await running;

    const text = probe.delivered.join('\n');
    expect(text).toContain(giveUp);
    expect(text).not.toContain(t('ru').agent_restarting(true));
    expect(text).not.toContain(t('ru').agent_restarting(false));
    const history = JSON.stringify(ctx.chatHistory.getRecent(USER_ID));
    expect(history).not.toContain(t('ru').agent_restarting(false));
  });

  test('a debug log that cannot be opened never throws out of run()', async () => {
    const probe = makeSender();
    const { impl } = stalledAfterTool({ name: 'calculate', input: { expression: '1 + 1' } });
    const brokenLogger = new AiDebugLogger(true, logsDir);
    brokenLogger.createRunContext = () => {
      throw new Error('EACCES: logs directory is read-only');
    };
    const agent = new CalendarBotAgent({ debugLogger: brokenLogger }, probe.sender, { streamImpl: impl });

    let running: Promise<unknown> | undefined;
    expect(() => {
      running = agent.run(ctx);
    }).not.toThrow();
    await agent.drain(DRAIN_BOUND_MS);
    await running;
    expect(enqueued).toEqual([REQUEST]);
  });

  test('a run still stuck at the deadline is left behind and the drain returns', async () => {
    // The retry store never answers (Redis hung): the turn cannot finish its failure path.
    ctx.retryEnqueue = () => Promise.withResolvers<boolean>().promise;
    const probe = makeSender();
    const { impl, secondRoundStarted } = stalledAfterTool({ name: 'calculate', input: { expression: '1 + 1' } });
    const agent = new CalendarBotAgent({}, probe.sender, { streamImpl: impl });

    let settled = false;
    void agent.run(ctx).finally(() => {
      settled = true;
    });
    await secondRoundStarted;
    // A real deadline on purpose: this exercises drain's own timer.
    await agent.drain(20);

    expect(settled).toBe(false);
  });

  test('a turn whose retry store hangs still tells its user inside the production drain window', async () => {
    // Redis hung: the turn's own bound on the retry write must end before the drain gives up on it,
    // or the drain abandons exactly the failure path it exists to protect.
    ctx.retryEnqueue = () => Promise.withResolvers<boolean>().promise;
    const probe = makeSender();
    const { impl, secondRoundStarted } = stalledAfterTool({ name: 'calculate', input: { expression: '1 + 1' } });
    const agent = new CalendarBotAgent({}, probe.sender, { streamImpl: impl });

    let settled = false;
    const running = agent.run(ctx).finally(() => {
      settled = true;
    });
    await secondRoundStarted;
    await agent.drain(AGENT_DRAIN_SETTLE_MS);

    expect(settled).toBe(true);
    await running;
    expect(probe.delivered.join('\n')).toContain(t('ru').agent_restarting(false));
  }, 10_000);

  test('a second drain waits for a turn that started after the first one returned', async () => {
    const probe = makeSender();
    const { impl } = stalledAfterTool({ name: 'calculate', input: { expression: '1 + 1' } });
    const agent = new CalendarBotAgent({}, probe.sender, { streamImpl: impl });

    await agent.drain(DRAIN_BOUND_MS);
    // A handler that outlived bot.stop() starts its turn while the queues close.
    void agent.run(ctx);
    await agent.drain(DRAIN_BOUND_MS);

    expect(enqueued).toEqual([REQUEST]);
  });

  test('a turn that starts while the drain is waiting is waited for as well', async () => {
    const probe = makeSender();
    const { impl, secondRoundStarted } = stalledAfterTool({
      name: 'calculate',
      input: { expression: '2026-09-28 20:30 Europe/Belgrade to UTC' },
    });
    const agent = new CalendarBotAgent({}, probe.sender, { streamImpl: impl });
    const first = agent.run(ctx);
    await secondRoundStarted;

    const draining = agent.drain(DRAIN_BOUND_MS);
    // A queue job picked up mid-drain; its retry write is slower than the first one's.
    const late = agent.run({
      ...ctx,
      messageText: 'Поздний запрос',
      retryEnqueue: async (message: string) => {
        for (let gap = 0; gap < 5; gap++) {
          const tick = Promise.withResolvers<void>();
          setImmediate(tick.resolve);
          await tick.promise;
        }
        enqueued.push(message);
        return true;
      },
    });
    await draining;

    expect(enqueued.toSorted()).toEqual(['Поздний запрос', REQUEST].toSorted());
    await Promise.all([first, late]);
  });

  test('a turn that starts after the drain fails fast into the same retry path', async () => {
    const probe = makeSender();
    const { impl } = stalledAfterTool({ name: 'calculate', input: { expression: '1 + 1' } });
    const agent = new CalendarBotAgent({}, probe.sender, { streamImpl: impl });

    await agent.drain(DRAIN_BOUND_MS);
    await agent.run(ctx);

    expect(enqueued).toEqual([REQUEST]);
  });
});
