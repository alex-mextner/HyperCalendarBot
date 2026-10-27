// test/services/ai/streaming-round-attempts.test.ts
// The pieces aiStreamRound sequences, exercised one by one: which slots a round tries, what is recorded for the
// ones it never reaches, what a failed attempt does (safety stop = no fallback, caller abort = rethrow, anything
// else = next slot) and the aggregate error of an exhausted round. No module is mocked: slots are fakes and the
// usage sink, circuit and bench are real and reset around every test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import OpenAI from 'openai';
import type { AiUsageEvent } from '../../../src/database/repositories/ai-usage.repository.ts';
import { resetProviderCircuit } from '../../../src/services/ai/provider-circuit.ts';
import {
  isBlocked,
  noteFailureForEligibility,
  resetEligibility,
} from '../../../src/services/ai/provider-eligibility.ts';
import { handleAttemptFailure } from '../../../src/services/ai/streaming/attempt-failure.ts';
import { EmptyProviderResponseError, ProviderSafetyStopError } from '../../../src/services/ai/streaming/errors.ts';
import {
  type AdmittedAttempt,
  createRoundState,
  exhaustedRoundError,
  type RoundState,
  recordDeadlineSkips,
  runAdmittedAttempt,
  selectAttempts,
} from '../../../src/services/ai/streaming/round-attempts.ts';
import type { ProviderSlot } from '../../../src/services/ai/streaming/slot.ts';
import type {
  EmptyResponseDiagnostics,
  StreamCallbacks,
  StreamRoundOptions,
  StreamRoundResult,
} from '../../../src/services/ai/streaming/types.ts';
import { configureAiUsageRecording, flushAiUsageEvents } from '../../../src/services/ai/usage-recorder.ts';

const recorded: AiUsageEvent[] = [];

function fakeSlot(provider: ProviderSlot['provider'], label: string, stream?: ProviderSlot['stream']): ProviderSlot {
  return {
    label,
    provider,
    configuredModel: `${provider}-model`,
    circuitKey: `${provider}:test`,
    getClient: () => {
      throw new Error('the fake slot never opens a client');
    },
    stream:
      stream ??
      (async () => {
        throw new Error('the fake slot never streams');
      }),
  };
}

const ZAI = fakeSlot('zai', 'z.ai');
const CLAUDE = fakeSlot('claude', 'Claude');
const HF = fakeSlot('hf', 'HF');

function stateOf(options: Partial<StreamRoundOptions> = {}, callbacks: StreamCallbacks = {}): RoundState {
  return createRoundState({ messages: [], maxTokens: 64, purpose: 'agent', requestId: 'req-1', ...options }, callbacks);
}

function admitted(slot: ProviderSlot): AdmittedAttempt {
  return {
    slot,
    requestModel: slot.configuredModel,
    circuit: { key: slot.circuitKey, provider: slot.provider, label: slot.label, chain: 'smart' },
    admission: { kind: 'allow' },
    attemptAt: Date.now(),
    attemptStartedAt: performance.now(),
  };
}

function recordedNow(): AiUsageEvent[] {
  flushAiUsageEvents();
  return recorded.splice(0);
}

function diagnostics(): EmptyResponseDiagnostics {
  return {
    classification: 'safety',
    choiceCount: 1,
    toolFragmentCount: 0,
    finishReason: 'content_filter',
    chunkCount: 2,
    maxOutputTokens: 64,
    messageCount: 1,
    toolCount: 0,
    usage: null,
  };
}

function rateLimited(): Error {
  return OpenAI.APIError.generate(429, { message: 'rate limit exceeded' }, 'rate limit exceeded', new Headers());
}

function tooLarge(): Error {
  return OpenAI.APIError.generate(413, { message: 'Request too large' }, 'Request too large', new Headers());
}

function badRequest(): Error {
  return OpenAI.APIError.generate(400, { message: 'bad request' }, 'bad request', new Headers());
}

beforeEach(() => {
  recorded.length = 0;
  configureAiUsageRecording({
    insertMany: (events) => {
      recorded.push(...events);
    },
  });
  resetEligibility();
  resetProviderCircuit();
});

