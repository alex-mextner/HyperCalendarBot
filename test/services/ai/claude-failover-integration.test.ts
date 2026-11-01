import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import OpenAI from 'openai';
import type { AiUsageEvent } from '../../../src/database/repositories/ai-usage.repository.ts';
import { createClaudeClient, withClaudeCredentials } from '../../../src/services/ai/claude-client-pool.ts';
import { resetModelRegistry } from '../../../src/services/ai/model-registry.ts';
import {
  admitProvider,
  providerCircuitClock,
  resetProviderCircuit,
} from '../../../src/services/ai/provider-circuit.ts';
import { resetEligibility } from '../../../src/services/ai/provider-eligibility.ts';
import { handleAttemptFailure } from '../../../src/services/ai/streaming/attempt-failure.ts';
import { describeFailure, settleCircuitAfterFailure } from '../../../src/services/ai/streaming/failure.ts';
import { admitSlot, createRoundState, runAdmittedAttempt } from '../../../src/services/ai/streaming/round-attempts.ts';
import { _resetStreamingUsageCompatibilityForTest, streamingSlot } from '../../../src/services/ai/streaming/slot.ts';
import { configureAiUsageRecording, flushAiUsageEvents } from '../../../src/services/ai/usage-recorder.ts';

const actualNow = performance.now.bind(performance);
const actualCircuitNow = providerCircuitClock.now;
const events: AiUsageEvent[] = [];
const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'synthetic read-only request' }];
function sentRequest(input: string | URL | Request, init?: RequestInit): Request {
  return input instanceof Request ? new Request(input, init) : new Request(String(input), init);
}
function rejected(status: number, message = 'unavailable', retryAfter = '60'): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { 'retry-after': retryAfter } });
}
function answer(): Response {
  const chunks = [
    {
      id: 'synthetic',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'claude-synthetic',
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
    },
    {
      id: 'synthetic',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'claude-synthetic',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
const clientOptions = { baseURL: 'https://api.anthropic.com/v1', maxRetries: 0 };
function state(fast = false, cap = 2000) {
  return createRoundState(
    { messages, maxTokens: 64, fast, providerTimeoutMs: cap, requestId: 'synthetic-request' },
    {},
  );
}
beforeEach(() => {
  events.length = 0;
  resetProviderCircuit();
  resetEligibility();
  resetModelRegistry();
  _resetStreamingUsageCompatibilityForTest();
  configureAiUsageRecording({
    insertMany(batch) {
      events.push(...batch);
    },
  });
});
afterEach(() => {
  configureAiUsageRecording(null);
  resetProviderCircuit();
  resetEligibility();
  resetModelRegistry();
  _resetStreamingUsageCompatibilityForTest();
  providerCircuitClock.now = actualCircuitNow;
  spyOn(performance, 'now').mockRestore();
});

test('the real runner shares its remaining admitted deadline with both credentials', async () => {
  const sent: string[] = [];
  const client = createClaudeClient(['primary', 'backup'], {
    ...clientOptions,
    fetch: async (input, init) => {
      const request = sentRequest(input, init);
      const token = request.headers.get('authorization') ?? '';
      sent.push(token);
      if (token === 'Bearer primary')
        return new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }),
        );
      return answer();
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'remaining-budget');
  const round = state(false, 2000);
  const attempt = admitSlot(round, slot);
  if (!attempt) throw new Error('expected admission');
  const started = actualNow();
  const result = await runAdmittedAttempt(round, attempt, 1000);
  expect(result.text).toBe('ok');
  expect(sent).toEqual(['Bearer primary', 'Bearer backup']);
  expect(round.actualAttempts).toBe(2);
  expect(actualNow() - started).toBeLessThan(1300);
});

test('compatibility recovery divides only the header budget remaining after its first rejection', async () => {
  const sent: string[] = [];
  let calls = 0;
  const client = createClaudeClient(['primary', 'backup'], {
    ...clientOptions,
    fetch: async (input, init) => {
      const request = sentRequest(input, init);
      const token = request.headers.get('authorization') ?? '';
      sent.push(token);
      calls++;
      if (calls === 1) {
        await Bun.sleep(300);
        return rejected(400, 'stream_options include_usage is not supported');
      }
      if (token === 'Bearer primary')
        return new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }),
        );
      return answer();
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'compatibility-budget');
  const round = state(false, 2000);
  const attempt = admitSlot(round, slot);
  if (!attempt) throw new Error('expected admission');
  expect((await runAdmittedAttempt(round, attempt, 1000)).text).toBe('ok');
  expect(sent).toEqual(['Bearer primary', 'Bearer primary', 'Bearer backup']);
  expect(round.actualAttempts).toBe(3);
});

test('each HTTP attempt has its own usage row and the winning stream excludes primary delay', async () => {
  let clock = 0;
  spyOn(performance, 'now').mockImplementation(() => clock);
  const client = createClaudeClient(['primary', 'backup'], {
    ...clientOptions,
    fetch: async (input, init) => {
      const token = sentRequest(input, init).headers.get('authorization');
      if (token === 'Bearer primary') {
        clock = 50;
        return rejected(429);
      }
      clock = 60;
      return answer();
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'attempt-accounting');
  const round = state();
  const attempt = admitSlot(round, slot);
  if (!attempt) throw new Error('expected admission');
  const result = await runAdmittedAttempt(round, attempt, 2000);
  flushAiUsageEvents();
  expect(result.metrics?.attemptCount).toBe(2);
  expect(result.metrics?.firstUsableSinceAttemptMs).toBe(10);
  expect(result.metrics?.providerDurationMs).toBe(10);
  expect(result.metrics?.totalDurationMs).toBe(60);
  expect(events.map((event) => [event.outcome, event.httpStatus, event.durationMs, event.requestId])).toEqual([
    ['error', 429, 50, 'synthetic-request'],
    ['ok', null, 10, 'synthetic-request'],
  ]);
});

test('a shared cooling pool creates a skipped row with zero Claude HTTP attempts and allows fallback', async () => {
  let calls = 0;
  const client = createClaudeClient(['primary', 'backup'], {
    ...clientOptions,
    fetch: async () => {
      calls++;
      return rejected(429);
    },
  });
  await withClaudeCredentials(
    client,
    (candidate, signal) =>
      candidate.chat.completions.create({ model: 'claude-synthetic', messages, max_tokens: 32 }, { signal }),
    { timeoutMs: 2000 },
  ).catch(() => undefined);
  expect(calls).toBe(2);
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-fast-synthetic', 'unopened-fast-circuit');
  const round = state(true);
  const attempt = admitSlot(round, slot);
  if (!attempt) throw new Error('expected admission');
  try {
    await runAdmittedAttempt(round, attempt, 2000);
    throw new Error('expected cooldown skip');
  } catch (error) {
    handleAttemptFailure(round, attempt, error);
  }
  expect(calls).toBe(2);
  expect(round.actualAttempts).toBe(0);
  flushAiUsageEvents();
  expect(events.map((event) => [event.provider, event.outcome, event.skipReason])).toEqual([
    ['claude', 'skipped', 'credential_cooldown'],
  ]);
  expect(admitSlot(state(true), slot)).not.toBeNull();
  const fallbackClient = new OpenAI({ apiKey: 'synthetic-hf', fetch: async () => answer() });
  const fallback = streamingSlot('HF', 'hf', () => fallbackClient, 'hf-synthetic', 'fallback-circuit');
  const fallbackAttempt = admitSlot(round, fallback);
  if (!fallbackAttempt) throw new Error('expected fallback admission');
  expect((await runAdmittedAttempt(round, fallbackAttempt, 2000)).text).toBe('ok');
  expect(round.actualAttempts).toBe(1);
});

for (const backupStatus of [429, 401]) {
  test(`the shared circuit reopens for the earliest key after terminal HTTP ${backupStatus}`, async () => {
    let now = 1_000_000;
    providerCircuitClock.now = () => now;
    const client = createClaudeClient(['primary', 'backup'], {
      ...clientOptions,
      fetch: async (input, init) => {
        const primary = sentRequest(input, init).headers.get('authorization') === 'Bearer primary';
        return rejected(primary ? 429 : backupStatus, 'synthetic unavailable', primary ? '1' : '86400');
      },
    });
    let terminal: unknown;
    await withClaudeCredentials(
      client,
      (candidate, signal) =>
        candidate.chat.completions.create({ model: 'claude-synthetic', messages, max_tokens: 32 }, { signal }),
      { timeoutMs: 2000 },
    ).catch((error: unknown) => {
      terminal = error;
    });
    expect(terminal).toBeInstanceOf(OpenAI.APIError);
    const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', `earliest-${backupStatus}`);
    const round = state();
    const attempt = admitSlot(round, slot);
    if (!attempt) throw new Error('expected admission');
    settleCircuitAfterFailure(attempt.circuit, attempt.admission, terminal, describeFailure(slot, terminal), false);
    expect(admitProvider(attempt.circuit).kind).toBe('skip');
    now += 1001;
    expect(admitProvider(attempt.circuit).kind).toBe('probe');
  });
}

test('recovery accounting includes a usage-option rejection before switching credentials', async () => {
  let clock = 0;
  let calls = 0;
  spyOn(performance, 'now').mockImplementation(() => clock);
  const client = createClaudeClient(['primary', 'backup'], {
    ...clientOptions,
    fetch: async () => {
      calls++;
      clock += 10;
      if (calls === 1) return rejected(400, 'stream_options include_usage is not supported');
      if (calls === 2) return rejected(429);
      return answer();
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'recovery-three-attempts');
  const round = state();
  const attempt = admitSlot(round, slot);
  if (!attempt) throw new Error('expected admission');
  expect((await runAdmittedAttempt(round, attempt, 2000)).text).toBe('ok');
  flushAiUsageEvents();
  expect(round.actualAttempts).toBe(3);
  expect(events.map((event) => [event.outcome, event.httpStatus, event.durationMs])).toEqual([
    ['error', 400, 10],
    ['error', 429, 10],
    ['ok', null, 10],
  ]);
});

test('recovery accounting records terminal model rejection once when no next completion starts', async () => {
  let clock = 0;
  let calls = 0;
  spyOn(performance, 'now').mockImplementation(() => clock);
  const client = createClaudeClient(['primary', 'backup'], {
    ...clientOptions,
    fetch: async (input, init) => {
      calls++;
      const request = sentRequest(input, init);
      if (request.url.endsWith('/models')) {
        clock = 50;
        return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
      }
      clock = 5;
      return rejected(404, 'model not found');
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-missing', 'recovery-terminal-attempt');
  const round = state();
  const attempt = admitSlot(round, slot);
  if (!attempt) throw new Error('expected admission');
  const error = await runAdmittedAttempt(round, attempt, 2000).then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(OpenAI.APIError);
  handleAttemptFailure(round, attempt, error);
  flushAiUsageEvents();
  expect(calls).toBe(2);
  expect(round.actualAttempts).toBe(1);
  expect(events.map((event) => [event.outcome, event.httpStatus, event.durationMs])).toEqual([['error', 404, 5]]);
});

test('a backup failure cannot open the shared circuit after another request recovers an already-attempted primary', async () => {
  let clock = 1_000_000;
  const wallClock = spyOn(Date, 'now').mockImplementation(() => clock);
  let primaryCalls = 0;
  let failBackup: ((value: Response) => void) | undefined;
  const sent: (string | null)[] = [];
  const client = createClaudeClient(['primary', 'backup'], {
    ...clientOptions,
    fetch: async (input, init) => {
      const token = sentRequest(input, init).headers.get('authorization');
      sent.push(token);
      if (token === 'Bearer backup')
        return new Promise<Response>((resolve) => {
          failBackup = resolve;
        });
      primaryCalls++;
      return primaryCalls === 1
        ? rejected(401, 'revoked', '300')
        : new Response(
            JSON.stringify({
              id: 'synthetic',
              object: 'chat.completion',
              created: 0,
              model: 'claude-synthetic',
              choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
    },
  });
  const invoke = () =>
    withClaudeCredentials(
      client,
      (candidate, signal) =>
        candidate.chat.completions.create({ model: 'claude-synthetic', messages, max_tokens: 32 }, { signal }),
      { timeoutMs: 2000 },
    );
  try {
    const concurrent = invoke().catch((error: unknown) => error);
    await Bun.sleep(1);
    clock += 300_001;
    expect((await invoke()).choices[0]?.message.content).toBe('ok');
    failBackup?.(rejected(401, 'revoked backup', '300'));
    const terminal = await concurrent;
    expect(terminal).toBeInstanceOf(OpenAI.APIError);
    const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', 'concurrent-pool-recovery');
    const attempt = admitSlot(state(), slot);
    if (!attempt) throw new Error('expected admission');
    settleCircuitAfterFailure(attempt.circuit, attempt.admission, terminal, describeFailure(slot, terminal), false);
    expect(admitProvider(attempt.circuit).kind).toBe('allow');
    expect(sent).toEqual(['Bearer primary', 'Bearer backup', 'Bearer primary']);
  } finally {
    wallClock.mockRestore();
  }
});

for (const [message, expectedNext] of [
  // Model-specific: neither key is unhealthy, so the shared circuit must stay inconclusive.
  ['API key does not have permission to use this model', 'allow'],
  // Account-level: both keys are cooled, so the shared circuit opens.
  ['This organization has been disabled', 'skip'],
] as const) {
  test(`both keys answering 403 "${message}" leaves the shared circuit ${expectedNext === 'allow' ? 'closed' : 'open'}`, async () => {
    let calls = 0;
    const client = createClaudeClient(['primary', 'backup'], {
      ...clientOptions,
      fetch: async () => {
        calls++;
        return rejected(403, message);
      },
    });
    let terminal: unknown;
    await withClaudeCredentials(
      client,
      (candidate, signal) =>
        candidate.chat.completions.create({ model: 'claude-synthetic', messages, max_tokens: 32 }, { signal }),
      { timeoutMs: 2000 },
    ).catch((error: unknown) => {
      terminal = error;
    });
    expect(calls).toBe(2);
    const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', `both-403-${expectedNext}`);
    const attempt = admitSlot(state(), slot);
    if (!attempt) throw new Error('expected admission');
    settleCircuitAfterFailure(attempt.circuit, attempt.admission, terminal, describeFailure(slot, terminal), false);
    expect(admitProvider(attempt.circuit).kind).toBe(expectedNext);
  });
}

for (const [index, tokens] of [
  ['primary', 'bad\u200btoken'],
  ['bad\u200btoken', 'primary'],
  ['primary', 'bad\u200btoken', ' primary '],
].entries()) {
  test(`a malformed key beside one usable key keeps single-key behavior on the real round path (ordering ${index})`, async () => {
    const sent: string[] = [];
    const client = createClaudeClient(tokens, {
      ...clientOptions,
      fetch: async (input, init) => {
        sent.push(sentRequest(input, init).headers.get('authorization') ?? '');
        return sent.length === 1 ? rejected(503) : answer();
      },
    });
    const slot = streamingSlot('Claude', 'claude', () => client, 'claude-synthetic', `one-usable-key-${index}`);
    const first = state(false, 2000);
    const firstAttempt = admitSlot(first, slot);
    if (!firstAttempt) throw new Error('expected admission');
    try {
      await runAdmittedAttempt(first, firstAttempt, 2000);
      throw new Error('expected 503');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAI.APIError);
      expect((error as InstanceType<typeof OpenAI.APIError>).status).toBe(503);
      handleAttemptFailure(first, firstAttempt, error);
    }
    // The provider circuit is not under test; only the local credential cooldown is.
    resetProviderCircuit();
    const second = state(false, 2000);
    const secondAttempt = admitSlot(second, slot);
    if (!secondAttempt) throw new Error('expected admission');
    expect((await runAdmittedAttempt(second, secondAttempt, 2000)).text).toBe('ok');
    expect(sent).toEqual(['Bearer primary', 'Bearer primary']);
    flushAiUsageEvents();
    expect(events.filter((event) => event.skipReason === 'credential_cooldown')).toEqual([]);
  });
}
