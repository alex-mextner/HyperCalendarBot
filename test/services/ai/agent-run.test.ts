import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { AiDebugLogger } from '../../../src/services/ai/debug-logger.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
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
    expect(sender.editMessageText).toHaveBeenCalled(); // finalize with error text

    // Only the user row — assistant turn was never produced
    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(1);
    expect(history[0]!.role).toBe('user');
  });

  test('run() handles error with Russian language user', async () => {
    ctx.user = { ...ctx.user, language: 'ru' };
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('boom') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    await agent.run(ctx);

    const editCalls = (sender.editMessageText as ReturnType<typeof mock>).mock.calls;
    const lastEditText = editCalls[editCalls.length - 1]?.[2] as string;
    expect(lastEditText).toContain('Произошла ошибка');
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

  test('buildMessages uses per-chat history in group context', () => {
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
    const { messages } = agent.buildMessages(ctx, personalHistory);

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

  test('[SKIP] response in DM is NOT discarded', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: '[SKIP]' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.isGroup = false;
    await agent.run(ctx);

    expect(sender.editMessageText).toHaveBeenCalled();
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

    // Only one stream round — end_conversation has stopLoop=true via the tool handler
    expect(calls.length).toBe(1);
    expect(result.toolCalls.some((tc) => tc.name === 'end_conversation')).toBe(true);
    expect(endSession).toHaveBeenCalledWith(USER_ID);
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

  test('legacy Anthropic content-block assistant rows are flattened to readable text', () => {
    const legacyBlocks = JSON.stringify([
      { type: 'text', text: 'Hello from the old SDK' },
      { type: 'tool_use', id: 'x', name: 'get_events', input: {} },
    ]);
    ctx.chatHistory.save(USER_ID, 'user', 'hi');
    ctx.chatHistory.save(USER_ID, 'assistant', legacyBlocks);

    const agent = new CalendarBotAgent(config, sender);
    const history = ctx.chatHistory.getRecent(USER_ID);
    const { messages } = agent.buildMessages(ctx, history);

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
});
