import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type OpenAI from 'openai';
import { EN_AGENT_ERROR_PHRASES, RU_AGENT_ERROR_PHRASES } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { AssistantMessageCodec, aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { AiDebugLogger } from '../../../src/services/ai/debug-logger.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { _resetToolThrottleForTest } from '../../../src/services/ai/tool-executor.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

// ── Scripted stream mocks ────────────────────────────────────────────────
// makeStreamImpl takes a list of canned StreamRoundResults — one per round —
// and returns a function with the same signature as aiStreamRound. Each call
// consumes one canned result and invokes onTextDelta/onToolCallStart to simulate
// the live streaming behaviour. No module mocking — the agent accepts the impl
// via constructor options, so tests don't leak across files.

type ScriptedRound =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; callId: string; name: string; input: { [key: string]: unknown } }
  | { kind: 'error'; error: Error };

function asAssistantMessage(round: ScriptedRound): OpenAI.ChatCompletionMessageParam {
  if (round.kind === 'tool') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: round.callId,
          type: 'function',
          function: { name: round.name, arguments: JSON.stringify(round.input) },
        },
      ],
    };
  }
  if (round.kind === 'text') {
    return { role: 'assistant', content: round.text };
  }
  // Unused for 'error' — the impl throws before constructing a message.
  return { role: 'assistant', content: '' };
}

function isValidatorCall(opts: StreamRoundOptions): boolean {
  // The response validator always sends a 2-message payload (system + user)
  // whose system prompt starts with "You are a strict QA validator".
  const system = opts.messages[0];
  if (!system || system.role !== 'system' || typeof system.content !== 'string') return false;
  return system.content.includes('strict QA validator');
}

function makeStreamImpl(script: ScriptedRound[]): {
  impl: (opts: StreamRoundOptions, cbs?: StreamCallbacks) => Promise<StreamRoundResult>;
  calls: { messages: OpenAI.ChatCompletionMessageParam[] }[];
} {
  const calls: { messages: OpenAI.ChatCompletionMessageParam[] }[] = [];
  let round = 0;
  const impl = async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}) => {
    // Auto-approve validator calls so tests don't have to pre-script them.
    // Validator invocations are opaque to the script — they're a side channel
    // that only fires when the agent produces text with no tool calls.
    if (isValidatorCall(opts)) {
      const validatorMsg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'APPROVE' };
      return {
        text: 'APPROVE',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: validatorMsg,
        providerUsed: 'mock-validator',
      };
    }

    calls.push({ messages: opts.messages });
    const current = script[round++];
    if (!current) throw new Error(`Scripted stream ran out of rounds (call ${round})`);
    if (current.kind === 'error') throw current.error;

    if (current.kind === 'text') {
      cbs.onTextDelta?.(current.text);
      const msg = asAssistantMessage(current);
      return {
        text: current.text,
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: msg,
        providerUsed: 'mock',
      };
    }

    // tool round
    cbs.onToolCallStart?.(current.name);
    const msg = asAssistantMessage(current);
    return {
      text: '',
      toolCalls: [
        {
          id: current.callId,
          name: current.name,
          arguments: JSON.stringify(current.input),
        },
      ],
      finishReason: 'tool_calls',
      assistantMessage: msg,
      providerUsed: 'mock',
    };
  };
  return { impl, calls };
}

