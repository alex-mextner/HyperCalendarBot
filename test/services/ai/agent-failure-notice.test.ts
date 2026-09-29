import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import OpenAI from 'openai';
import {
  EN_AGENT_ERROR_PHRASES,
  EN_AI_COMMANDS_HINT,
  RU_AGENT_ERROR_PHRASES,
  RU_AI_COMMANDS_HINT,
  t,
} from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { agentGiveUpMessage, aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import {
  AllProvidersFailedError,
  type StreamCallbacks,
  type StreamRoundOptions,
  type StreamRoundResult,
} from '../../../src/services/ai/streaming.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

const USER_ID = 771;

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

/** A stream impl that always throws the given error (every round, validator included). */
function failingStream(error: Error) {
  return async (_opts: StreamRoundOptions, _cbs?: StreamCallbacks): Promise<StreamRoundResult> => {
    throw error;
  };
}

/** A stream impl that answers with plain text — used for the "retry came back" path. */
function answeringStream(text: string) {
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
    cbs.onTextDelta?.(text);
    return {
      text,
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: text },
      providerUsed: 'mock',
    };
  };
}

/** Everything the sender mock records, so tests can assert on delivered text. */
interface SenderProbe {
  sender: TelegramSender;
  /** Every piece of text the user actually saw (sendMessage bodies + editMessageText bodies). */
  delivered: () => string[];
  deleted: () => number[];
}

function makeSenderProbe(): SenderProbe {
  const sent: string[] = [];
  const edited: string[] = [];
  const deleted: number[] = [];
  const sender: TelegramSender = {
    sendMessage: mock((_chatId: number, text: string) => {
      sent.push(text);
      return Promise.resolve({ message_id: 42 });
    }),
    editMessageText: mock((_chatId: number, _messageId: number, text: string) => {
      edited.push(text);
      return Promise.resolve();
    }),
    deleteMessage: mock((_chatId: number, messageId: number) => {
      deleted.push(messageId);
      return Promise.resolve();
    }),
  };
  return {
    sender,
    delivered: () => [...sent, ...edited],
    deleted: () => deleted,
  };
}

