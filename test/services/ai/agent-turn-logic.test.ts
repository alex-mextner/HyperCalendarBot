// Pure and near-pure pieces extracted from CalendarBotAgent: history repair, what is persisted,
// the callback guard of a late provider, the retry-store bounds and the evidence guard's plan.
// No module mocks and no provider: every case drives the extracted function directly.
import { beforeEach, describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { hasPersistablePayload, withoutSkippedToolCalls } from '../../../src/services/ai/agent/assistant-turn.ts';
import { relevantHistoryRows, withRetryQuestion } from '../../../src/services/ai/agent/conversation.ts';
import { announceFailure } from '../../../src/services/ai/agent/failure-announcement.ts';
import { guardCallbacks } from '../../../src/services/ai/agent/measured-stream.ts';
import { type MessageParam, sanitizeMessages } from '../../../src/services/ai/agent/message-sanitizer.ts';
import { mayStoreRetry, storeRetryWithin } from '../../../src/services/ai/agent/retry-store.ts';
import { remainingRequestMs, requestBudgetSpent } from '../../../src/services/ai/agent/run-limits.ts';
import type { ToolRunLedger } from '../../../src/services/ai/agent/tool-round.ts';
import { answersDirectMessage, planGuard } from '../../../src/services/ai/agent/turn-finish.ts';
import { createTurnState } from '../../../src/services/ai/agent/turn-state.ts';
import { pairsWeekdayWithOtherDate, senderForTurn } from '../../../src/services/ai/agent/turn-writer.ts';
import { aiFailureNotices } from '../../../src/services/ai/agent.ts';
import { ProviderSafetyStopError } from '../../../src/services/ai/streaming.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { WriteOutcomes } from '../../../src/services/ai/write-outcomes.ts';
import { createAgentRunFixture } from './agent-run-helpers.ts';

type ToolCall = OpenAI.ChatCompletionMessageToolCall;

function safetyStop(): ProviderSafetyStopError {
  return new ProviderSafetyStopError({
    classification: 'safety',
    choiceCount: 1,
    toolFragmentCount: 0,
    finishReason: 'content_filter',
    chunkCount: 1,
    maxOutputTokens: 4096,
    messageCount: 1,
    toolCount: 0,
    usage: null,
  });
}

function call(id: string): ToolCall {
  return { id, type: 'function', function: { name: 'get_events', arguments: '{}' } };
}

function assistantCalling(ids: string[], content: string | null = null): MessageParam {
  return { role: 'assistant', content, tool_calls: ids.map(call) };
}

function toolResult(id: string, content = 'ok'): MessageParam {
  return { role: 'tool', tool_call_id: id, content };
}

describe('sanitizeMessages', () => {
  test('keeps a complete call block and each result once', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'q' },
      assistantCalling(['a', 'b']),
      toolResult('a'),
      toolResult('b'),
      toolResult('a', 'second answer to the same call'),
    ];
    expect(sanitizeMessages(messages)).toEqual([
      { role: 'user', content: 'q' },
      assistantCalling(['a', 'b']),
      toolResult('a'),
      toolResult('b'),
    ]);
  });

  test('an orphaned call keeps its text and loses its calls and its results', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'q' },
      assistantCalling(['a', 'b'], '  checking  '),
      toolResult('a'),
      { role: 'user', content: 'next' },
    ];
    expect(sanitizeMessages(messages)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'checking' },
      { role: 'user', content: 'next' },
    ]);
  });

  test('an orphaned call without text disappears altogether', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'q' },
      assistantCalling(['a']),
      { role: 'user', content: 'next' },
    ];
    expect(sanitizeMessages(messages)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'user', content: 'next' },
    ]);
  });

  test('a result whose call row was cut off is dropped', () => {
    const messages: MessageParam[] = [toolResult('lost'), { role: 'user', content: 'q' }];
    expect(sanitizeMessages(messages)).toEqual([{ role: 'user', content: 'q' }]);
  });

  test('a history that starts with an assistant turn gets a placeholder user, after system messages', () => {
    const messages: MessageParam[] = [
      { role: 'system', content: 's' },
      { role: 'assistant', content: 'hello again' },
    ];
    expect(sanitizeMessages(messages)).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: '...' },
      { role: 'assistant', content: 'hello again' },
    ]);
  });
});

