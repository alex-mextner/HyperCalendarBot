// test/services/ai/streaming-usage.test.ts
// Every provider attempt of aiStreamRound — answered, failed or passed over — leaves one usage row,
// and recording never changes what the caller gets.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { AiUsageRepository, type AiUsageRow } from '../../../src/database/repositories/ai-usage.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { resetModelRegistry } from '../../../src/services/ai/model-registry.ts';
import { estimatePromptSize } from '../../../src/services/ai/prompt-size.ts';
import { providerCircuitClock, resetProviderCircuit } from '../../../src/services/ai/provider-circuit.ts';
import { resetEligibility } from '../../../src/services/ai/provider-eligibility.ts';
import type { StreamRoundOptions } from '../../../src/services/ai/streaming.ts';
import { configureAiUsageRecording, flushAiUsageEvents } from '../../../src/services/ai/usage-recorder.ts';
import { dbLogger, resetLogOnce } from '../../../src/utils/logger.ts';

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

type Behavior =
  | { kind: 'text'; text: string; usage?: Usage }
  | { kind: 'throw'; error: Error }
  /** Never answers: the per-provider deadline has to end the attempt. */
  | { kind: 'hang' }
  /** 200 OK, no text, no tool calls; usage still arrives. */
  | { kind: 'empty'; usage?: Usage }
  /** Runs `before`, then fails — lets a test move a clock between attempts. */
  | { kind: 'throw-after'; error: Error; before: () => void }
  /** Yields each chunk after running its `before`, so a test can move the clock between chunks. */
  | { kind: 'timeline'; steps: { before: () => void; chunk: Chunk }[] };

interface Chunk {
  choices: { delta: { content?: string; tool_calls?: unknown[] }; finish_reason: string | null }[];
  usage?: Usage;
}

interface FakeRequest {
  model: string;
  max_tokens?: number;
  temperature?: number;
}

interface FakeProvider {
  client: { chat: { completions: { create: (params: FakeRequest) => Promise<AsyncIterable<Chunk>> } } };
  requests: FakeRequest[];
}

function makeProvider(...behaviors: Behavior[]): FakeProvider {
  const provider: FakeProvider = {
    requests: [],
    client: {
      chat: {
        completions: {
          create: async (params) => {
            provider.requests.push(params);
            const behavior = behaviors[Math.min(provider.requests.length - 1, behaviors.length - 1)];
            if (!behavior) throw new Error('fake provider has no behavior scripted');
            if (behavior.kind === 'throw') throw behavior.error;
            if (behavior.kind === 'throw-after') {
              behavior.before();
              throw behavior.error;
            }
            if (behavior.kind === 'hang') return new Promise<AsyncIterable<Chunk>>(() => {});
            async function* chunks(): AsyncGenerator<Chunk> {
              if (behavior?.kind === 'text') {
                yield { choices: [{ delta: { content: behavior.text }, finish_reason: null }] };
                yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
                if (behavior.usage) yield { choices: [], usage: behavior.usage };
              } else if (behavior?.kind === 'empty') {
                yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
                if (behavior.usage) yield { choices: [], usage: behavior.usage };
              } else if (behavior?.kind === 'timeline') {
                for (const step of behavior.steps) {
                  step.before();
                  yield step.chunk;
                }
              }
            }
            return chunks();
          },
        },
      },
    },
  };
  return provider;
}

/** The chain only touches `chat.completions.create`; the cast lives in this one factory. */
function asOpenAIClient(fake: FakeProvider['client']): OpenAI {
  return fake as unknown as OpenAI;
}

function apiError(status: number, message: string) {
  return new OpenAI.APIError(status, { error: { message } }, message, new Headers());
}

const USAGE: Usage = {
  prompt_tokens: 1200,
  completion_tokens: 80,
  total_tokens: 1280,
  prompt_tokens_details: { cached_tokens: 900 },
  completion_tokens_details: { reasoning_tokens: 30 },
};

const { providerClients, aiStreamRound } = await import('../../../src/services/ai/streaming.ts');
const realProviderClients = { ...providerClients };
const savedEnv = { ...process.env };
const realPerformanceNow = performance.now.bind(performance);

let zai: FakeProvider;
let hf: FakeProvider;
let claude: FakeProvider;
let db: Database;
let repo: AiUsageRepository;

function rows(): AiUsageRow[] {
  flushAiUsageEvents();
  return [...repo.iterateSince(0)];
}

