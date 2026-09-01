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
import { aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
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
  return async (_opts: StreamRoundOptions, cbs: StreamCallbacks = {}): Promise<StreamRoundResult> => {
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
      retryEnqueue: async () => {},
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
      const first = aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true });
      const second = aiFailureNotices.decide(USER_ID, 'ru', {
        hardOutage: false,
        willRetry: true,
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

  test('third and later messages during one outage stay quiet', () => {
    expect(aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true }).kind).toBe('stall');
    expect(aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true }).kind).toBe('honest');
    expect(aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true }).kind).toBe('silent');
    expect(aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true }).kind).toBe('silent');
  });

  test('a silent decision delivers no message and leaves no dangling placeholder', async () => {
    aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true });
    aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true });

    const agent = new CalendarBotAgent(config, probe.sender, {
      streamImpl: failingStream(new Error('Provider timed out')),
    });
    await agent.run(ctx);

    // The ⏳ placeholder must be deleted, not edited into a meaningless "...".
    expect(probe.deleted()).toContain(42);
    expect(probe.delivered().join('\n')).not.toContain('...');
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
      aiFailureNotices.decide(userId, 'ru', { hardOutage: false, willRetry: true });
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
    const ru = aiFailureNotices.decide(USER_ID, 'ru', { hardOutage: false, willRetry: true });
    expect(RU_AGENT_ERROR_PHRASES.some((phrase) => phrase === ru.text)).toBe(true);
    aiFailureNotices.reset();
    const en = aiFailureNotices.decide(USER_ID, 'en', { hardOutage: false, willRetry: true });
    expect(EN_AGENT_ERROR_PHRASES.some((phrase) => phrase === en.text)).toBe(true);
  });
});