describe('assistant turn persistence', () => {
  test('skipped calls are stripped and the rest kept', () => {
    const kept = withoutSkippedToolCalls(assistantCalling(['a', 'b'], 'text'), new Set(['a']));
    expect(kept).toEqual({ role: 'assistant', content: 'text', tool_calls: [call('b')] });
  });

  test('a turn whose every call is skipped keeps only its text', () => {
    expect(withoutSkippedToolCalls(assistantCalling(['a'], 'text'), new Set(['a']))).toEqual({
      role: 'assistant',
      content: 'text',
    });
    expect(withoutSkippedToolCalls(assistantCalling(['a']), new Set(['a']))).toEqual({
      role: 'assistant',
      content: null,
    });
  });

  test('a turn with nothing to skip is returned as is', () => {
    const turn = assistantCalling(['a']);
    expect(withoutSkippedToolCalls(turn, undefined)).toBe(turn);
    expect(withoutSkippedToolCalls(turn, new Set())).toBe(turn);
    expect(withoutSkippedToolCalls(turn, new Set(['other']))).toBe(turn);
  });

  test('only a turn with text or calls is worth persisting', () => {
    expect(hasPersistablePayload({ role: 'assistant', content: null })).toBe(false);
    expect(hasPersistablePayload({ role: 'assistant', content: '   ' })).toBe(false);
    expect(hasPersistablePayload({ role: 'assistant', content: 'hi' })).toBe(true);
    expect(hasPersistablePayload(assistantCalling(['a']))).toBe(true);
  });
});

describe('guardCallbacks', () => {
  function recording() {
    const seen: string[] = [];
    return {
      seen,
      callbacks: {
        onTextDelta: (text: string) => seen.push(`text:${text}`),
        onToolCallStart: (name: string) => seen.push(`tool:${name}`),
        onProviderSwitch: () => seen.push('switch'),
      },
    };
  }

  test('forwards while the call is live', () => {
    const { seen, callbacks } = recording();
    const guarded = guardCallbacks(callbacks, new AbortController().signal, () => true);
    guarded.onTextDelta?.('a');
    guarded.onToolCallStart?.('t');
    guarded.onProviderSwitch?.();
    expect(seen).toEqual(['text:a', 'tool:t', 'switch']);
  });

  test('ignores a producer that outlives its call', () => {
    const { seen, callbacks } = recording();
    let active = true;
    const guarded = guardCallbacks(callbacks, new AbortController().signal, () => active);
    active = false;
    guarded.onTextDelta?.('late');
    guarded.onToolCallStart?.('late');
    guarded.onProviderSwitch?.();
    expect(seen).toEqual([]);
  });

  test('ignores a producer after its signal aborted', () => {
    const { seen, callbacks } = recording();
    const controller = new AbortController();
    const guarded = guardCallbacks(callbacks, controller.signal, () => true);
    controller.abort();
    guarded.onTextDelta?.('late');
    expect(seen).toEqual([]);
  });

  test('tolerates a caller without callbacks', () => {
    const guarded = guardCallbacks(undefined, new AbortController().signal, () => true);
    expect(() => guarded.onTextDelta?.('x')).not.toThrow();
  });
});

describe('request budget', () => {
  test('is spent exactly at the timeout', () => {
    expect(requestBudgetSpent(1_000, 500, 1_499)).toBe(false);
    expect(requestBudgetSpent(1_000, 500, 1_500)).toBe(true);
  });

  test('what is left never drops below 1 ms, so a deadline signal still aborts promptly', () => {
    expect(remainingRequestMs(1_000, 500, 1_200)).toBe(300);
    expect(remainingRequestMs(1_000, 500, 1_500)).toBe(1);
    expect(remainingRequestMs(1_000, 500, 9_999)).toBe(1);
  });
});

describe('retry store', () => {
  test('reports a stored retry and a declined one', async () => {
    expect(await storeRetryWithin(async () => true, 'm', 1, 50)).toBe('stored');
    expect(await storeRetryWithin(async () => false, 'm', 1, 50)).toBe('gave_up');
  });

  test('a store that throws is not stored', async () => {
    const failing = async () => {
      throw new Error('queue down');
    };
    expect(await storeRetryWithin(failing, 'm', 1, 50)).toBe('not_stored');
  });

  test('a store that never answers is unknown, not not_stored: the job may still land', async () => {
    const hung = () => new Promise<boolean>(() => {});
    expect(await storeRetryWithin(hung, 'm', 1, 5)).toBe('unknown');
  });

  describe('eligibility', () => {
    let ctx: AgentContext;
    beforeEach(() => {
      ctx = createAgentRunFixture().ctx;
    });
    const clean = { responseUnverified: false, mayHaveMutated: false };

    test('an ordinary failure may be retried', () => {
      expect(mayStoreRetry(ctx, new Error('boom'), clean)).toBe(true);
    });

    test('a write that may have landed is never replayed', () => {
      expect(mayStoreRetry(ctx, new Error('boom'), { ...clean, mayHaveMutated: true })).toBe(false);
    });

    test('explanation repair does not replay the original request', () => {
      expect(mayStoreRetry(ctx, new Error('boom'), { ...clean, responseUnverified: true })).toBe(false);
    });

    test('a provider safety stop is not retried', () => {
      expect(mayStoreRetry(ctx, safetyStop(), clean)).toBe(false);
    });

    test('needs a retry queue, a user-sent request and a non-supplement run', () => {
      expect(mayStoreRetry({ ...ctx, retryEnqueue: undefined }, new Error('boom'), clean)).toBe(false);
      expect(mayStoreRetry({ ...ctx, wasExplicitInvocation: false }, new Error('boom'), clean)).toBe(false);
      expect(mayStoreRetry({ ...ctx, supplementMode: true }, new Error('boom'), clean)).toBe(false);
    });
  });
});