describe('agent failure notices', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let probe: SenderProbe;

  beforeEach(() => {
    aiFailureNotices.reset();
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'ru' });
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'что у меня завтра?',
      isGroup: false,
      eventService: new EventService({ eventRepo: new EventRepository(db) }),
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: chatHistoryRepo,
      conversationLogger: new ConversationLogger(chatHistoryRepo),
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
      retryEnqueue: async () => true,
    };
    config = {};
    probe = makeSenderProbe();
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
  });

  // ── Regression: the outage incident ──────────────────────────────────────

  test('hard outage (balance exhausted) → honest message with command hints, no comeback promise', async () => {
    const agent = new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('Insufficient balance for this request')),
    });

    await agent.run(ctx);

    const text = probe.delivered().join('\n');
    expect(text).toContain(t('ru').ai_degraded);
    expect(text).toContain(RU_AI_COMMANDS_HINT);
    // The lie: a stall phrase promises a comeback the bot cannot make.
    for (const phrase of RU_AGENT_ERROR_PHRASES) {
      expect(text).not.toContain(phrase);
    }
  });

  test('hard outage (auth revoked, 401) → honest message, no stall phrase', async () => {
    const authError = new OpenAI.AuthenticationError(401, undefined, 'Invalid API key', new Headers());
    const agent = new CalendarBotAgent(config, probe.sender, { streamImpl: failingStream(authError) });

    await agent.run(ctx);

    const text = probe.delivered().join('\n');
    expect(text).toContain(t('ru').ai_degraded);
    for (const phrase of RU_AGENT_ERROR_PHRASES) {
      expect(text).not.toContain(phrase);
    }
  });

  // Regression for the merge of the provider-failover work: the chain no longer
  // rethrows the last provider's error, it throws an aggregate. A fully dead chain
  // must still read as a hard outage, or the bot goes back to promising a comeback
  // in exactly the scenario that started this — every provider down, user gets a
  // cheerful "one second" and then silence.
  test('every provider dead → honest message, not a comeback promise', async () => {
    const dead = new AllProvidersFailedError([
      {
        provider: 'z.ai (glm-5.1)',
        providerId: 'zai',
        model: 'synthetic',
        status: 429,
        message: 'Weekly/Monthly Limit Exhausted',
        transient: false,
      },
      {
        provider: 'Groq (openai/gpt-oss-120b)',
        providerId: 'groq',
        model: 'synthetic',
        status: 404,
        message: 'model does not exist',
        transient: false,
      },
      {
        provider: 'Gemini (models/gemini-2.5-flash)',
        providerId: 'gemini',
        model: 'synthetic',
        status: 401,
        message: 'invalid key',
        transient: false,
      },
    ]);
    const agent = new CalendarBotAgent(config, probe.sender, { streamImpl: failingStream(dead) });

    await agent.run(ctx);

    const text = probe.delivered().join('\n');
    expect(text).toContain(t('ru').ai_degraded);
    expect(text).toContain(RU_AI_COMMANDS_HINT);
    for (const phrase of RU_AGENT_ERROR_PHRASES) {
      expect(text).not.toContain(phrase);
    }
  });

  // Adversarial version of the case above. The previous test passes even without a
  // fix, because the aggregate message happens to concatenate the words "Limit
  // Exhausted" and the legacy check substring-matches them. Strip every quota-ish
  // word and the accident disappears: a chain that is dead from deleted models and
  // rejected keys carries no such phrase anywhere.
  test('every provider dead with no quota wording → still an honest message', async () => {
    const dead = new AllProvidersFailedError([
      {
        provider: 'Groq (openai/gpt-oss-120b)',
        providerId: 'groq',
        model: 'synthetic',
        status: 404,
        message: 'model does not exist',
        transient: false,
      },
      {
        provider: 'HF (meta-llama/Llama-3.3-70B-Instruct)',
        providerId: 'hf',
        model: 'synthetic',
        status: 401,
        message: 'Invalid username or password.',
        transient: false,
      },
    ]);
    const agent = new CalendarBotAgent(config, probe.sender, { streamImpl: failingStream(dead) });

    await agent.run(ctx);

    const text = probe.delivered().join('\n');
    expect(text).toContain(t('ru').ai_degraded);
    expect(text).toContain(RU_AI_COMMANDS_HINT);
    for (const phrase of RU_AGENT_ERROR_PHRASES) {
      expect(text).not.toContain(phrase);
    }
  });

  // The mirror case: providers that are merely overloaded WILL come back, so the
  // stall phrase is honest there and must survive.
  test('whole chain transiently down → stall phrase, because a retry can still succeed', async () => {
    const flaky = new AllProvidersFailedError([
      {
        provider: 'z.ai (glm-5.1)',
        providerId: 'zai',
        model: 'synthetic',
        status: 503,
        message: 'overloaded',
        transient: true,
      },
      {
        provider: 'Gemini (models/gemini-2.5-flash)',
        providerId: 'gemini',
        model: 'synthetic',
        status: 500,
        message: 'internal error',
        transient: true,
      },
    ]);
    const agent = new CalendarBotAgent(config, probe.sender, { streamImpl: failingStream(flaky) });

    await agent.run(ctx);

    const text = probe.delivered().join('\n');
    expect(RU_AGENT_ERROR_PHRASES.some((phrase) => text.includes(phrase))).toBe(true);
    expect(text).not.toContain(t('ru').ai_degraded);
  });

  test('no retry mechanism wired → honest message instead of a promise it cannot keep', async () => {
    ctx.retryEnqueue = undefined;
    const agent = new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('socket hang up')),
    });

    await agent.run(ctx);

    const text = probe.delivered().join('\n');
    expect(text).toContain(t('ru').ai_degraded);
    for (const phrase of RU_AGENT_ERROR_PHRASES) {
      expect(text).not.toContain(phrase);
    }
  });

  test.each([
    // Redis hung: the turn must not wait on it forever, nor promise a retry it cannot confirm.
    ['never answers', () => Promise.withResolvers<boolean>().promise],
    ['rejects the job', () => Promise.reject(new Error('Connection is closed.'))],
  ])('a retry store that %s → honest message now, no comeback promise', async (_label, retryEnqueue) => {
    ctx.retryEnqueue = retryEnqueue;
    const agent = new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('Provider timed out')),
      retryStoreTimeoutMs: 20,
    });

    await agent.run(ctx);

    const text = probe.delivered().join('\n');
    expect(text).toContain(t('ru').ai_degraded);
    for (const phrase of RU_AGENT_ERROR_PHRASES) {
      expect(text).not.toContain(phrase);
    }
  });

  // ── Stall phrase selection ───────────────────────────────────────────────

  test('transient failure with a retry scheduled → stall phrase is sent', async () => {
    const agent = new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('Provider timed out')),
    });

    await agent.run(ctx);

    const text = probe.delivered().join('\n');
    expect(RU_AGENT_ERROR_PHRASES.some((phrase) => text.includes(phrase))).toBe(true);
  });

  test('two consecutive failures never repeat the same stall phrase back-to-back', async () => {
    // Force the cooldown open between the two messages so a phrase is picked twice.
    const seen: string[] = [];
    for (let i = 0; i < 25; i++) {
      aiFailureNotices.reset();
      const first = aiFailureNotices.decide(USER_ID, 'ru', {
        hardOutage: false,
        willRetry: true,
        isRetryAttempt: false,
      });
      const second = aiFailureNotices.decide(USER_ID, 'ru', {
        hardOutage: false,
        willRetry: true,
        isRetryAttempt: false,
        now: Date.now() + 10 * 60 * 1000,
      });
      expect(first.kind).toBe('stall');
      expect(second.kind).toBe('stall');
      expect(second.text).not.toBe(first.text);
      seen.push(second.text);
    }
    // Sanity: the exclusion did not collapse the pool to a single phrase.
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  test('second message during the same outage does not repeat the apology', async () => {
    const agent = new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('Provider timed out')),
    });

    await agent.run(ctx);
    const firstText = probe.delivered().join('\n');
    expect(RU_AGENT_ERROR_PHRASES.some((phrase) => firstText.includes(phrase))).toBe(true);

    const secondProbe = makeSenderProbe();
    const agent2 = new CalendarBotAgent(config, secondProbe.sender, {
      streamImpl: failingStream(new Error('Provider timed out')),
    });
    await agent2.run(ctx);

    const secondText = secondProbe.delivered().join('\n');
    for (const phrase of RU_AGENT_ERROR_PHRASES) {
      expect(secondText).not.toContain(phrase);
    }
    // Instead of a second apology, the user is told the truth plus what still works.
    expect(secondText).toContain(RU_AI_COMMANDS_HINT);
  });

  test('third and later messages during one outage get a one-line status, not a full repeat', () => {
    expect(
      aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true, isRetryAttempt: false }).kind,
    ).toBe('stall');
    expect(
      aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true, isRetryAttempt: false }).kind,
    ).toBe('honest');
    const third = aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true, isRetryAttempt: false });
    const fourth = aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: true, willRetry: true, isRetryAttempt: false });
    const noRetry = aiFailureNotices.decide(USER_ID, 'ru', {
      hardOutage: false,
      willRetry: false,
      isRetryAttempt: false,
    });
    expect(third).toEqual({ kind: 'still_down', text: t('ru').ai_still_down('retry') });
    // A retry of a hard outage cannot succeed, so the line does not promise one.
    expect(fourth).toEqual({ kind: 'still_down', text: t('ru').ai_still_down('resend') });
    expect(noRetry).toEqual({ kind: 'still_down', text: t('ru').ai_still_down('resend') });
  });

  test('the full notice comes back once the cooldown of the honest notice runs out', () => {
    const start = Date.now();
    const at = (minutes: number) => ({
      hardOutage: false,
      willRetry: true,
      isRetryAttempt: false,
      now: start + minutes * 60_000,
    });
    expect(aiFailureNotices.decide(USER_ID, 'ru', at(0)).kind).toBe('stall');
    expect(aiFailureNotices.decide(USER_ID, 'ru', at(1)).kind).toBe('honest');
    // Short lines do not push the window forward: it is measured from the honest notice.
    expect(aiFailureNotices.decide(USER_ID, 'ru', at(3)).kind).toBe('still_down');
    expect(aiFailureNotices.decide(USER_ID, 'ru', at(5.5)).kind).toBe('still_down');
    expect(aiFailureNotices.decide(USER_ID, 'ru', at(6.5)).kind).toBe('stall');
  });

  test('a retry that hits a hard outage still tells the truth when the user was not told honestly yet', () => {
    const start = Date.now();
    const hardRetry = (minutes: number) => ({
      hardOutage: true,
      willRetry: true,
      isRetryAttempt: true,
      now: start + minutes * 60_000,
    });
    // The first failure promised a comeback; the retry finds the chain dead for good.
    aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true, isRetryAttempt: false, now: start });
    expect(aiFailureNotices.decide(USER_ID, 'ru', hardRetry(1)).kind).toBe('honest');
    // Within the honest notice's cooldown the retry has nothing new to say.
    expect(aiFailureNotices.decide(USER_ID, 'ru', hardRetry(2)).kind).toBe('silent');
    // A retry firing long after the honest notice repeats it once.
    expect(aiFailureNotices.decide(USER_ID, 'ru', hardRetry(7)).kind).toBe('honest');
  });

  test('a retry after a restart that finds a hard outage tells the user honestly', async () => {
    // The tracker is in-memory: after a restart it no longer knows about the
    // "one sec" this message got. The retry must not hide the outage until give-up.
    ctx.retryAttempt = 1;
    await new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('Insufficient balance for this request')),
    }).run(ctx);

    expect(probe.delivered().join('\n')).toContain(t('ru').ai_degraded);
  });

  // Regression: a fresh request typed seconds after the honest "AI unavailable"
  // notice got no reply at all — the placeholder was deleted and nothing else
  // arrived, so the user resent it and then re-recorded it as a voice message.
  test('a fresh message failing right after the honest notice is told it was not done', async () => {
    const outage = new Error('Insufficient balance for this request');
    await new CalendarBotAgent(config, probe.sender, { streamImpl: failingStream(outage) }).run(ctx);
    expect(probe.delivered().join('\n')).toContain(t('ru').ai_degraded);

    const secondProbe = makeSenderProbe();
    await new CalendarBotAgent(config, secondProbe.sender, { streamImpl: failingStream(outage) }).run(ctx);

    const text = secondProbe.delivered().join('\n');
    // Before the fix the ⏳ placeholder was deleted and nothing else was sent.
    expect(secondProbe.delivered().filter((body) => body !== '⏳')).not.toEqual([]);
    // A hard outage: retries are futile, so no "I'll retry it myself" promise.
    expect(text).toContain(t('ru').ai_still_down('resend'));
    expect(text).not.toContain(t('ru').ai_still_down('retry'));
    // Short on purpose: no second stall joke, no second copy of the command list.
    expect(text).not.toContain(RU_AI_COMMANDS_HINT);
    for (const phrase of RU_AGENT_ERROR_PHRASES) {
      expect(text).not.toContain(phrase);
    }
    // The model sees what the user was told, like with every other notice.
    const history = ctx.chatHistory.getRecent(USER_ID, 10).map((row) => row.content);
    expect(history.some((content) => content.includes(t('ru').ai_still_down('resend')))).toBe(true);
  });

  test('with a retry that can still succeed, the short line promises it instead of asking for a resend', async () => {
    const flaky = new Error('Provider timed out');
    await new CalendarBotAgent(config, probe.sender, { streamImpl: failingStream(flaky) }).run(ctx);
    await new CalendarBotAgent(config, makeSenderProbe().sender, { streamImpl: failingStream(flaky) }).run(ctx);

    const thirdProbe = makeSenderProbe();
    await new CalendarBotAgent(config, thirdProbe.sender, { streamImpl: failingStream(flaky) }).run(ctx);

    // A retry of this very message is scheduled: asking for a resend would cancel it.
    const text = thirdProbe.delivered().join('\n');
    expect(text).toContain(t('ru').ai_still_down('retry'));
    expect(text).not.toContain(t('ru').ai_still_down('resend'));
    expect(text).not.toContain(RU_AI_COMMANDS_HINT);
    for (const phrase of RU_AGENT_ERROR_PHRASES) {
      expect(text).not.toContain(phrase);
    }
    const history = ctx.chatHistory.getRecent(USER_ID, 10).map((row) => row.content);
    expect(history.some((content) => content.includes(t('ru').ai_still_down('retry')))).toBe(true);
  });

  test('without a scheduled retry the fresh message is told it was not done and to send it again', async () => {
    ctx.retryEnqueue = undefined;
    const outage = new Error('Insufficient balance for this request');
    await new CalendarBotAgent(config, probe.sender, { streamImpl: failingStream(outage) }).run(ctx);

    const secondProbe = makeSenderProbe();
    await new CalendarBotAgent(config, secondProbe.sender, { streamImpl: failingStream(outage) }).run(ctx);

    const text = secondProbe.delivered().join('\n');
    expect(text).toContain(t('ru').ai_still_down('resend'));
    expect(text).not.toContain(t('ru').ai_still_down('retry'));
    expect(text).not.toContain(RU_AI_COMMANDS_HINT);
  });

  test('when the retry store does not answer in time, the short line neither promises a retry nor demands a resend', async () => {
    aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: true, willRetry: true, isRetryAttempt: false });
    ctx.retryEnqueue = () => Promise.withResolvers<boolean>().promise;

    await new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('Provider timed out')),
      retryStoreTimeoutMs: 20,
    }).run(ctx);

    // The job may still be stored: a plain "send it again" could run the request twice.
    expect(probe.delivered().join('\n')).toContain(t('ru').ai_still_down('unsure'));
  });

  test('the short status line carries no stall joke and no command list in either language', () => {
    for (const lang of ['ru', 'en'] as const) {
      for (const next of ['retry', 'resend', 'unsure'] as const) {
        const line = t(lang).ai_still_down(next);
        expect(line).not.toContain('\n');
        expect(line).not.toContain(lang === 'ru' ? RU_AI_COMMANDS_HINT : EN_AI_COMMANDS_HINT);
        expect(line).not.toContain('/help');
        for (const phrase of [...RU_AGENT_ERROR_PHRASES, ...EN_AGENT_ERROR_PHRASES]) {
          expect(line).not.toContain(phrase);
        }
        // Russian copy uses the informal ты-form: no formal вы-imperatives.
        if (lang === 'ru') expect(line).not.toMatch(/Попробуйте|Используйте|Напишите|Подождите|Повторите/);
      }
    }
    // With a retry scheduled the line must not ask for a resend.
    expect(t('ru').ai_still_down('retry')).not.toMatch(/Пришли|ещё раз/);
    expect(t('en').ai_still_down('retry')).not.toMatch(/send|again/i);
  });

  test('a mid-chain retry during a known outage stays quiet and deletes its placeholder', async () => {
    aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: true, willRetry: true, isRetryAttempt: false });
    ctx.retryAttempt = 1;

    for (const error of [new Error('Insufficient balance for this request'), new Error('Provider timed out')]) {
      const retryProbe = makeSenderProbe();
      await new CalendarBotAgent(config, retryProbe.sender, { streamImpl: failingStream(error) }).run(ctx);
      expect(retryProbe.delivered().filter((body) => body !== '⏳')).toEqual([]);
      expect(retryProbe.deleted()).toContain(42);
    }
  });

  test('supplement and non-explicit runs say nothing about a known outage', async () => {
    aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: true, willRetry: true, isRetryAttempt: false });

    const variants: Array<Partial<AgentContext>> = [{ supplementMode: true }, { wasExplicitInvocation: false }];
    for (const variant of variants) {
      const quietProbe = makeSenderProbe();
      await new CalendarBotAgent(config, quietProbe.sender, {
        streamImpl: failingStream(new Error('Insufficient balance for this request')),
      }).run({ ...ctx, ...variant });
      expect(quietProbe.delivered().filter((body) => body !== '⏳')).toEqual([]);
    }
  });

  // Regression (#510): a scheduled/trigger run failing right after the honest
  // notice asked the user to resend a request they never sent.
  test('a scheduled run failing within the honest cooldown stays silent while a user request gets the short line', async () => {
    aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: true, willRetry: true, isRetryAttempt: false });

    for (const error of [new Error('Insufficient balance for this request'), new Error('Provider timed out')]) {
      const scheduledProbe = makeSenderProbe();
      await new CalendarBotAgent(config, scheduledProbe.sender, { streamImpl: failingStream(error) }).run({
        ...ctx,
        unprompted: true,
      });
      expect(scheduledProbe.delivered().filter((body) => body !== '⏳')).toEqual([]);
      expect(scheduledProbe.deleted()).toContain(42);
    }
    // Its stored retry is not a comeback the user was promised.
    expect(aiFailureNotices.takeNotice(USER_ID)).toBe('honest');

    aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: true, willRetry: true, isRetryAttempt: false });
    const userProbe = makeSenderProbe();
    await new CalendarBotAgent(config, userProbe.sender, {
      streamImpl: failingStream(new Error('Insufficient balance for this request')),
    }).run(ctx);
    expect(userProbe.delivered().join('\n')).toContain(t('ru').ai_still_down('resend'));
  });

  test('repeated short status lines without a retry do not turn the give-up into a duplicate notice', async () => {
    ctx.retryEnqueue = undefined;
    const outage = new Error('Insufficient balance for this request');
    await new CalendarBotAgent(config, probe.sender, { streamImpl: failingStream(outage) }).run(ctx);
    for (let i = 0; i < 2; i++) {
      const repeatProbe = makeSenderProbe();
      await new CalendarBotAgent(config, repeatProbe.sender, { streamImpl: failingStream(outage) }).run(ctx);
      expect(repeatProbe.delivered().join('\n')).toContain(t('ru').ai_still_down('resend'));
    }
    // The honest notice already told the user the AI is down, and nothing was promised.
    expect(agentGiveUpMessage(USER_ID, 'ru')).toBeNull();
  });

  test('a short line that promised a retry is closed by the give-up if the retries run out', async () => {
    const flaky = new Error('Provider timed out');
    await new CalendarBotAgent(config, probe.sender, { streamImpl: failingStream(flaky) }).run(ctx);
    await new CalendarBotAgent(config, makeSenderProbe().sender, { streamImpl: failingStream(flaky) }).run(ctx);
    const repeatProbe = makeSenderProbe();
    await new CalendarBotAgent(config, repeatProbe.sender, { streamImpl: failingStream(flaky) }).run(ctx);
    expect(repeatProbe.delivered().join('\n')).toContain(t('ru').ai_still_down('retry'));

    // The retries fail quietly; the final give-up must not leave "I'll retry" hanging.
    expect(agentGiveUpMessage(USER_ID, 'ru')).toBe(t('ru').agent_give_up(true));
  });

  // The retry layers deliver the give-up from inside retryEnqueue and report
  // "gave up". A last attempt that hits a hard outage must not follow that
  // give-up with a second full "AI unavailable" notice.
  test('the last retry failing hard closes the promise with one message, not two', async () => {
    const hard = new Error('Insufficient balance for this request');
    await new CalendarBotAgent(config, probe.sender, { streamImpl: failingStream(hard) }).run(ctx);
    await new CalendarBotAgent(config, makeSenderProbe().sender, {
      streamImpl: failingStream(new Error('Provider timed out')),
    }).run(ctx);

    const lastProbe = makeSenderProbe();
    ctx.retryAttempt = 3;
    ctx.retryEnqueue = async () => {
      const giveUp = agentGiveUpMessage(USER_ID, 'ru');
      if (giveUp) await lastProbe.sender.sendMessage(USER_ID, giveUp);
      return false;
    };
    await new CalendarBotAgent(config, lastProbe.sender, { streamImpl: failingStream(hard) }).run(ctx);

    expect(lastProbe.delivered().filter((body) => body !== '⏳')).toEqual([t('ru').agent_give_up(true)]);
  });

  test('a give-up that failed to send does not leave the last hard failure unannounced', async () => {
    await new CalendarBotAgent(config, makeSenderProbe().sender, {
      streamImpl: failingStream(new Error('Provider timed out')),
    }).run(ctx);

    const lastProbe = makeSenderProbe();
    ctx.retryAttempt = 3;
    ctx.retryEnqueue = async () => {
      agentGiveUpMessage(USER_ID, 'ru');
      throw new Error('Bad Gateway');
    };
    await new CalendarBotAgent(config, lastProbe.sender, {
      streamImpl: failingStream(new Error('Insufficient balance for this request')),
    }).run(ctx);

    expect(lastProbe.delivered().join('\n')).toContain(t('ru').ai_degraded);
  });

  test('a promised retry is settled once the bot answers', async () => {
    const flaky = new Error('Provider timed out');
    for (let i = 0; i < 3; i++) {
      await new CalendarBotAgent(config, makeSenderProbe().sender, { streamImpl: failingStream(flaky) }).run(ctx);
    }
    await new CalendarBotAgent(config, makeSenderProbe().sender, {
      streamImpl: answeringStream('Завтра у тебя свободный день.'),
    }).run(ctx);

    expect(aiFailureNotices.takeNotice(USER_ID)).toBeNull();
  });

  // ── The promise is kept when the retry succeeds ──────────────────────────

  test('retry that succeeds delivers the real answer to the user', async () => {
    const failing = new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('Provider timed out')),
    });
    await failing.run(ctx);

    const retryProbe = makeSenderProbe();
    const recovered = new CalendarBotAgent(config, retryProbe.sender, {
      streamImpl: answeringStream('Завтра у тебя лазер в 19:00.'),
    });
    ctx.retryAttempt = 1;
    await recovered.run(ctx);

    expect(retryProbe.delivered().join('\n')).toContain('Завтра у тебя лазер в 19:00.');
    // Promise kept → nothing left to acknowledge later.
    expect(aiFailureNotices.takeNotice(USER_ID)).toBeNull();
  });

  test('retry run puts the retried question back in front of the model', async () => {
    const seen: OpenAI.ChatCompletionMessageParam[][] = [];
    const agent = new CalendarBotAgent(config, probe.sender, {
      streamImpl: async (opts, cbs = {}) => {
        seen.push(opts.messages);
        cbs.onTextDelta?.('ok');
        return {
          text: 'ok',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'ok' },
          providerUsed: 'mock',
        };
      },
    });
    ctx.chatHistory.save(USER_ID, 'assistant', 'Секундочку, перечитываю переписку, чуть позже отвечу.');
    ctx.retryAttempt = 1;

    await agent.run(ctx);

    const firstRound = seen[0]!;
    const last = firstRound[firstRound.length - 1]!;
    expect(last.role).toBe('user');
    expect(String(last.content)).toContain('что у меня завтра?');
  });

  // ── Give-up closes the loop ──────────────────────────────────────────────

  test('takeNotice reports the outstanding promise once, then clears it', async () => {
    const agent = new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('Provider timed out')),
    });
    await agent.run(ctx);

    expect(aiFailureNotices.takeNotice(USER_ID)).toBe('stall');
    expect(aiFailureNotices.takeNotice(USER_ID)).toBeNull();
  });

  test('give-up message acknowledges the earlier promise and lists the commands', () => {
    const ru = t('ru').agent_give_up(true);
    expect(ru).toContain('Обещал вернуться');
    expect(ru).toContain(RU_AI_COMMANDS_HINT);

    const en = t('en').agent_give_up(true);
    expect(en).toContain('Promised to come back');
    expect(en).toContain(EN_AI_COMMANDS_HINT);
  });

  test('give-up without an earlier promise does not invent one', () => {
    expect(t('ru').agent_give_up(false)).not.toContain('Обещал вернуться');
    expect(t('ru').agent_give_up(false)).toContain(RU_AI_COMMANDS_HINT);
    expect(t('en').agent_give_up(false)).not.toContain('Promised to come back');
    expect(t('en').agent_give_up(false)).toContain(EN_AI_COMMANDS_HINT);
  });

  // ── Both languages render ────────────────────────────────────────────────

  test('English user gets English strings on a hard outage', async () => {
    ctx.user = { ...ctx.user, language: 'en' };
    const agent = new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('Your credit balance is too low')),
    });

    await agent.run(ctx);

    const text = probe.delivered().join('\n');
    expect(text).toContain(t('en').ai_degraded);
    expect(text).toContain(EN_AI_COMMANDS_HINT);
  });

  test('every command named in the hints is a real slash command', () => {
    for (const hint of [EN_AI_COMMANDS_HINT, RU_AI_COMMANDS_HINT]) {
      const commands = [...hint.matchAll(/\/([a-z_]+)/g)].map((m) => m[1]!);
      expect(commands.length).toBeGreaterThanOrEqual(3);
      expect(commands).toEqual(['today', 'add', 'help']);
    }
  });

  test('tracker evicts the least recently notified users past its cap', () => {
    for (let userId = 1; userId <= 10_050; userId++) {
      aiFailureNotices.decide(userId, 'ru', { hardOutage: false, willRetry: true, isRetryAttempt: false });
    }
    expect(aiFailureNotices.size()).toBe(10_000);
    // The first users notified are the ones dropped; the newest are kept.
    expect(aiFailureNotices.takeNotice(1)).toBeNull();
    expect(aiFailureNotices.takeNotice(10_050)).toBe('stall');
  });

  test('Russian failure strings address the user informally', () => {
    const formalVerbs = /Попробуйте|Используйте|Напишите|Подождите/;
    expect(t('ru').something_wrong).not.toMatch(formalVerbs);
    expect(t('ru').ai_degraded).not.toMatch(formalVerbs);
    expect(t('ru').agent_give_up(true)).not.toMatch(formalVerbs);
    expect(t('ru').agent_give_up(false)).not.toMatch(formalVerbs);
  });

  test('stall phrase pools are localized per language', () => {
    const ru = aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true, isRetryAttempt: false });
    expect(RU_AGENT_ERROR_PHRASES.some((phrase) => phrase === ru.text)).toBe(true);
    aiFailureNotices.reset();
    const en = aiFailureNotices.decide(USER_ID, 'en', { hardOutage: false, willRetry: true, isRetryAttempt: false });
    expect(EN_AGENT_ERROR_PHRASES.some((phrase) => phrase === en.text)).toBe(true);
  });
});
