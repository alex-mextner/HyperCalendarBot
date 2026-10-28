import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { AiDebugLogger } from '../../../src/services/ai/debug-logger.ts';
import type { StreamCallbacks, StreamRoundOptions } from '../../../src/services/ai/streaming.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { createAgentRunFixture, isValidatorCall, makeStreamImpl, USER_ID } from './agent-run-helpers.ts';

describe('CalendarBotAgent.run()', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;

  beforeEach(() => {
    ({ ctx, config, sender } = createAgentRunFixture());
  });

  test('run() with simple text response streams and saves history', async () => {
    const { impl } = makeStreamImpl([{ kind: 'text', text: 'Hi! Which day should I look at?' }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    await agent.run(ctx);

    expect(sender.sendMessage).toHaveBeenCalledTimes(1); // init placeholder
    expect(sender.editMessageText).toHaveBeenCalled(); // finalize

    const history = ctx.chatHistory.getRecent(USER_ID);
    expect(history.length).toBe(2);
    expect(history[0]!.role).toBe('user');
    expect(history[0]!.content).toBe('Show my events');
    expect(history[1]!.role).toBe('assistant');
    const parsed = JSON.parse(history[1]!.content) as OpenAI.ChatCompletionMessageParam;
    expect(parsed.role).toBe('assistant');
    expect(parsed.content).toBe('Hi! Which day should I look at?');
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
    expect(messages[2]!.content as string).toContain('Show my events');
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
    //   - Second validator call: APPROVE (a second REJECT must not be persisted)
    let round = 0;
    let validationCalls = 0;
    const impl = async (opts: StreamRoundOptions, cbs: StreamCallbacks = {}) => {
      if (isValidatorCall(opts)) {
        const verdict = validationCalls++ === 0 ? 'REJECT: no tool used' : 'APPROVE';
        const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: verdict };
        return {
          text: verdict,
          toolCalls: [],
          finishReason: 'stop' as const,
          assistantMessage: msg,
          providerUsed: 'mock-validator',
        };
      }
      round++;
      const text = round === 1 ? 'hallucinated answer' : 'corrected answer';
      // Stream like the real provider does, so the writer shows the approved retry text.
      cbs.onTextDelta?.(text);
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
});
