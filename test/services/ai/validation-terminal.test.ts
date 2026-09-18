import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { unverifiedResponseNotice } from '../../../src/services/ai/response-validator.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { _resetToolThrottleForTest } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

type Round = { text: string; tool?: { name: string; input: { [key: string]: unknown } }; error?: Error };
const UNSUPPORTED = 'Nothing else scheduled today.';
const INITIAL = 'There are two invented events today.';

function scripted(rounds: Round[], verdicts: (string | Error)[]) {
  let roundIndex = 0;
  let verdictIndex = 0;
  const counts = { model: 0, validator: 0 };
  const impl = async (options: StreamRoundOptions, callbacks: StreamCallbacks = {}): Promise<StreamRoundResult> => {
    const system = options.messages[0];
    if (typeof system?.content === 'string' && system.content.includes('strict QA validator')) {
      counts.validator++;
      const verdict = verdicts[verdictIndex++];
      if (verdict instanceof Error) throw verdict;
      if (verdict === undefined) throw new Error('Missing scripted verdict');
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
  const enqueue = mock(async () => {});

  beforeEach(() => {
    _resetToolThrottleForTest();
    aiFailureNotices.reset();
    enqueue.mockClear();
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    const user = userRepo.create({ telegram_id: 456, timezone: 'UTC', language: 'en' });
    const chatHistory = new ChatHistoryRepository(db);
    ctx = {
      user,
      chatId: 456,
      messageText: 'Show my events today',
      isGroup: false,
      inputMode: 'text',
      eventService: new EventService({ eventRepo: new EventRepository(db) }),
      eventReminderRepo: new EventReminderRepository(db),
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory,
      conversationLogger: new ConversationLogger(chatHistory),
      userRepo,
      retryEnqueue: enqueue,
    };
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
    expect(result.responseText).toBe(unverifiedResponseNotice(language));
    expect(result.metrics?.termination).toBe('unverified');
    expect(JSON.stringify(ctx.chatHistory.getRecent(ctx.user.telegram_id))).toContain(
      unverifiedResponseNotice(language),
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
    expect(result.responseText).toBe(unverifiedResponseNotice('en'));
  });

  test('early stop cannot bypass the outstanding rejection', async () => {
    const script = scripted(
      [{ text: INITIAL }, { text: UNSUPPORTED, tool: { name: 'end_conversation', input: {} } }],
      ['REJECT: no evidence'],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);
    expectNoRejectedProse(result.responseText);
    expect(result.responseText).toBe(unverifiedResponseNotice('en'));
  });
  test('quiet implicit repair failure does not speak or erase an outstanding notice', async () => {
    ctx.wasExplicitInvocation = false;
    aiFailureNotices.decide(ctx.user.telegram_id, 'en', { hardOutage: false, willRetry: true });
    const script = scripted(
      [{ text: INITIAL }, { text: UNSUPPORTED, error: new Error('Synthetic repair outage') }],
      ['REJECT: no evidence'],
    );
    const result = await new CalendarBotAgent({}, sender, { streamImpl: script.impl }).run(ctx);
    expect(result.responseText).toBe('');
    expect(result.metrics?.termination).toBe('error');
    expect(JSON.stringify(ctx.chatHistory.getRecent(ctx.user.telegram_id))).not.toContain(
      unverifiedResponseNotice('en'),
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
    expect(result.responseText).toBe(unverifiedResponseNotice('en'));
    expect(script.counts).toEqual({ model: 3, validator: 2 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