afterEach(() => {
  configureAiUsageRecording(null);
  resetEligibility();
  resetProviderCircuit();
});

describe('selectAttempts', () => {
  test('a benched provider is skipped and recorded as an eligibility skip', () => {
    noteFailureForEligibility('zai', 'smart', false, 429, 'rate limit exceeded', undefined);
    const state = stateOf();
    expect(selectAttempts(state, [ZAI, CLAUDE, HF])).toEqual([CLAUDE, HF]);
    const rows = recordedNow();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'zai',
      outcome: 'skipped',
      skipReason: 'eligibility_bench',
      chain: 'smart',
      purpose: 'agent',
      requestId: 'req-1',
    });
  });

  test('when every provider is benched they are all tried and nothing is recorded as skipped', () => {
    for (const provider of ['zai', 'claude'] as const) {
      noteFailureForEligibility(provider, 'smart', false, 429, 'rate limit exceeded', undefined);
    }
    expect(isBlocked('claude', 'smart', false)).toBe(true);
    expect(selectAttempts(stateOf(), [ZAI, CLAUDE])).toEqual([ZAI, CLAUDE]);
    expect(recordedNow()).toEqual([]);
  });

  test('an empty chain stays empty', () => {
    expect(selectAttempts(stateOf(), [])).toEqual([]);
  });

  test('the fast chain reads its own bench, not the smart one', () => {
    noteFailureForEligibility('zai', 'smart', false, 429, 'rate limit exceeded', undefined);
    expect(selectAttempts(stateOf({ fast: true }), [ZAI, CLAUDE])).toEqual([ZAI, CLAUDE]);
    expect(recordedNow()).toEqual([]);
  });
});

describe('recordDeadlineSkips', () => {
  test('every unattempted slot gets a round_deadline skip row and none is a failure', () => {
    const state = stateOf({ fast: true });
    recordDeadlineSkips(state, [CLAUDE, HF]);
    const rows = recordedNow();
    expect(rows.map((row) => [row.provider, row.outcome, row.skipReason, row.chain])).toEqual([
      ['claude', 'skipped', 'round_deadline', 'fast'],
      ['hf', 'skipped', 'round_deadline', 'fast'],
    ]);
    expect(rows.every((row) => row.durationMs === null)).toBe(true);
    expect(state.failures).toEqual([]);
  });

  test('an empty tail records nothing', () => {
    recordDeadlineSkips(stateOf(), []);
    expect(recordedNow()).toEqual([]);
  });
});