describe('conversation helpers', () => {
  test('a retry restores the question the stored history no longer ends with', () => {
    const { ctx } = createAgentRunFixture();
    const stored: MessageParam[] = [{ role: 'assistant', content: 'one sec' }];
    const ordered = withRetryQuestion({ ...ctx, retryAttempt: 1 }, stored, [...stored]);
    expect(ordered.at(-1)).toEqual({ role: 'user', content: ctx.messageText });
  });

  test('a question already last in history is not asked twice, and a first attempt adds nothing', () => {
    const { ctx } = createAgentRunFixture();
    const stored: MessageParam[] = [{ role: 'user', content: `[2026-01-01 10:00:00] ${ctx.messageText}` }];
    expect(withRetryQuestion({ ...ctx, retryAttempt: 1 }, stored, [...stored])).toEqual(stored);
    expect(withRetryQuestion(ctx, [], [])).toEqual([]);
  });

  test('a blank retry message adds no empty user turn', () => {
    const { ctx } = createAgentRunFixture();
    expect(withRetryQuestion({ ...ctx, retryAttempt: 2, messageText: '   ' }, [], [])).toEqual([]);
  });

  test('a private chat reads the history it was given, a group its own', () => {
    const { ctx } = createAgentRunFixture();
    const given = ctx.chatHistory.getRecent(ctx.user.telegram_id, 30);
    expect(relevantHistoryRows(ctx, given, 50)).toBe(given);
  });
});

describe('turn writer', () => {
  // Sunday 2026-09-27; the 28th is a Monday.
  const now = new Date('2026-09-27T21:00:00Z');

  test('a tool argument pairing a weekday with another weekday date hides the tool details', () => {
    expect(pairsWeekdayWithOtherDate({ question: 'среда, 28 сентября?' }, 'Europe/Belgrade', now)).toBe(true);
    expect(pairsWeekdayWithOtherDate({ options: ['ok', 'ср 28/09'] }, 'Europe/Belgrade', now)).toBe(true);
  });

  test('consistent or non-text arguments are shown', () => {
    expect(pairsWeekdayWithOtherDate({ question: 'понедельник, 28 сентября?', n: 3 }, 'Europe/Belgrade', now)).toBe(
      false,
    );
    expect(pairsWeekdayWithOtherDate({}, 'Europe/Belgrade', now)).toBe(false);
  });

  test('a supplement writes through a sender that delivers nothing', async () => {
    const { ctx, sender } = createAgentRunFixture();
    expect(senderForTurn(ctx, sender)).toBe(sender);
    const silent = senderForTurn({ ...ctx, supplementMode: true }, sender);
    expect(silent).not.toBe(sender);
    expect(await silent.sendMessage(ctx.chatId, 'text')).toEqual({ message_id: 0 });
    expect(sender.sendMessage).not.toHaveBeenCalled();
  });
});