beforeEach(() => {
  Object.assign(process.env, {
    BOT_TOKEN: 'test-token',
    REDIS_URL: 'redis://localhost:6379',
    ZAI_API_KEY: 'zai-key',
    ZAI_BASE_URL: 'https://zai.example/v1',
    ZAI_MODEL: 'glm-5.1',
    ZAI_FAST_MODEL: 'glm-5.1-air',
    HF_TOKEN: 'hf-token',
    HF_BASE_URL: 'https://hf.example/v1',
    HF_MODEL: 'hf-main',
    HF_FAST_MODEL: 'hf-fast',
    CLAUDE_API_TOKEN: 'claude-key',
    CLAUDE_MODEL: 'claude-sonnet-5-5',
    CLAUDE_FAST_MODEL: 'claude-haiku-5-5',
    AI_SMART_CHAIN: 'zai,hf,claude',
    AI_FAST_CHAIN: 'zai,hf,claude',
  });
  resetLogOnce();
  resetEligibility();
  resetProviderCircuit();
  resetModelRegistry();
  providerClients.zai = () => asOpenAIClient(zai.client);
  providerClients.hf = () => asOpenAIClient(hf.client);
  providerClients.claude = () => asOpenAIClient(claude.client);
  const unused = makeProvider({ kind: 'throw', error: new Error('must not be called') });
  zai = unused;
  hf = unused;
  claude = unused;
  db = new Database(':memory:');
  runMigrations(db, migrations);
  repo = new AiUsageRepository(db);
  configureAiUsageRecording(repo);
});

afterEach(() => {
  configureAiUsageRecording(null);
  resetProviderCircuit();
  providerCircuitClock.now = () => Date.now();
  performance.now = realPerformanceNow;
  process.env = { ...savedEnv };
  Object.assign(providerClients, realProviderClients);
  db.close();
});

function ask(overrides: Partial<StreamRoundOptions> = {}) {
  return aiStreamRound({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, ...overrides });
}

