// Production path of the 2026-11-01 incident (prod bb7a9d47): the model calls a picture tool and the
// render takes longer than the whole turn budget. The real CalendarBotAgent runs the real tool executor
// and the real ImageDelivery over a scripted renderer and a fake Telegram sender (synthetic data only).
//
// Required behaviour: the turn ends with the text answer at once, the picture follows as its own
// message when the worker is done, a job that never finishes yields one honest note and one alert,
// and no render can block or fail the turn.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { _resetToolThrottleForTest } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { ImageDelivery } from '../../../src/services/image/image-delivery.ts';
import type { RenderOptions } from '../../../src/services/image/render-service.ts';
import {
  configureTimeoutReporter,
  TIMEOUT_ALERT_SOURCE,
  TimeoutReporter,
} from '../../../src/services/incident/timeout-reporter.ts';
import type { ImageRenderJob } from '../../../src/worker/image-render.queue.ts';
import { png } from '../../fixtures/png.ts';

const USER_ID = 7110;
const ANSWER = 'Синтетический ответ: завтра два события, всё в порядке.';

type Round = { text: string } | { tools: { name: string; input: { [key: string]: unknown } }[] };

/** One scripted model round per call; the response validator is always approved. */
function scripted(rounds: Round[]) {
  let index = 0;
  return async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}): Promise<StreamRoundResult> => {
    const system = opts.messages[0];
    if (typeof system?.content === 'string' && system.content.includes('strict QA validator')) {
      return {
        text: 'APPROVE',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: 'APPROVE' },
        providerUsed: 'mock-validator',
      };
    }
    const round = rounds[index++];
    if (!round) throw new Error(`Scripted stream ran out of rounds (call ${index})`);
    if ('text' in round) {
      cbs.onTextDelta?.(round.text);
      return {
        text: round.text,
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: round.text },
        providerUsed: 'mock',
      };
    }
    const toolCalls = round.tools.map((tool, i) => ({
      id: `call-${index}-${i}`,
      name: tool.name,
      arguments: JSON.stringify(tool.input),
    }));
    const assistantMessage: OpenAI.ChatCompletionMessageParam = {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
    return { text: '', toolCalls, finishReason: 'tool_calls', assistantMessage, providerUsed: 'mock' };
  };
}

interface Pending {
  job: ImageRenderJob;
  resolve(buffer: Buffer): void;
}