describe('evidence guard plan', () => {
  function ledgerWith(writeOutcomes = new WriteOutcomes()): ToolRunLedger {
    return {
      allToolCalls: [],
      allToolResults: [],
      toolEvidence: [],
      seenToolCallKeys: new Set(),
      writeOutcomes,
    };
  }

  test('a clean normal turn is not guarded and not silent', () => {
    const { ctx } = createAgentRunFixture();
    const state = createTurnState();
    state.termination = 'normal';
    expect(planGuard(ctx, state, false, ledgerWith())).toEqual({
      evidence: null,
      silent: false,
      validationNotice: null,
      guarded: false,
    });
  });

  test('an unverified answer is guarded and carries the unverified notice', () => {
    const { ctx } = createAgentRunFixture();
    const state = createTurnState();
    state.termination = 'unverified';
    state.responseUnverified = true;
    const plan = planGuard(ctx, state, false, ledgerWith());
    expect(plan.guarded).toBe(true);
    expect(plan.silent).toBe(false);
    expect(plan.validationNotice).toBeTruthy();
  });

  test('unresolved weekdays are reported instead of the generic unverified notice', () => {
    const { ctx } = createAgentRunFixture();
    const state = createTurnState();
    state.termination = 'unverified';
    state.responseUnverified = true;
    const generic = planGuard(ctx, state, false, ledgerWith()).validationNotice;
    state.unresolvedWeekdays = [
      { phrase: 'среда, 28 сентября', date: '2026-09-28', said: 'Wednesday', actual: 'Monday', nearest: '2026-09-30' },
    ];
    const weekday = planGuard(ctx, state, false, ledgerWith()).validationNotice;
    expect(weekday).toBeTruthy();
    expect(weekday).not.toBe(generic);
  });

  test('a run the user did not ask for stays silent', () => {
    const { ctx } = createAgentRunFixture();
    const state = createTurnState();
    state.termination = 'error';
    const plan = planGuard({ ...ctx, wasExplicitInvocation: false }, state, true, ledgerWith());
    expect(plan.silent).toBe(true);
    expect(plan.guarded).toBe(true);
    expect(plan.validationNotice).toBeNull();
  });

  test('an error termination is guarded even with nothing to report', () => {
    const { ctx } = createAgentRunFixture();
    const state = createTurnState();
    state.termination = 'error';
    expect(planGuard(ctx, state, true, ledgerWith()).guarded).toBe(true);
  });

  test('only a direct, answered-by-prose private request needs the unanswered fallback', () => {
    const { ctx } = createAgentRunFixture();
    const state = createTurnState();
    state.termination = 'normal';
    const open = { evidence: null, silent: false, validationNotice: null, guarded: false };
    expect(answersDirectMessage(ctx, state, false, open)).toBe(true);
    expect(answersDirectMessage(ctx, state, true, open)).toBe(false);
    expect(answersDirectMessage(ctx, state, false, { ...open, silent: true })).toBe(false);
    expect(answersDirectMessage({ ...ctx, isGroup: true }, state, false, open)).toBe(false);
    expect(answersDirectMessage({ ...ctx, unprompted: true }, state, false, open)).toBe(false);
    expect(answersDirectMessage({ ...ctx, inputMode: 'live_call' }, state, false, open)).toBe(false);
    state.termination = 'waiting';
    expect(answersDirectMessage(ctx, state, false, open)).toBe(false);
  });
});

describe('failure announcement', () => {
  beforeEach(() => aiFailureNotices.reset());

  function announce(overrides: Partial<Parameters<typeof announceFailure>[0]>) {
    const { ctx } = createAgentRunFixture();
    const written: string[] = [];
    const saved: string[] = [];
    announceFailure({
      ctx,
      error: new Error('boom'),
      writer: { appendText: (text) => written.push(text) },
      retry: 'stored',
      shuttingDown: false,
      saveTurn: (text) => saved.push(text),
      ...overrides,
    });
    return { written, saved };
  }

  test('a stored retry gets one stall line, saved to history as written', () => {
    const { written, saved } = announce({});
    expect(saved).toHaveLength(1);
    expect(written).toEqual([`\n\n${saved[0]}`]);
  });

  test('a supplement or an unrequested run says nothing', () => {
    const { ctx } = createAgentRunFixture();
    expect(announce({ ctx: { ...ctx, supplementMode: true } }).written).toEqual([]);
    expect(announce({ ctx: { ...ctx, wasExplicitInvocation: false } }).written).toEqual([]);
  });

  test('a retry attempt stays quiet unless the outage is permanent', () => {
    const { ctx } = createAgentRunFixture();
    expect(announce({ ctx: { ...ctx, retryAttempt: 1 } }).written).toEqual([]);
  });

  test('a give-up line that already closed the chain is not repeated', () => {
    expect(announce({ retry: 'gave_up' }).written).toEqual([]);
    expect(announce({ retry: 'gave_up', shuttingDown: true }).written).toEqual([]);
  });

  test('a shutdown promises a comeback only for a stored retry', () => {
    const stored = announce({ shuttingDown: true, retry: 'stored' }).saved[0];
    const notStored = announce({ shuttingDown: true, retry: 'not_stored' }).saved[0];
    const unknown = announce({ shuttingDown: true, retry: 'unknown' }).saved[0];
    expect(new Set([stored, notStored, unknown]).size).toBe(3);
  });

  test('a safety stop is told without the failure separator', () => {
    const { written, saved } = announce({ error: safetyStop() });
    expect(saved).toHaveLength(1);
    expect(written).toEqual(saved);
  });
});