describe('CalendarBotAgent.run()', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;
  const USER_ID = 456;

  beforeEach(() => {
    // Module-level throttle state must be reset between tests so repeated
    // (tool, args) combinations across tests don't cross-contaminate.
    _resetToolThrottleForTest();
    // Per-user stall/honest notices are rate limited at module scope — reset so
    // one test's apology does not silence the next test's.
    aiFailureNotices.reset();
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC', language: 'en' });
    const eventService = new EventService({ eventRepo });
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: 'Show my events today',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      conversationLogger: new ConversationLogger(chatHistoryRepo),
      userRepo,
      eventReminderRepo,
      // A stall phrase promises a comeback, so the agent only sends one when a
      // retry is actually scheduled. Wire a no-op enqueue for the error tests.
      retryEnqueue: async () => {},
    };
    config = {};
    sender = {
      sendMessage: mock(() => Promise.resolve({ message_id: 42 })),
      editMessageText: mock(() => Promise.resolve()),
    };
  });

  test('run() with simple text response streams and saves history', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: 'No events today.' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(sender.sendMessage).toHaveBeenCalledTimes(1); // init placeholder
    expect(sender.editMessageText).toHaveBeenCalled(); // finalize

    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(2);
    expect(history[0]!.role).toBe('user');
    expect(history[0]!.content).toBe('Show my events today');
    expect(history[1]!.role).toBe('assistant');
    const parsed = JSON.parse(history[1]!.content) as OpenAI.ChatCompletionMessageParam;
    expect(parsed.role).toBe('assistant');
    expect(parsed.content).toBe('No events today.');
  });

  test('run() with tool use executes tool and continues loop', async () => {
    const { impl, calls } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-03-15', end_date: '2026-03-15' },
      },
      { kind: 'text', text: 'You have 0 events.' },
    ]);

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    await agent.run(ctx);

    expect(calls.length).toBe(2);

    // Second call should carry the assistant tool_calls message + the tool result
    const secondCall = calls[1]!;
    const hasAssistantWithTools = secondCall.messages.some(
      (m) => m.role === 'assistant' && 'tool_calls' in m && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    expect(hasAssistantWithTools).toBe(true);
    const hasToolMessage = secondCall.messages.some((m) => m.role === 'tool');
    expect(hasToolMessage).toBe(true);

    const history = ctx.chatHistory.getRecent(USER_ID);
    // user + assistant-with-tool-calls + tool result row + assistant text
    expect(history.length).toBe(4);
    expect(history[0]!.role).toBe('user');
    expect(history[1]!.role).toBe('assistant');
    expect(history[2]!.role).toBe('tool');
    expect(history[3]!.role).toBe('assistant');
  });

  test('run() handles streaming errors and sends error message in user language', async () => {
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('all providers failed') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(sender.sendMessage).toHaveBeenCalledTimes(1); // init
    expect(sender.editMessageText).toHaveBeenCalled(); // finalize with stall text

    // User row + stall message saved so the model can play along if the user reacts
    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(2);
    expect(history[0]!.role).toBe('user');
    expect(history[1]!.role).toBe('assistant');
    const parseResult = AssistantMessageCodec.safeParse(history[1]!.content);
    expect(parseResult.success).toBe(true);
    const stallContent = parseResult.success ? (parseResult.data.content ?? '') : '';
    expect(stallContent).toBeTruthy();
    expect(stallContent).not.toContain('An error occurred');
  });

  test('run() handles error with Russian language user', async () => {
    ctx.user = { ...ctx.user, language: 'ru' };
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('boom') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    await agent.run(ctx);

    const editCalls = (sender.editMessageText as ReturnType<typeof mock>).mock.calls;
    const lastEditText = editCalls[editCalls.length - 1]?.[2] as string;
    // Russian cute phrases are shown — verify non-empty, not English, contains Cyrillic
    expect(lastEditText).toBeTruthy();
    expect(lastEditText).not.toContain('An error occurred');
    expect(/[а-яёА-ЯЁ]/.test(lastEditText)).toBe(true);
  });

  test('run() breaks loop when model returns text without tool calls', async () => {
    const { impl, calls } = makeStreamImpl([{ kind: 'text', text: 'Done.' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    await agent.run(ctx);
    expect(calls.length).toBe(1);
  });

  test('run() injects system prompt as the first message', async () => {
    const { impl, calls } = makeStreamImpl([{ kind: 'text', text: 'hi' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    await agent.run(ctx);
    const firstCall = calls[0]!;
    const system = firstCall.messages.find((m) => m.role === 'system');
    expect(system).toBeDefined();
    expect(system!.content as string).toContain('calendar assistant');
  });

  test('buildMessages uses per-chat history in group context', async () => {
    const GROUP_CHAT_ID = -1001234;
    ctx.chatHistory.save(USER_ID, 'user', 'personal message');
    ctx.chatHistory.save(USER_ID, 'user', 'group message', GROUP_CHAT_ID);
    ctx.chatHistory.save(
      USER_ID,
      'assistant',
      JSON.stringify({ role: 'assistant', content: 'group reply' } satisfies OpenAI.ChatCompletionMessageParam),
      GROUP_CHAT_ID,
    );
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText, GROUP_CHAT_ID);

    ctx.isGroup = true;
    ctx.groupChatId = GROUP_CHAT_ID;
    ctx.groupTitle = 'Test Group';

    const agent = new CalendarBotAgent(config, sender);
    const personalHistory = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = await agent.buildMessages(ctx, personalHistory);

    expect(messages.length).toBe(3);
    expect(messages[0]!.content as string).toContain('group message');
    expect(messages[1]!.content as string).toContain('group reply');
    expect(messages[2]!.content as string).toContain('Show my events today');
  });

  test('[SKIP] response in group sends nothing (no placeholder, no delete)', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '[SKIP]' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';

    await agent.run(ctx);

    expect(sender.sendMessage).toHaveBeenCalledTimes(0);
    expect(deleteMessage).toHaveBeenCalledTimes(0);
  });

  test('response containing [SKIP] anywhere is discarded in group', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: 'Got it [SKIP]' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = true;
    ctx.groupChatId = -100999;

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    expect(sender.sendMessage).toHaveBeenCalledTimes(0);
    expect(deleteMessage).toHaveBeenCalledTimes(0);
  });

  test('[SKIP] response in DM is discarded (placeholder deleted)', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '[SKIP]' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = false;
    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(sender.editMessageText).not.toHaveBeenCalled();
  });

  test('[SKIP] with trailing whitespace is still discarded in group', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '[SKIP]\n' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;
    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';
    await agent.run(ctx);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });

  test('onBotResponse callback is called after finalize with message ID', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: 'Hello' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    const onBotResponse = mock(() => {});
    ctx.onBotResponse = onBotResponse;

    await agent.run(ctx);

    expect(onBotResponse).toHaveBeenCalledTimes(1);
    expect(onBotResponse).toHaveBeenCalledWith(42);
  });

  test('onBotResponse is NOT called after [SKIP] discard', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '[SKIP]' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    const onBotResponse = mock(() => {});
    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';
    ctx.onBotResponse = onBotResponse;

    await agent.run(ctx);

    expect(onBotResponse).not.toHaveBeenCalled();
  });

  test('"..." response in group is discarded like [SKIP]', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '...' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    expect(sender.sendMessage).toHaveBeenCalledTimes(0);
    expect(deleteMessage).toHaveBeenCalledTimes(0);
  });

  test('Unicode ellipsis "…" response in group is discarded like [SKIP]', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '…' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    expect(sender.sendMessage).toHaveBeenCalledTimes(0);
    expect(deleteMessage).toHaveBeenCalledTimes(0);
  });

  test('set_reaction tool does not create a status message in group (silent tool)', async () => {
    const setReaction = mock(() => Promise.resolve());
    (sender as TelegramSender).setReaction = setReaction;
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'call-react', name: 'set_reaction', input: { emoji: '👌' } },
      { kind: 'text', text: '[SKIP]' },
    ]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';
    ctx.incomingMessageId = 777;

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    // Silent tool must not create any placeholder message
    expect(sender.sendMessage).not.toHaveBeenCalled();
    // Reaction itself was executed
    expect(setReaction).toHaveBeenCalledTimes(1);
  });

  test('set_reaction tool in DM discards placeholder after [SKIP]', async () => {
    const setReaction = mock(() => Promise.resolve());
    (sender as TelegramSender).setReaction = setReaction;
    const deleteMessage = mock(() => Promise.resolve());
    (sender as TelegramSender).deleteMessage = deleteMessage;

    const { impl } = makeStreamImpl([
      { kind: 'tool', callId: 'call-react', name: 'set_reaction', input: { emoji: '👍' } },
      { kind: 'text', text: '[SKIP]' },
    ]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.isGroup = false;
    ctx.incomingMessageId = 888;

    const result = await agent.run(ctx);

    expect(result.responseText).toBe('');
    // Placeholder ⏳ was created in init, then deleted by [SKIP] discard
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    // No tool label should have been shown
    expect(sender.editMessageText).not.toHaveBeenCalled();
  });

  test('logAiTurn via ConversationLogger saves the assistant message with chatId in group context', () => {
    const GROUP_CHAT_ID = -1001234;
    ctx.isGroup = true;
    ctx.groupChatId = GROUP_CHAT_ID;

    const agent = new CalendarBotAgent(config, sender);
    const assistant: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'Group response' };
    agent.saveAssistantTurn(ctx, assistant);

    const chatHistory = ctx.chatHistory.getRecentByChat(GROUP_CHAT_ID, 10);
    expect(chatHistory.length).toBe(1);
    expect(chatHistory[0]!.role).toBe('assistant');
    const parsed = JSON.parse(chatHistory[0]!.content) as OpenAI.ChatCompletionMessageParam;
    expect(parsed.role).toBe('assistant');
    expect(parsed.content).toBe('Group response');
  });

  test.each([
    false,
    true,
  ])('waiting for user closes deferred tool messages without executing them (retry=%s)', async (retry) => {
    sender.sendButtons = mock(async () => ({ message_id: 44 }));
    sender.deleteMessage = mock(async () => {});
    let rounds = 0;
    const start = new Date(Date.now() + 86400000).toISOString();
    const impl = async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}): Promise<StreamRoundResult> => {
      if (isValidatorCall(opts))
        return {
          providerUsed: 'mock',
          text: 'REJECT: unsupported answer',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT: unsupported answer' },
        };
      if (retry && rounds++ === 0) {
        cbs.onTextDelta?.('A wrong unsupported answer.');
        return {
          providerUsed: 'mock',
          text: 'A wrong unsupported answer.',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'A wrong unsupported answer.' },
        };
      }
      const toolCalls = [
        {
          id: 'handoff',
          name: 'ask_user',
          arguments: JSON.stringify({ question: 'Confirm?', options: ['Yes', 'No'] }),
        },
        {
          id: 'deferred',
          name: 'create_event',
          arguments: JSON.stringify({ title: 'Must not exist', start_at: start }),
        },
      ];
      return {
        providerUsed: 'mock',
        text: '',
        toolCalls,
        finishReason: 'tool_calls',
        assistantMessage: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls.map((x) => ({
            id: x.id,
            type: 'function',
            function: { name: x.name, arguments: x.arguments },
          })),
        },
      };
    };
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const result = await agent.run(ctx);
    expect(
      ctx.eventService.getEventsInRange(
        USER_ID,
        new Date(Date.now()).toISOString(),
        new Date(Date.now() + 172800000).toISOString(),
      ),
    ).toHaveLength(0);
    expect(result.toolCalls.map((x) => x.name)).not.toContain('create_event');
    const { messages } = await agent.buildMessages(ctx, ctx.chatHistory.getRecent(USER_ID, 30));
    const deferred = messages.find((x) => x.role === 'tool' && x.tool_call_id === 'deferred');
    expect(deferred?.content).toContain('NOT_EXECUTED');
    expect(result.responseText).not.toContain('...');
    expect(sender.sendButtons).toHaveBeenCalledTimes(1);
  });

  test('validator retry preserves batched completion text and later mutation', async () => {
    let rounds = 0;
    const start = new Date(Date.now() + 86400000).toISOString();
    const impl = async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}): Promise<StreamRoundResult> => {
      if (isValidatorCall(opts))
        return {
          providerUsed: 'mock',
          text: 'REJECT: unsupported answer',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT: unsupported answer' },
        };
      if (rounds++ === 0) {
        cbs.onTextDelta?.('Unsupported answer.');
        return {
          providerUsed: 'mock',
          text: 'Unsupported answer.',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'Unsupported answer.' },
        };
      }
      cbs.onTextDelta?.('Created the requested event.');
      const toolCalls = [
        { id: 'end', name: 'end_conversation', arguments: '{}' },
        { id: 'create', name: 'create_event', arguments: JSON.stringify({ title: 'Retry-created', start_at: start }) },
      ];
      return {
        providerUsed: 'mock',
        text: 'Created the requested event.',
        toolCalls,
        finishReason: 'tool_calls',
        assistantMessage: {
          role: 'assistant',
          content: 'Created the requested event.',
          tool_calls: toolCalls.map((x) => ({
            id: x.id,
            type: 'function',
            function: { name: x.name, arguments: x.arguments },
          })),
        },
      };
    };
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const result = await agent.run(ctx);
    expect(
      ctx.eventService.getEventsInRange(
        USER_ID,
        new Date(Date.now()).toISOString(),
        new Date(Date.now() + 172800000).toISOString(),
      ),
    ).toHaveLength(1);
    expect(result.responseText).toContain('Created the requested event.');
  });

  test('end_conversation does not discard a final answer or a later action in the same batch', async () => {
    const start = new Date(Date.now() + 86400000).toISOString();
    const impl = async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}): Promise<StreamRoundResult> => {
      expect(opts.messages.length).toBeGreaterThan(0);
      cbs.onTextDelta?.('Created the requested event.');
      const toolCalls = [
        { id: 'end-first', name: 'end_conversation', arguments: '{}' },
        {
          id: 'create-second',
          name: 'create_event',
          arguments: JSON.stringify({ title: 'Batched synthetic event', start_at: start }),
        },
      ];
      return {
        text: 'Created the requested event.',
        toolCalls,
        finishReason: 'tool_calls',
        providerUsed: 'scripted',
        assistantMessage: {
          role: 'assistant',
          content: 'Created the requested event.',
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        },
      };
    };
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const result = await agent.run(ctx);
    expect(result.toolCalls.map((call) => call.name)).toEqual(['end_conversation', 'create_event']);
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults.every((r) => r.success)).toBe(true);
    expect(
      ctx.eventService.getEventsInRange(
        USER_ID,
        new Date().toISOString(),
        new Date(Date.now() + 2 * 86400000).toISOString(),
      ),
    ).toHaveLength(1);
    expect(result.responseText).toContain('Created the requested event.');
    expect(result.responseText).not.toContain('...');
  });

  test('a delivered ask_user question is not followed by a success-looking ellipsis', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'ask-before-end',
        name: 'ask_user',
        input: { question: 'Which event?', options: ['A', 'B'] },
      },
    ]);
    sender.sendButtons = mock(async () => ({ message_id: 99 }));
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    const result = await agent.run(ctx);
    expect(sender.sendButtons).toHaveBeenCalledTimes(1);
    expect(result.responseText).not.toContain('...');
    expect(result.toolCalls.map((call) => call.name)).toEqual(['ask_user']);
  });

  for (const retry of [false, true]) {
    test(`empty end recovery retains paired batch outcomes without repeated writes (retry=${retry})`, async () => {
      const start = new Date(Date.now() + 86400000).toISOString();
      const recoveryCalls: StreamRoundOptions[] = [];
      let rounds = 0;
      ctx.messageText = 'Create Recovery meeting and tell me its time';
      ctx.userRepo.create({ telegram_id: 999, timezone: 'UTC', language: 'en' });
      ctx.chatHistory.save(999, 'user', 'OTHER_USER_PRIVATE_SENTINEL');
      const scripted = makeStreamImpl([
        ...(retry ? [{ kind: 'text' as const, text: 'Unsupported answer.' }] : []),
        { kind: 'tool', callId: 'end', name: 'end_conversation', input: {} },
        { kind: 'text', text: 'Recovery meeting was created for tomorrow.' },
      ]);
      const impl = async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}): Promise<StreamRoundResult> => {
        if (isValidatorCall(opts))
          return {
            text: 'REJECT: unsupported',
            toolCalls: [],
            finishReason: 'stop',
            providerUsed: 'mock',
            assistantMessage: { role: 'assistant', content: 'REJECT: unsupported' },
          };
        const round = rounds++;
        if (round > (retry ? 1 : 0)) recoveryCalls.push(opts);
        const result = await scripted.impl(opts, cbs);
        if (result.toolCalls.length) {
          const call = {
            id: 'write',
            name: 'create_event',
            arguments: JSON.stringify({ title: 'Recovery meeting', start_at: start }),
          };
          result.toolCalls.push(call);
          if (result.assistantMessage.role === 'assistant')
            result.assistantMessage.tool_calls?.push({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            });
        }
        return result;
      };
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
      expect(result.responseText).toBe('Recovery meeting was created for tomorrow.');
      expect(recoveryCalls).toHaveLength(1);
      const recovery = recoveryCalls[0]!;
      expect(recovery.fast).toBe(false);
      expect(recovery.tools ?? []).toHaveLength(0);
      expect(recovery.maxTokens).toBeLessThanOrEqual(1024);
      expect(recovery.signal).toBeDefined();
      expect(recovery.userId).toBe(USER_ID);
      expect(JSON.stringify(recovery.messages)).toContain(ctx.messageText);
      expect(JSON.stringify(recovery.messages)).not.toContain('OTHER_USER_PRIVATE_SENTINEL');
      const paired = recovery.messages.filter((m) => m.role === 'tool');
      expect(paired.map((m) => m.role === 'tool' && m.tool_call_id)).toEqual(['end', 'write']);
      expect(JSON.stringify(paired)).toContain('Recovery meeting');
      expect(result.toolCalls.map((c) => c.name)).toEqual(['end_conversation', 'create_event']);
      expect(
        ctx.eventService.getEventsInRange(
          USER_ID,
          new Date().toISOString(),
          new Date(Date.now() + 172800000).toISOString(),
        ),
      ).toHaveLength(1);
      expect(
        ctx.chatHistory
          .getRecent(USER_ID)
          .some((m) => m.role === 'assistant' && m.content.includes('Recovery meeting was created')),
      ).toBe(true);
    });
  }

  for (const invalid of ['', '...', '…', '. . .', '[SKIP]', 'Done [SKIP]']) {
    test(`completion recovery rejects ${JSON.stringify(invalid)} and exhausts two attempts`, async () => {
      const { impl, calls } = makeStreamImpl([
        { kind: 'tool', callId: 'end', name: 'end_conversation', input: {} },
        { kind: 'text', text: invalid },
        { kind: 'text', text: invalid },
      ]);
      ctx.retryEnqueue = mock(async () => {});
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
      expect(result.responseText).toContain('I did not complete the explanation');
      expect(calls).toHaveLength(3);
      expect(ctx.retryEnqueue).not.toHaveBeenCalled();
    });
  }

  test('completion recovery rejects unsolicited writes and retries text without executing them', async () => {
    const { impl, calls } = makeStreamImpl([
      { kind: 'tool', callId: 'end', name: 'end_conversation', input: {} },
      {
        kind: 'tool',
        callId: 'forbidden',
        name: 'create_event',
        input: { title: 'Forbidden recovery write', start_at: new Date(Date.now() + 86400000).toISOString() },
      },
      { kind: 'text', text: 'No event was created.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toBe('No event was created.');
    expect(calls).toHaveLength(3);
    expect(result.toolCalls.map((c) => c.name)).toEqual(['end_conversation']);
    expect(
      ctx.eventService.getEventsInRange(
        USER_ID,
        new Date().toISOString(),
        new Date(Date.now() + 172800000).toISOString(),
      ),
    ).toHaveLength(0);
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Forbidden recovery write');
  });

  for (const abort of [false, true]) {
    test(`completion recovery handles failed calls (abort=${abort})`, async () => {
      const { impl, calls } = makeStreamImpl([
        { kind: 'tool', callId: 'end', name: 'end_conversation', input: {} },
        {
          kind: 'error',
          error: abort ? new DOMException('Cancelled', 'AbortError') : new Error('Synthetic provider failure'),
        },
        { kind: 'text', text: 'Recovered explanation.' },
      ]);
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
      expect(calls).toHaveLength(abort ? 2 : 3);
      expect(result.responseText).toContain(abort ? 'I did not complete' : 'Recovered explanation.');
    });
  }

  for (const mode of ['implicit-group', 'supplement']) {
    test(`empty end preserves silence without recovery in ${mode}`, async () => {
      ctx.isGroup = mode === 'implicit-group';
      ctx.wasExplicitInvocation = false;
      ctx.supplementMode = mode === 'supplement';
      const { impl, calls } = makeStreamImpl([{ kind: 'tool', callId: 'end', name: 'end_conversation', input: {} }]);
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
      expect(result.responseText).toBe('');
      expect(calls).toHaveLength(1);
    });
  }

  test('completion recovery rejects truncated output and assistant-embedded tool calls', async () => {
    const scripted = makeStreamImpl([
      { kind: 'tool', callId: 'end', name: 'end_conversation', input: {} },
      { kind: 'text', text: 'Truncated answer' },
      { kind: 'text', text: 'Pretended completion' },
    ]);
    let rounds = 0;
    const impl = async (opts: StreamRoundOptions, cbs?: StreamCallbacks) => {
      const result = await scripted.impl(opts, cbs);
      if (++rounds === 2) result.finishReason = 'length';
      if (rounds === 3)
        result.assistantMessage = {
          role: 'assistant',
          content: result.text,
          tool_calls: [{ id: 'hidden', type: 'function', function: { name: 'create_event', arguments: '{}' } }],
        };
      return result;
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(result.responseText).toContain('I did not complete');
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Pretended completion');
  });

  test('completion recovery caps context without dropping paired outcomes', async () => {
    ctx.messageText = 'x'.repeat(64001);
    const { impl, calls } = makeStreamImpl([{ kind: 'tool', callId: 'end', name: 'end_conversation', input: {} }]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(calls).toHaveLength(1);
    expect(result.responseText).toContain('I did not complete');
  });

  for (const retry of [false, true]) {
    for (const waitTool of ['ask_user', 'pick_users']) {
      test(`end before ${waitTool} preserves real wait and deferred pairing (retry=${retry})`, async () => {
        sender.sendButtons = mock(async () => ({ message_id: 99 }));
        sender.sendUserPicker = mock(async () => ({ message_id: 99 }));
        const scripted = makeStreamImpl([
          ...(retry ? [{ kind: 'text' as const, text: 'Unsupported answer.' }] : []),
          { kind: 'tool', callId: 'end', name: 'end_conversation', input: {} },
        ]);
        const impl = async (opts: StreamRoundOptions, cbs?: StreamCallbacks) => {
          if (isValidatorCall(opts))
            return {
              text: 'REJECT: unsupported',
              toolCalls: [],
              finishReason: 'stop',
              providerUsed: 'mock',
              assistantMessage: { role: 'assistant' as const, content: 'REJECT: unsupported' },
            };
          const result = await scripted.impl(opts, cbs);
          if (result.toolCalls.length) {
            const calls = [
              {
                id: 'wait',
                name: waitTool,
                arguments: JSON.stringify(
                  waitTool === 'ask_user'
                    ? { question: 'Which?', options: ['A', 'B'] }
                    : { event_id: 1, prompt: 'Who?' },
                ),
              },
              { id: 'deferred', name: 'create_event', arguments: '{}' },
            ];
            result.toolCalls.push(...calls);
            if (result.assistantMessage.role === 'assistant')
              result.assistantMessage.tool_calls?.push(
                ...calls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              );
          }
          return result;
        };
        const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
        const result = await agent.run(ctx);
        expect(scripted.calls).toHaveLength(retry ? 2 : 1);
        expect(result.responseText).toBe('');
        expect(result.toolCalls.map((c) => c.name)).toEqual(['end_conversation', waitTool]);
        expect(waitTool === 'ask_user' ? sender.sendButtons : sender.sendUserPicker).toHaveBeenCalledTimes(1);
        const { messages } = await agent.buildMessages(ctx, ctx.chatHistory.getRecent(USER_ID));
        expect(messages.find((m) => m.role === 'tool' && m.tool_call_id === 'deferred')?.content).toContain(
          'NOT_EXECUTED',
        );
      });
    }
  }

  test('completion recovery retains earlier rounds and actual failed tool outcomes', async () => {
    const scripted = makeStreamImpl([
      { kind: 'tool', callId: 'read', name: 'get_events', input: { start_date: '2026-03-15', end_date: '2026-03-15' } },
      { kind: 'tool', callId: 'failed-delete', name: 'delete_event', input: { event_id: 9876 } },
      { kind: 'tool', callId: 'end', name: 'end_conversation', input: {} },
      { kind: 'text', text: 'No events found. The requested deletion failed.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: scripted.impl }).run(ctx);
    expect(result.responseText).toContain('deletion failed');
    const results = scripted.calls[3]!.messages.filter((m) => m.role === 'tool');
    expect(results.map((m) => m.tool_call_id)).toEqual(['read', 'failed-delete', 'end']);
    expect(results[1]!.content).toContain('Error:');
    expect(result.toolResults[1]!.success).toBe(false);
  });

  test('completion recovery respects the remaining overall run budget', async () => {
    const clock = spyOn(Date, 'now');
    const originalNow = Date.now();
    clock.mockReturnValue(originalNow);
    try {
      const scripted = makeStreamImpl([{ kind: 'tool', callId: 'end', name: 'end_conversation', input: {} }]);
      const impl = async (opts: StreamRoundOptions, cbs?: StreamCallbacks) => {
        const result = await scripted.impl(opts, cbs);
        clock.mockReturnValue(originalNow + 300001);
        return result;
      };
      const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
      expect(scripted.calls).toHaveLength(1);
      expect(result.responseText).toContain('I did not complete');
    } finally {
      clock.mockRestore();
    }
  });

  test('completion deadline aborts even a stream that ignores its signal', async () => {
    const scripted = makeStreamImpl([{ kind: 'tool', callId: 'end', name: 'end_conversation', input: {} }]);
    let recoverySignal: AbortSignal | undefined;
    let calls = 0;
    let resolveLate: ((result: StreamRoundResult) => void) | undefined;
    const impl = async (opts: StreamRoundOptions, cbs?: StreamCallbacks): Promise<StreamRoundResult> => {
      if (++calls === 1) return scripted.impl(opts, cbs);
      recoverySignal = opts.signal;
      return new Promise((resolve) => {
        resolveLate = resolve;
      });
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(calls).toBe(2);
    expect(recoverySignal?.aborted).toBe(true);
    expect(recoverySignal?.reason.name).toBe('AbortError');
    expect(result.responseText).toContain('I did not complete');
    resolveLate?.({
      text: 'Late completion',
      toolCalls: [],
      finishReason: 'stop',
      providerUsed: 'mock',
      assistantMessage: { role: 'assistant', content: 'Late completion' },
    });
    await Promise.resolve();
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Late completion');
  }, 25000);

  test('end_conversation tool stops loop and calls debugLogger.endSession', async () => {
    const { impl, calls } = makeStreamImpl([{ kind: 'tool', callId: 'call-end', name: 'end_conversation', input: {} }]);
    const endSession = mock(() => {});
    const debugLogger = {
      createRunContext: mock(() => null),
      endSession,
    } as Partial<AiDebugLogger> as AiDebugLogger;

    const agent = new CalendarBotAgent({ ...config, debugLogger }, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    const result = await agent.run(ctx);

    // Completion recovery is bounded even when every scripted completion fails.
    expect(calls.length).toBe(3);
    expect(result.toolCalls.some((tc) => tc.name === 'end_conversation')).toBe(true);
    expect(endSession).toHaveBeenCalledWith(USER_ID);
    expect(result.responseText).not.toMatch(/(?:^|\n)\.\.\.$/);
    expect(result.responseText).toContain('complete');
  });

  // ── Regression: removing flush from onToolCallStart must not break normal tools ──

  test('normal tool in group still creates placeholder and shows tool label', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-ev',
        name: 'get_events',
        input: { start_date: '2026-04-13', end_date: '2026-04-13' },
      },
      { kind: 'text', text: 'You have 0 events today.' },
    ]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Test Group';

    await agent.run(ctx);

    // Tool loop flush MUST create a placeholder (noPlaceholder lazy create)
    // and edit it with the tool label.
    expect(sender.sendMessage).toHaveBeenCalled();
    expect(sender.editMessageText).toHaveBeenCalled();
    // Finalize edits the message with the final response
    const lastEdit = (sender.editMessageText as ReturnType<typeof mock>).mock.calls.at(-1)!;
    const finalHtml = lastEdit[2] as string;
    expect(finalHtml).toContain('0 events');
  });

  test('normal tool in DM shows tool label via edit (no extra messages)', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-ev',
        name: 'get_events',
        input: { start_date: '2026-04-13', end_date: '2026-04-13' },
      },
      { kind: 'text', text: 'No events.' },
    ]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    await agent.run(ctx);

    // DM: 1 sendMessage (init placeholder), edits for tool label + finalize
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
    expect(sender.editMessageText).toHaveBeenCalled();
    const firstEdit = (sender.editMessageText as ReturnType<typeof mock>).mock.calls[0]!;
    const labelHtml = firstEdit[2] as string;
    // The tool label should contain the human-readable name, not raw "get_events"
    expect(labelHtml).toContain('📅');
  });

  // ── Regressions for bugs found by code review ─────────────────────────────

  test('rejected tool-less answer is NOT persisted to chat_history', async () => {
    // Scripted rounds: round 1 = text (will be rejected by forced validator), round 2 = text (retry passes)
    // But we need to override validator behaviour. Use a custom impl that:
    //   - Round 1: plain text (agent loop)
    //   - Validator call: REJECT
    //   - Round 2 (retry): plain text (no tools — retry loop breaks)
    let round = 0;
    const impl = async (opts: StreamRoundOptions) => {
      if (isValidatorCall(opts)) {
        const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'REJECT: no tool used' };
        return {
          text: 'REJECT: no tool used',
          toolCalls: [],
          finishReason: 'stop' as const,
          assistantMessage: msg,
          providerUsed: 'mock-validator',
        };
      }
      round++;
      const text = round === 1 ? 'hallucinated answer' : 'corrected answer';
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: text };
      return {
        text,
        toolCalls: [],
        finishReason: 'stop' as const,
        assistantMessage: msg,
        providerUsed: 'mock',
      };
    };

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    const history = ctx.chatHistory.getRecent(USER_ID);
    // Must contain the user message and the corrected answer, NOT the hallucination
    const assistantRows = history.filter((h) => h.role === 'assistant');
    const hasHallucination = assistantRows.some((h) => h.content.includes('hallucinated answer'));
    expect(hasHallucination).toBe(false);
    const hasCorrected = assistantRows.some((h) => h.content.includes('corrected answer'));
    expect(hasCorrected).toBe(true);
  });

  test('legacy Anthropic content-block assistant rows are flattened to readable text', async () => {
    const legacyBlocks = JSON.stringify([
      { type: 'text', text: 'Hello from the old SDK' },
      { type: 'tool_use', id: 'x', name: 'get_events', input: {} },
    ]);
    ctx.chatHistory.save(USER_ID, 'user', 'hi');
    ctx.chatHistory.save(USER_ID, 'assistant', legacyBlocks);

    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = await agent.buildMessages(ctx, history);

    const assistantMsg = messages.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    // Must be a plain string containing the legacy text — NOT the raw JSON blob
    expect(typeof assistantMsg!.content).toBe('string');
    expect(assistantMsg!.content as string).toContain('Hello from the old SDK');
    expect(assistantMsg!.content as string).not.toContain('"type":"text"');
  });

  test('voice_message mode returns plain text without execution log HTML', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-03-20', end_date: '2026-03-20' },
      },
      { kind: 'text', text: 'You have 0 events today.' },
    ]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    const result = await agent.run({ ...ctx, inputMode: 'voice_message' });

    expect(result.responseText).toBe('You have 0 events today.');
    expect(result.responseText).not.toContain('<blockquote');
    expect(result.responseText).not.toContain('✅');
  });

  // ── In-run tool call dedup ─────────────────────────────────────────────────
  // Regression: a model that keeps calling render_day_image with the same date
  // (or any other tool with identical args) must NOT trigger the real handler
  // on every repeat — otherwise fire-and-forget render handlers spam the user
  // with duplicate photos inside a single agent run.

  test('duplicate tool calls with identical args are deduped within a run (no real execution)', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        // Same args — should be deduped
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-3',
        name: 'get_events',
        // Key-order variant — must still be detected as duplicate
        input: { end_date: '2026-04-16', start_date: '2026-04-16' },
      },
      { kind: 'text', text: 'No events.' },
    ]);

    // Spy on eventService.getEventsForDay — the real backing call for get_events.
    // It should fire exactly once; the other two are deduped.
    const originalGetEvents = ctx.eventService.getEventsInRange.bind(ctx.eventService);
    let realCallCount = 0;
    ctx.eventService.getEventsInRange = ((userId: number, start: string, end: string) => {
      realCallCount++;
      return originalGetEvents(userId, start, end);
    }) as typeof ctx.eventService.getEventsInRange;

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    const result = await agent.run(ctx);

    // All three tool calls recorded in the run result…
    expect(result.toolCalls.length).toBe(3);
    // …but the real backing service was invoked once.
    expect(realCallCount).toBe(1);
    // Two of the three results are synthetic DUPLICATE markers.
    const duplicateResults = result.toolResults.filter((r) => (r.output ?? '').includes('DUPLICATE'));
    expect(duplicateResults.length).toBe(2);
  });

  test('dedup key normalizes argument key order', async () => {
    // Two calls with same semantic args but different key order must be deduped.
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        input: { end_date: '2026-04-16', start_date: '2026-04-16' },
      },
      { kind: 'text', text: 'ok' },
    ]);

    let realCallCount = 0;
    const originalGetEvents = ctx.eventService.getEventsInRange.bind(ctx.eventService);
    ctx.eventService.getEventsInRange = ((userId: number, start: string, end: string) => {
      realCallCount++;
      return originalGetEvents(userId, start, end);
    }) as typeof ctx.eventService.getEventsInRange;

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(realCallCount).toBe(1);
  });

  test('run() error skips stall phrase and retry when wasExplicitInvocation is false', async () => {
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('provider failed') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    const retryEnqueue = mock(() => Promise.resolve());
    ctx.wasExplicitInvocation = false;
    ctx.retryEnqueue = retryEnqueue;
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    await agent.run(ctx);

    // No retry queued for non-explicit invocation
    expect(retryEnqueue).not.toHaveBeenCalled();
    // No stall assistant turn saved — history has only the user message
    const history = ctx.chatHistory.getRecent(USER_ID);
    const assistantRows = history.filter((h) => h.role === 'assistant');
    expect(assistantRows.length).toBe(0);
  });

  test('different args with same tool name are NOT deduped', async () => {
    const { impl } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        // Different date — must execute for real
        input: { start_date: '2026-04-17', end_date: '2026-04-17' },
      },
      { kind: 'text', text: 'ok' },
    ]);

    let realCallCount = 0;
    const originalGetEvents = ctx.eventService.getEventsInRange.bind(ctx.eventService);
    ctx.eventService.getEventsInRange = ((userId: number, start: string, end: string) => {
      realCallCount++;
      return originalGetEvents(userId, start, end);
    }) as typeof ctx.eventService.getEventsInRange;

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(realCallCount).toBe(2);
  });

  test('duplicate tool result is passed back to the model in the next round', async () => {
    // Model sees the DUPLICATE marker in the tool result and should use it to
    // understand the call was skipped. Verify the model input on round 3
    // contains the synthetic tool result for call-2.
    const { impl, calls } = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      {
        kind: 'tool',
        callId: 'call-2',
        name: 'get_events',
        input: { start_date: '2026-04-16', end_date: '2026-04-16' },
      },
      { kind: 'text', text: 'final' },
    ]);

    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    // The third model call (after 2 tool rounds) must see call-2's result,
    // and that result must contain DUPLICATE.
    const thirdCall = calls[2];
    expect(thirdCall).toBeDefined();
    const toolMessagesInThirdCall = thirdCall!.messages.filter((m) => m.role === 'tool');
    const call2Result = toolMessagesInThirdCall.find(
      (m) => 'tool_call_id' in m && (m as { tool_call_id: string }).tool_call_id === 'call-2',
    );
    expect(call2Result).toBeDefined();
    const content = (call2Result as { content: string }).content;
    expect(content).toContain('DUPLICATE');
  });

  // ── Regression: error delivery guarantee ────────────────────────────────

  test('run() catches stream error and delivers stall phrase to user', async () => {
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('All providers failed') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    const result = await agent.run(ctx);

    // REGRESSION: before the fix, an unhandled error could leave the user
    // with just ⏳ and no response. On error, a stall phrase from the declared
    // phrase set is appended (wasExplicitInvocation defaults to undefined, treated as explicit).
    const editCalls = (sender.editMessageText as ReturnType<typeof mock>).mock.calls;
    const finalEdit = editCalls[editCalls.length - 1] as unknown[];
    const finalText = finalEdit[2] as string;
    // The delivered text must be a member of the English stall-phrase set.
    const allPhrases = [...EN_AGENT_ERROR_PHRASES, ...RU_AGENT_ERROR_PHRASES];
    expect(allPhrases.some((phrase) => finalText.includes(phrase))).toBe(true);
    expect(allPhrases.some((phrase) => result.responseText.includes(phrase))).toBe(true);
  });

  test('run() in group mode (noPlaceholder) handles error without leaving orphan messages', async () => {
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('Provider timeout') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });
    ctx.isGroup = true;
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);

    const result = await agent.run(ctx);

    // In group mode (noPlaceholder), no ⏳ is sent. On error, the stall phrase
    // is delivered as a single message (no orphan ⏳ left behind).
    const sendCalls = (sender.sendMessage as ReturnType<typeof mock>).mock.calls;
    expect(sendCalls.length).toBe(1);
    const sentText = (sendCalls[0] as unknown[])[1] as string;
    const allPhrases = [...EN_AGENT_ERROR_PHRASES, ...RU_AGENT_ERROR_PHRASES];
    expect(allPhrases.some((phrase) => sentText.includes(phrase))).toBe(true);
    expect(allPhrases.some((phrase) => result.responseText.includes(phrase))).toBe(true);
  });

  test('agent catch block stall phrase is localized via t() for both languages', async () => {
    // Verify English stall phrase comes from the English phrase set.
    const { impl: implEn } = makeStreamImpl([{ kind: 'error', error: new Error('All providers failed') }]);
    const agentEn = new CalendarBotAgent(config, sender, { streamImpl: implEn });
    ctx.user = { ...ctx.user, language: 'en' };
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const resultEn = await agentEn.run(ctx);
    expect(
      EN_AGENT_ERROR_PHRASES.some((phrase) => resultEn.responseText.includes(phrase)),
      `EN responseText "${resultEn.responseText}" must contain an English stall phrase`,
    ).toBe(true);

    // Verify Russian stall phrase comes from the Russian phrase set. The
    // notice tracker deliberately suppresses a second apology within the
    // cooldown, so this second outage starts from a clean slate.
    aiFailureNotices.reset();
    const { impl: implRu } = makeStreamImpl([{ kind: 'error', error: new Error('All providers failed') }]);
    const agentRu = new CalendarBotAgent(config, sender, { streamImpl: implRu });
    ctx.user = { ...ctx.user, language: 'ru' };
    const resultRu = await agentRu.run(ctx);
    expect(
      RU_AGENT_ERROR_PHRASES.some((phrase) => resultRu.responseText.includes(phrase)),
      `RU responseText "${resultRu.responseText}" must contain a Russian stall phrase`,
    ).toBe(true);
  });
});