describe('picture tools never hold the agent turn', () => {
  let db: Database;
  let ctx: AgentContext;
  let sender: TelegramSender;
  let timeline: string[];
  let jobs: Pending[];
  let alerts: { text: string; source: string }[];
  let makeDelivery: (boundMs?: number) => ImageDelivery;

  beforeEach(() => {
    _resetToolThrottleForTest();
    aiFailureNotices.reset();
    alerts = [];
    configureTimeoutReporter(new TimeoutReporter((text, source) => alerts.push({ text, source })));
    db = new Database(':memory:');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    const chatHistory = new ChatHistoryRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'Europe/Belgrade', language: 'ru' });
    timeline = [];
    jobs = [];
    sender = {
      sendMessage: mock(async (_chatId: number, text: string) => {
        timeline.push(`text:${text}`);
        return { message_id: 42 };
      }),
      editMessageText: mock(async (_chatId: number, _messageId: number, text: string) => {
        timeline.push(`text:${text}`);
      }),
      deleteMessage: mock(async () => {}),
      sendPhoto: mock(async () => {
        timeline.push('photo');
        return { message_id: 90 };
      }),
      setReaction: async () => {},
      sendButtons: async () => ({ message_id: 43 }),
    };
    makeDelivery = (boundMs) =>
      new ImageDelivery({
        boundMs,
        renderer: {
          // A worker that is slower than the whole turn: it answers only when the test lets it.
          renderDirect: (job: ImageRenderJob, _options?: RenderOptions) =>
            new Promise<Buffer>((resolve) => jobs.push({ job, resolve })),
        },
      });
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'покажи завтра картинкой',
      isGroup: false,
      eventService: new EventService({ eventRepo: new EventRepository(db) }),
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory,
      conversationLogger: new ConversationLogger(chatHistory),
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
      incomingMessageId: 900,
      sender,
      imageDelivery: makeDelivery(),
    };
    chatHistory.save(USER_ID, 'user', ctx.messageText);
  });

  afterEach(() => {
    configureTimeoutReporter(null);
    db.close();
  });

  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const run = (rounds: Round[]) => new CalendarBotAgent({}, sender, { streamImpl: scripted(rounds) }).run(ctx);
  const dayImage = () => ({ name: 'render_day_image', input: { date: tomorrow() } });

  test('the turn ends with the text while the render is still running; the late picture follows the text', async () => {
    const result = await run([{ tools: [dayImage()] }, { text: ANSWER }]);

    // The turn is over, the user has the answer, and the worker has not finished: nothing waited for it.
    expect(result.responseText).toContain('два события');
    expect(timeline.filter((line) => line.startsWith('text:') && line.includes('два события'))).not.toHaveLength(0);
    expect(timeline).not.toContain('photo');
    expect(jobs).toHaveLength(1);

    // 80 s later (the overloaded odroid) the worker answers: the picture is its own message, after the text.
    jobs[0]!.resolve(png());
    await ctx.imageDelivery!.whenIdle();

    expect(timeline.at(-1)).toBe('photo');
    expect(timeline.filter((line) => line === 'photo')).toHaveLength(1);
    expect(timeline.findIndex((line) => line.includes('два события'))).toBeLessThan(timeline.indexOf('photo'));
    // Nothing the user saw claims the picture was already attached or sent.
    expect(timeline.join('\n')).not.toMatch(/прикреп|отправлена в чат/i);
    expect(alerts).toHaveLength(0);
  });

  test('the model is told honestly that the picture is only queued', async () => {
    const seen: string[] = [];
    const stream = scripted([{ tools: [dayImage()] }, { text: ANSWER }]);
    await new CalendarBotAgent({}, sender, {
      streamImpl: async (opts, cbs) => {
        for (const message of opts.messages) {
          if (message.role === 'tool') seen.push(String(message.content));
        }
        return stream(opts, cbs);
      },
    }).run(ctx);

    const toolMessage = seen.at(-1) ?? '';
    expect(toolMessage).toContain('готовится');
    expect(toolMessage).toContain('NOT sent yet');
    expect(toolMessage).toContain('do NOT say the picture was sent or attached');
    expect(toolMessage).not.toContain('отправлена в чат');
    jobs[0]!.resolve(png());
    await ctx.imageDelivery!.whenIdle();
  });

  test('a job that never finishes: the turn is untouched, the user gets one honest note and the repair flow one alert', async () => {
    ctx.imageDelivery = makeDelivery(40); // the real bound timer, shortened from 150 s; the renderer never answers
    const result = await run([{ tools: [dayImage()] }, { text: ANSWER }]);
    expect(result.responseText).toContain('два события');

    await ctx.imageDelivery.whenIdle();

    const notes = timeline.filter((line) => line.includes(t('ru').aiTools.meta.imageNoteTimedOut(tomorrow())));
    expect(notes).toHaveLength(1);
    expect(timeline).not.toContain('photo');
    expect(timeline.findIndex((line) => line.includes('два события'))).toBeLessThan(timeline.indexOf(notes[0]!));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.source).toBe(TIMEOUT_ALERT_SOURCE);
    expect(alerts[0]!.text).toContain('Timeout (render)');
    // The alert carries no user text.
    expect(alerts[0]!.text).not.toContain(tomorrow());
    expect(alerts[0]!.text).not.toContain('картинкой');
  });

  test('two different pictures in one turn are two deliveries; a third is refused honestly without failing the turn', async () => {
    const week = { name: 'render_week_image', input: { week_start: tomorrow() } };
    const month = { name: 'render_month_image', input: { month: tomorrow().slice(0, 7) } };
    const toolMessages: string[] = [];
    const stream = scripted([{ tools: [dayImage(), week, month] }, { text: ANSWER }]);
    const result = await new CalendarBotAgent({}, sender, {
      streamImpl: async (opts, cbs) => {
        for (const message of opts.messages) {
          if (message.role === 'tool') toolMessages.push(String(message.content));
        }
        return stream(opts, cbs);
      },
    }).run(ctx);

    expect(result.responseText).toContain('два события');
    expect(jobs).toHaveLength(2);
    expect(toolMessages.filter((message) => message.includes(t('ru').aiTools.meta.imageBusy))).toHaveLength(1);
    for (const pending of jobs) pending.resolve(png());
    await ctx.imageDelivery!.whenIdle();
    expect(timeline.filter((line) => line === 'photo')).toHaveLength(2);
  });

  test('the same picture requested twice in one chat is delivered once', async () => {
    await run([{ tools: [dayImage(), dayImage()] }, { text: ANSWER }]);
    expect(jobs).toHaveLength(1);
    jobs[0]!.resolve(png());
    await ctx.imageDelivery!.whenIdle();
    expect(timeline.filter((line) => line === 'photo')).toHaveLength(1);
  });

  test('a new message before the picture arrives gets its own answer; the picture still arrives once', async () => {
    await run([{ tools: [dayImage()] }, { text: ANSWER }]);
    expect(timeline).not.toContain('photo');

    ctx.chatHistory.save(USER_ID, 'user', 'спасибо');
    ctx.messageText = 'спасибо';
    ctx.incomingMessageId = 901;
    _resetToolThrottleForTest();
    await run([{ text: 'Пожалуйста!' }]);
    expect(timeline.some((line) => line.includes('Пожалуйста!'))).toBe(true);
    expect(timeline).not.toContain('photo');

    jobs[0]!.resolve(png());
    await ctx.imageDelivery!.whenIdle();
    expect(timeline.at(-1)).toBe('photo');
    expect(timeline.filter((line) => line === 'photo')).toHaveLength(1);
  });

  test('a render failure after the turn never turns into a failed run: the answer is the one the model wrote', async () => {
    ctx.imageDelivery = new ImageDelivery({
      renderer: { renderDirect: () => Promise.reject(new Error('synthetic worker crash')) },
    });
    const result = await run([{ tools: [dayImage()] }, { text: ANSWER }]);
    expect(result.responseText).toContain('два события');
    await ctx.imageDelivery.whenIdle();
    expect(timeline.filter((line) => line.includes(t('ru').aiTools.meta.imageNoteFailed(tomorrow())))).toHaveLength(1);
    expect(timeline.join('\n')).not.toContain('synthetic worker crash');
  });
});