describe('handleAttemptFailure', () => {
  test('a safety stop rethrows the same error, records it, and never becomes a fallback failure', () => {
    const state = stateOf();
    const stop = new ProviderSafetyStopError(diagnostics());
    expect(() => handleAttemptFailure(state, admitted(CLAUDE), stop)).toThrow(stop);
    expect(state.failures).toEqual([]);
    const rows = recordedNow();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'claude', outcome: 'error', errorClass: 'other', httpStatus: null });
  });

  test('a safety stop tells the caller to drop shown output, and only when some was shown', () => {
    let switched = 0;
    const quiet = stateOf({}, { onProviderSwitch: () => switched++ });
    expect(() => handleAttemptFailure(quiet, admitted(CLAUDE), new ProviderSafetyStopError(diagnostics()))).toThrow();
    expect(switched).toBe(0);

    const shown = stateOf({}, { onProviderSwitch: () => switched++ });
    shown.wrappedCallbacks.onTextDelta?.('partial');
    expect(() => handleAttemptFailure(shown, admitted(CLAUDE), new ProviderSafetyStopError(diagnostics()))).toThrow();
    expect(switched).toBe(1);
  });

  test('a caller abort is recorded as a failure and then rethrown without benching the provider', () => {
    const controller = new AbortController();
    const state = stateOf({ signal: controller.signal });
    controller.abort();
    const aborted = rateLimited();
    expect(() => handleAttemptFailure(state, admitted(ZAI), aborted)).toThrow(aborted);
    expect(state.failures).toHaveLength(1);
    expect(isBlocked('zai', 'smart', false)).toBe(false);
    expect(recordedNow()).toHaveLength(1);
  });

  test('an ordinary failure is kept for the aggregate and the round goes on', () => {
    const state = stateOf();
    handleAttemptFailure(state, admitted(ZAI), new EmptyProviderResponseError('z.ai'));
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]).toMatchObject({ providerId: 'zai', transient: false });
    const rows = recordedNow();
    expect(rows[0]).toMatchObject({ provider: 'zai', outcome: 'error', errorClass: 'empty' });
  });

  test('a too-large request carrying tools benches the provider for tool requests, a 400 never does', () => {
    const state = stateOf({ tools: [{ type: 'function', function: { name: 'calculate', parameters: {} } }] });
    handleAttemptFailure(state, admitted(ZAI), tooLarge());
    handleAttemptFailure(state, admitted(CLAUDE), badRequest());
    expect(isBlocked('zai', 'smart', true)).toBe(true);
    expect(isBlocked('zai', 'smart', false)).toBe(false);
    expect(isBlocked('claude', 'smart', true)).toBe(false);
    expect(state.failures.map((failure) => failure.status)).toEqual([413, 400]);
  });

  test('output already shown is discarded exactly once before the next provider starts', () => {
    let switched = 0;
    const state = stateOf({}, { onProviderSwitch: () => switched++ });
    state.wrappedCallbacks.onToolCallStart?.('calculate');
    expect(state.partialOutputShown).toBe(true);
    handleAttemptFailure(state, admitted(ZAI), new Error('connection reset'));
    expect(switched).toBe(1);
    expect(state.partialOutputShown).toBe(false);
    handleAttemptFailure(state, admitted(CLAUDE), new Error('connection reset'));
    expect(switched).toBe(1);
  });
});

describe('runAdmittedAttempt', () => {
  const result: StreamRoundResult = {
    text: 'hi',
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: 'hi' },
    providerUsed: 'z.ai',
  };

  test('an answer is returned and recorded as one ok row with unknown usage kept null', async () => {
    const slot = fakeSlot('zai', 'z.ai', async () => result);
    const state = stateOf();
    await expect(runAdmittedAttempt(state, admitted(slot), 30_000)).resolves.toBe(result);
    const rows = recordedNow();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'zai',
      outcome: 'ok',
      promptTokens: null,
      completionTokens: null,
      costMicroUsd: null,
    });
  });

  test('a provider callback after the attempt signal aborted is ignored', async () => {
    const seen: string[] = [];
    let release: () => void = () => {};
    const slot = fakeSlot(
      'zai',
      'z.ai',
      (_model, options, cbs) =>
        new Promise<StreamRoundResult>((_resolve, reject) => {
          cbs.onTextDelta?.('before');
          release = () => {
            cbs.onTextDelta?.('after abort');
            reject(new Error('late failure'));
          };
          options.signal?.addEventListener('abort', () => release());
        }),
    );
    const state = stateOf({ providerTimeoutMs: 20 }, { onTextDelta: (text) => seen.push(text) });
    await expect(runAdmittedAttempt(state, admitted(slot), 30_000)).rejects.toThrow();
    expect(seen).toEqual(['before']);
  });
});

describe('exhaustedRoundError', () => {
  test('counts attempts and fallbacks and defers the alert when an unexposed tool was the cause', () => {
    const state = stateOf({ deferOutageAlert: true });
    state.actualAttempts = 2;
    state.failures.push(
      {
        provider: 'z.ai (m)',
        providerId: 'zai',
        model: 'm',
        message: "attempted to call tool 'calculate' which was not in request.tools",
        transient: false,
      },
      { provider: 'Claude (m)', providerId: 'claude', model: 'm', message: 'boom', transient: true },
    );
    const error = exhaustedRoundError(state);
    expect(error.name).toBe('AllProvidersFailedError');
    expect(error.failures).toBe(state.failures);
    expect(error.roundMetrics).toMatchObject({ attemptCount: 2, fallbackCount: 1 });
    expect(error.deferredAlertChain).toBe('smart');
    expect(error.unexposedToolNames()).toEqual(['calculate']);
  });
});
