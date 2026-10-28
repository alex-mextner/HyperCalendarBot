import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { EN_AGENT_ERROR_PHRASES, RU_AGENT_ERROR_PHRASES, t } from '../../../src/config/constants.ts';
import { AssistantMessageCodec, aiFailureNotices, CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { HistorySummarizer } from '../../../src/services/ai/history-summarizer.ts';
import { ProviderSafetyStopError } from '../../../src/services/ai/streaming.ts';
import { TelegramStreamWriter } from '../../../src/services/ai/telegram-stream.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import {
  createAgentRunFixture,
  createOwnedEvent,
  isValidatorCall,
  makeStreamImpl,
  USER_ID,
} from './agent-run-helpers.ts';

describe('CalendarBotAgent.run()', () => {
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;

  beforeEach(() => {
    ({ ctx, config, sender } = createAgentRunFixture());
  });

  test.each([0, 1.5, Number.NaN, 90_001])('rejects invalid request timeout configuration: %s', (requestTimeoutMs) => {
    expect(() => new CalendarBotAgent(config, sender, { requestTimeoutMs })).toThrow();
  });

  test('a validator safety stop is not converted into an execution retry', async () => {
    const enqueue = mock(async () => true);
    ctx.retryEnqueue = enqueue;
    const script = makeStreamImpl([{ kind: 'text', text: 'A response requiring validation.' }]);
    let calls = 0;
    const impl: typeof script.impl = async (opts, cbs) => {
      calls++;
      if (isValidatorCall(opts))
        throw new ProviderSafetyStopError({
          classification: 'safety',
          finishReason: 'content_filter',
          chunkCount: 1,
          choiceCount: 1,
          toolFragmentCount: 0,
          maxOutputTokens: 256,
          messageCount: 2,
          toolCount: 0,
          usage: null,
        });
      return script.impl(opts, cbs);
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    expect(calls).toBe(2);
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.responseText).toContain('provider stopped');
    expect(result.responseText).not.toContain('A response requiring validation.');
  });

  test('an expired explanation-retry budget uses the user language', async () => {
    ctx.user.language = 'ru';
    const started = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(started);
    const append = spyOn(TelegramStreamWriter.prototype, 'appendText');
    const script = makeStreamImpl([{ kind: 'text', text: 'Unverified draft.' }]);
    const impl: typeof script.impl = async (options, callbacks) => {
      const result = await script.impl(options, callbacks);
      if (isValidatorCall(options)) {
        clock.mockReturnValue(started + 100_000);
        return { ...result, text: 'REJECT: missing tool evidence' };
      }
      return result;
    };
    try {
      await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
      expect(append.mock.calls.some(([text]) => text.includes(t('ru').agent_timeout))).toBe(true);
      expect(append.mock.calls.some(([text]) => text.includes('Timeout reached.'))).toBe(false);
    } finally {
      append.mockRestore();
      clock.mockRestore();
    }
  });

  test('one request budget includes validation and does not poison the next request', async () => {
    let slow = true;
    let validationSignal: AbortSignal | undefined;
    const script = makeStreamImpl([
      { kind: 'text', text: 'Unverified first answer.' },
      { kind: 'text', text: 'Second ready.' },
    ]);
    const impl: typeof script.impl = async (opts, cbs) => {
      if (isValidatorCall(opts)) {
        validationSignal = opts.signal;
        if (slow) await Bun.sleep(350);
      } else if (slow) await Bun.sleep(35);
      return script.impl(opts, cbs);
    };
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl, requestTimeoutMs: 70 });
    const started = performance.now();
    const first = await agent.run(ctx);
    expect(performance.now() - started).toBeLessThan(250);
    expect(validationSignal?.aborted).toBe(true);
    expect(first.responseText).not.toContain('Unverified first answer.');
    slow = false;
    const second = await agent.run(ctx);
    expect(second.responseText).toContain('Second ready.');
  });

  test('a completed write survives a later deadline without scheduling a replay', async () => {
    const event = createOwnedEvent(ctx);
    const enqueue = mock(async () => true);
    ctx.retryEnqueue = enqueue;
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'update-once',
        name: 'update_event',
        input: { event_id: event.id, title: 'Confirmed title' },
      },
      { kind: 'text', text: 'late unsupported claim' },
    ]);
    let rounds = 0;
    const impl: typeof script.impl = async (opts, cbs) => {
      if (++rounds > 1) await Bun.sleep(350);
      return script.impl(opts, cbs);
    };
    const result = await new CalendarBotAgent(config, sender, { streamImpl: impl, requestTimeoutMs: 70 }).run(ctx);
    expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('Confirmed title');
    expect(result.toolCalls.filter((call) => call.name === 'update_event')).toHaveLength(1);
    expect(result.responseText).not.toContain('late unsupported claim');
    expect(result.responseText).toContain('Completed');
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('stalled history cache is bounded before the first model call', async () => {
    const script = makeStreamImpl([
      { kind: 'text', text: 'history summary' },
      { kind: 'text', text: 'late answer' },
    ]);
    const summarizer = new HistorySummarizer(
      {
        get: async () => {
          await Bun.sleep(350);
          return null;
        },
        set: async () => null,
      },
      script.impl,
    );
    ctx.conversationLogger.logAiTurn(USER_ID, {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'historical-read', type: 'function', function: { name: 'get_events', arguments: '{}' } }],
    });
    ctx.conversationLogger.logToolResults(USER_ID, [
      {
        role: 'tool',
        tool_call_id: 'historical-read',
        content: 'synthetic history '.repeat(80),
      },
    ]);
    const agent = new CalendarBotAgent({ ...config, summarizer }, sender, {
      streamImpl: script.impl,
      requestTimeoutMs: 50,
    });
    const started = performance.now();
    const result = await agent.run(ctx);
    expect(performance.now() - started).toBeLessThan(250);
    expect(script.calls).toHaveLength(0);
    expect(result.responseText).not.toContain('late answer');
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

  test('run() error skips stall phrase and retry when wasExplicitInvocation is false', async () => {
    const { impl } = makeStreamImpl([{ kind: 'error', error: new Error('provider failed') }]);
    const agent = new CalendarBotAgent(config, sender, { streamImpl: impl });

    const retryEnqueue = mock(() => Promise.resolve(true));
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