describe('aiStreamRound records one usage row per provider attempt', () => {
  test('an answered attempt records provider, model, chain, purpose, duration and every reported token count', async () => {
    zai = makeProvider({ kind: 'text', text: 'hello', usage: USAGE });
    const before = Date.now();

    await ask({ purpose: 'agent', requestId: 'req-42' });

    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      provider: 'zai',
      model: 'glm-5.1',
      chain: 'smart',
      purpose: 'agent',
      outcome: 'ok',
      errorClass: null,
      httpStatus: null,
      skipReason: null,
      promptTokens: 1200,
      completionTokens: 80,
      reasoningTokens: 30,
      cachedTokens: 900,
      requestId: 'req-42',
    });
    expect(row?.at).toBeGreaterThanOrEqual(before);
    expect(row?.at).toBeLessThanOrEqual(Date.now());
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('the fast chain is recorded as fast and an unlabeled caller as unlabeled', async () => {
    zai = makeProvider({ kind: 'text', text: 'hello', usage: USAGE });

    await ask({ fast: true });

    expect(rows().map((row) => [row.chain, row.model, row.purpose])).toEqual([['fast', 'glm-5.1-air', 'unlabeled']]);
  });

  test('a provider that reports no usage leaves its token columns NULL, never 0', async () => {
    zai = makeProvider({ kind: 'text', text: 'hello' });

    await ask();

    const [row] = rows();
    expect(row).toMatchObject({
      outcome: 'ok',
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
    });
  });

  test('a usage object that omits some details keeps those fields NULL and the reported ones as given', async () => {
    zai = makeProvider({
      kind: 'text',
      text: 'hello',
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    });

    await ask();

    expect(rows()[0]).toMatchObject({
      promptTokens: 10,
      completionTokens: 0,
      reasoningTokens: null,
      cachedTokens: null,
    });
  });

  test('a fallback leaves a failed row for every provider that failed and an ok row for the one that answered', async () => {
    zai = makeProvider({ kind: 'throw', error: apiError(402, 'Insufficient balance') });
    hf = makeProvider({ kind: 'throw', error: apiError(401, 'Invalid API key') });
    claude = makeProvider({ kind: 'text', text: 'answer', usage: USAGE });

    const result = await ask({ purpose: 'agent' });

    expect(result.text).toBe('answer');
    expect(rows().map((row) => [row.provider, row.outcome, row.errorClass, row.httpStatus, row.promptTokens])).toEqual([
      ['zai', 'error', 'quota', 402, null],
      ['hf', 'error', 'auth', 401, null],
      ['claude', 'ok', null, null, 1200],
    ]);
  });

  test('server errors, rate limits and rejected requests are classified from the status', async () => {
    zai = makeProvider({ kind: 'throw', error: apiError(503, 'overloaded') });
    hf = makeProvider({ kind: 'throw', error: apiError(429, 'Rate limit reached for model') });
    claude = makeProvider({ kind: 'throw', error: apiError(400, 'Invalid JSON payload') });

    await expect(ask()).rejects.toThrow('All 3 AI providers failed');

    expect(rows().map((row) => [row.provider, row.errorClass, row.httpStatus])).toEqual([
      ['zai', 'server', 503],
      ['hf', 'rate_limit', 429],
      ['claude', 'bad_request', 400],
    ]);
  });

  test('a provider that never answers is a timeout row whose duration is the time spent waiting', async () => {
    zai = makeProvider({ kind: 'hang' });
    hf = makeProvider({ kind: 'text', text: 'second' });

    const result = await ask({ providerTimeoutMs: 40 });

    expect(result.text).toBe('second');
    const [timedOut, answered] = rows();
    expect(timedOut).toMatchObject({ provider: 'zai', outcome: 'error', errorClass: 'timeout', httpStatus: null });
    expect(timedOut?.durationMs).toBeGreaterThanOrEqual(30);
    expect(answered).toMatchObject({ provider: 'hf', outcome: 'ok' });
  });

  test('a caller abort is recorded as aborted and the chain stops there', async () => {
    const controller = new AbortController();
    zai = makeProvider({
      kind: 'throw-after',
      error: new OpenAI.APIUserAbortError(),
      before: () => controller.abort(),
    });

    await expect(ask({ signal: controller.signal })).rejects.toThrow();

    expect(rows().map((row) => [row.provider, row.outcome, row.errorClass])).toEqual([['zai', 'error', 'aborted']]);
  });

  test('a 200 OK with no output is an empty row that still keeps the tokens the provider billed', async () => {
    zai = makeProvider({ kind: 'empty', usage: USAGE });
    hf = makeProvider({ kind: 'text', text: 'second' });

    await ask();

    const [empty, answered] = rows();
    expect(empty).toMatchObject({
      provider: 'zai',
      outcome: 'error',
      errorClass: 'empty',
      httpStatus: null,
      promptTokens: 1200,
      completionTokens: 80,
      reasoningTokens: 30,
    });
    expect(answered).toMatchObject({ provider: 'hf', outcome: 'ok' });
  });

  test('an empty answer without any usage object leaves the tokens NULL', async () => {
    zai = makeProvider({ kind: 'empty' });
    hf = makeProvider({ kind: 'text', text: 'second' });

    await ask();

    expect(rows()[0]).toMatchObject({ errorClass: 'empty', promptTokens: null, completionTokens: null });
  });

  test('an open circuit is recorded as a skip with the status that opened it, and sends nothing', async () => {
    zai = makeProvider({ kind: 'throw', error: apiError(402, 'Insufficient balance') });
    hf = makeProvider({ kind: 'text', text: 'first' }, { kind: 'text', text: 'second' });

    await ask();
    await ask();

    expect(zai.requests).toHaveLength(1);
    expect(rows().map((row) => [row.provider, row.outcome, row.errorClass, row.skipReason, row.httpStatus])).toEqual([
      ['zai', 'error', 'quota', null, 402],
      ['hf', 'ok', null, null, null],
      ['zai', 'skipped', null, 'circuit_open', 402],
      ['hf', 'ok', null, null, null],
    ]);
  });

  test('a provider benched after a request that was too large with the tool catalog is a skip on the next round', async () => {
    const tools = [{ type: 'function' as const, function: { name: 'list_events', parameters: {} } }];
    zai = makeProvider({ kind: 'throw', error: apiError(413, 'Request too large for model') });
    hf = makeProvider({ kind: 'text', text: 'first' }, { kind: 'text', text: 'second' });

    await ask({ tools });
    await ask({ tools });

    expect(zai.requests).toHaveLength(1);
    expect(rows().map((row) => [row.provider, row.outcome, row.errorClass, row.skipReason])).toEqual([
      ['zai', 'error', 'rate_limit', null],
      ['hf', 'ok', null, null],
      ['zai', 'skipped', null, 'eligibility_bench'],
      ['hf', 'ok', null, null],
    ]);
  });

  test('providers left unattempted when the round deadline passes are recorded as skipped', async () => {
    let clock = 0;
    performance.now = () => clock;
    zai = makeProvider({
      kind: 'throw-after',
      error: apiError(503, 'slow'),
      before: () => {
        clock = 29_800;
      },
    });
    hf = makeProvider({ kind: 'throw', error: new Error('must not be called') });
    claude = makeProvider({ kind: 'throw', error: new Error('must not be called') });

    await expect(ask()).rejects.toThrow();

    expect(rows().map((row) => [row.provider, row.outcome, row.skipReason])).toEqual([
      ['zai', 'error', null],
      ['hf', 'skipped', 'round_deadline'],
      ['claude', 'skipped', 'round_deadline'],
    ]);
  });

  test('durations are stored as whole milliseconds, matching the INTEGER column', async () => {
    let clock = 0;
    performance.now = () => {
      clock += 12.7;
      return clock;
    };
    zai = makeProvider({ kind: 'throw', error: apiError(503, 'down') });
    hf = makeProvider({ kind: 'text', text: 'answer' });

    await ask();

    const durations = rows().map((row) => row.durationMs);
    expect(durations).toHaveLength(2);
    for (const duration of durations) expect(Number.isInteger(duration)).toBe(true);
  });

  test('a Claude-only chain records claude as the provider with its tokens, request shape untouched', async () => {
    process.env.AI_SMART_CHAIN = 'claude';
    claude = makeProvider({ kind: 'text', text: 'pong', usage: USAGE });

    await ask({ purpose: 'probe', maxTokens: 300 });

    expect(rows()).toMatchObject([
      { provider: 'claude', model: 'claude-sonnet-5-5', outcome: 'ok', promptTokens: 1200, completionTokens: 80 },
    ]);
    expect(claude.requests[0]?.max_tokens).toBe(128_000);
    expect(claude.requests[0]?.temperature).toBeUndefined();
  });

  describe('first-token and generation time', () => {
    let clock = 0;
    const at = (ms: number) => () => {
      clock = ms;
    };
    const content = (text: string, finish: string | null = null): Chunk => ({
      choices: [{ delta: { content: text }, finish_reason: finish }],
    });

    beforeEach(() => {
      clock = 0;
      performance.now = () => clock;
    });

    test('first_token_ms is request start to the first content delta, generation_ms first to last content delta', async () => {
      zai = makeProvider({
        kind: 'timeline',
        steps: [
          { before: at(700), chunk: content('Hel') },
          { before: at(1000), chunk: content('lo') },
          { before: at(1400), chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
          { before: at(1450), chunk: { choices: [], usage: USAGE } },
        ],
      });

      await ask();

      expect(rows()).toMatchObject([{ outcome: 'ok', firstTokenMs: 700, generationMs: 300 }]);
    });

    test('a single content delta has generation_ms 0, a measured value rather than unknown', async () => {
      zai = makeProvider({ kind: 'timeline', steps: [{ before: at(500), chunk: content('hi', 'stop') }] });

      await ask();

      expect(rows()).toMatchObject([{ firstTokenMs: 500, generationMs: 0 }]);
    });

    test('a tool call counts as the first token and its last fragment ends the window', async () => {
      const toolDelta = (args: string, id?: string, name?: string): Chunk => ({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: args } },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      zai = makeProvider({
        kind: 'timeline',
        steps: [
          { before: at(900), chunk: toolDelta('{"a":', 'call_1', 'get_events') },
          { before: at(1100), chunk: toolDelta('1}') },
          { before: at(1500), chunk: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } },
        ],
      });

      await ask({ tools: [{ type: 'function', function: { name: 'get_events', parameters: { type: 'object' } } }] });

      expect(rows()).toMatchObject([{ firstTokenMs: 900, generationMs: 200 }]);
    });

    test('an attempt that fails keeps both NULL, and the next provider that answers records its own', async () => {
      zai = makeProvider({ kind: 'empty', usage: USAGE });
      hf = makeProvider({ kind: 'timeline', steps: [{ before: at(300), chunk: content('ok', 'stop') }] });

      await ask();

      expect(rows().map((row) => [row.provider, row.outcome, row.firstTokenMs, row.generationMs])).toEqual([
        ['zai', 'error', null, null],
        ['hf', 'ok', 300, 0],
      ]);
    });

    test('timing is stored as whole milliseconds, matching the INTEGER column', async () => {
      zai = makeProvider({
        kind: 'timeline',
        steps: [
          { before: at(100.4), chunk: content('a') },
          { before: at(250.2), chunk: content('b', 'stop') },
        ],
      });

      await ask();

      const [row] = rows();
      expect(row?.firstTokenMs).toBe(100);
      expect(row?.generationMs).toBe(150);
    });
  });

  test('every sent attempt records the estimated prompt components of the round; a skip records none', async () => {
    zai = makeProvider({ kind: 'throw', error: apiError(503, 'down') });
    hf = makeProvider({ kind: 'text', text: 'answer' });
    const messages = [
      { role: 'system' as const, content: 'You are a calendar assistant.' },
      { role: 'user' as const, content: 'earlier question' },
      { role: 'assistant' as const, content: 'earlier answer' },
      { role: 'user' as const, content: 'new question' },
    ];
    const tools = [{ type: 'function' as const, function: { name: 'get_events', parameters: { type: 'object' } } }];

    await ask({ messages, tools });

    const expected = estimatePromptSize(messages, tools);
    expect(expected.toolCount).toBe(1);
    expect(expected.messageCount).toBe(4);
    const pick = (row: AiUsageRow) => ({
      systemPromptTokens: row.systemPromptTokens,
      toolCatalogTokens: row.toolCatalogTokens,
      historyTokens: row.historyTokens,
      userTokens: row.userTokens,
      toolCount: row.toolCount,
      messageCount: row.messageCount,
    });
    const written = rows();
    expect(written.map((row) => [row.provider, row.outcome])).toEqual([
      ['zai', 'error'],
      ['hf', 'ok'],
    ]);
    for (const row of written) expect(pick(row)).toEqual(expected);
  });

  test('a skipped attempt has no prompt size: nothing was assembled for it', async () => {
    process.env.AI_SMART_CHAIN = 'zai,hf';
    zai = makeProvider({ kind: 'throw', error: apiError(413, 'Request too large for model') });
    hf = makeProvider({ kind: 'text', text: 'first' }, { kind: 'text', text: 'second' });
    const tools = [{ type: 'function' as const, function: { name: 'get_events', parameters: { type: 'object' } } }];

    await ask({ tools });
    await ask({ tools });

    const skipped = rows().find((row) => row.outcome === 'skipped');
    expect(skipped).toMatchObject({
      systemPromptTokens: null,
      toolCatalogTokens: null,
      historyTokens: null,
      userTokens: null,
      toolCount: null,
      messageCount: null,
    });
  });

  test('stores no text: the row holds only the documented columns', async () => {
    zai = makeProvider({ kind: 'text', text: 'SECRET-ANSWER', usage: USAGE });

    await ask({ messages: [{ role: 'user', content: 'SECRET-PROMPT' }], userId: 777_000_111 });

    expect(JSON.stringify(rows())).not.toMatch(/SECRET|777000111/);
  });
});

describe('recording never disturbs the answer', () => {
  test('a database failure is logged as a warning and the user still gets the answer', async () => {
    const warn = spyOn(dbLogger, 'warn').mockImplementation(() => {});
    configureAiUsageRecording({
      insertMany: () => {
        throw new Error('database is locked');
      },
    });
    zai = makeProvider({ kind: 'text', text: 'the answer', usage: USAGE });

    const result = await ask();
    flushAiUsageEvents();

    expect(result.text).toBe('the answer');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ err: expect.any(Error) });
    warn.mockRestore();
  });

  test('the answer is returned before the row is written', async () => {
    let written = 0;
    configureAiUsageRecording({
      insertMany: (events) => {
        written += events.length;
      },
    });
    zai = makeProvider({ kind: 'text', text: 'the answer' });

    await ask();

    expect(written).toBe(0);
    flushAiUsageEvents();
    expect(written).toBe(1);
  });

  test('without a configured sink nothing is recorded and nothing breaks', async () => {
    configureAiUsageRecording(null);
    zai = makeProvider({ kind: 'text', text: 'the answer' });

    expect((await ask()).text).toBe('the answer');
    expect([...repo.iterateSince(0)]).toEqual([]);
  });
});
