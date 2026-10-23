import { expect, test } from 'bun:test';
import OpenAI from 'openai';
import { Budget } from '../../../scripts/model-quality/budget.ts';
import { fixtures } from '../../../scripts/model-quality/fixtures.ts';
import { candidateFor } from '../../../scripts/model-quality/models.ts';
import {
  type RunLimits,
  rejectedDraft,
  runScenario,
  type ScenarioRole,
} from '../../../scripts/model-quality/runner.ts';
import type { RoundFn } from '../../../scripts/model-quality/slot.ts';
import { REPAIR_RETRY_NUDGE } from '../../../src/services/ai/repair-nudge.ts';
import { EmptyProviderResponseError, type StreamRoundResult } from '../../../src/services/ai/streaming.ts';

const candidate = candidateFor('deepseek41-flash', 'openrouter');
const today = fixtures.find((f) => f.id === 'today')!;
const limits: RunLimits = { maxRounds: 4, scenarioDeadlineMs: 5_000, attemptTimeoutMs: 1_000 };

interface TestUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  costUsd?: number;
}

function toolRound(
  calls: { name: string; args: object }[],
  usage: TestUsage | null = {
    promptTokens: 20_000,
    completionTokens: 100,
    reasoningTokens: null,
    cachedTokens: null,
    costUsd: 0.006,
  },
): StreamRoundResult {
  const toolCalls = calls.map((c, i) => ({ id: `call_${i}`, name: c.name, arguments: JSON.stringify(c.args) }));
  return {
    text: '',
    toolCalls,
    finishReason: 'tool_calls',
    assistantMessage: {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    },
    providerUsed: 'test',
    metrics: {
      provider: 'openrouter',
      model: candidate.model,
      chain: 'smart',
      firstUsableSinceAttemptMs: 1,
      providerDurationMs: 1,
      totalDurationMs: 1,
      attemptCount: 1,
      fallbackCount: 0,
      usage: usage === null ? null : { ...usage, totalTokens: null },
    },
  };
}

function textRound(text: string, usage?: TestUsage | null): StreamRoundResult {
  return {
    ...toolRound([], usage),
    text,
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: text },
  };
}

function scripted(rounds: (StreamRoundResult | Error)[]): { round: RoundFn; seen: Parameters<RoundFn>[0][] } {
  const seen: Parameters<RoundFn>[0][] = [];
  const round: RoundFn = async (options) => {
    seen.push({ ...options, messages: [...options.messages] });
    const next = rounds[seen.length - 1];
    if (!next) throw new Error('unexpected extra provider call');
    if (next instanceof Error) throw next;
    return next;
  };
  return { round, seen };
}

const correctToday = [
  { name: 'get_events', args: { start_date: '2026-09-26T22:00:00Z', end_date: '2026-09-27T22:00:00Z' } },
  { name: 'render_day_image', args: { date: '2026-09-27' } },
];

function run(role: ScenarioRole, round: RoundFn, budget = new Budget(1)) {
  return runScenario({ candidate, fixture: today, role, repetition: 0, round, budget, limits });
}

test('executor: a correct tool loop passes, with its rounds, latency and reported cost', async () => {
  const { round, seen } = scripted([toolRound(correctToday), textRound('Вот план на сегодня.')]);
  const row = await run('executor', round);
  expect(row.pass).toBe(true);
  expect(row.rounds).toBe(2);
  expect(row.roundMs).toHaveLength(2);
  expect(row.costUsd).toBeCloseTo(0.012, 9);
  expect(row.costSource).toBe('reported');
  expect(row.inputTokens).toBe(40_000);
  expect(seen[0]?.messages.map((m) => m.role)).toEqual(['system', 'user']);
  expect(seen[1]?.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool']);
});

test('repair: the transcript ends with the rejected draft and the exact production nudge', async () => {
  const { round, seen } = scripted([toolRound(correctToday), textRound('Вот план на сегодня.')]);
  const row = await run('repair', round);
  expect(row.pass).toBe(true);
  const first = seen[0]?.messages ?? [];
  expect(first.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect(first[2]).toEqual({ role: 'assistant', content: rejectedDraft(today) });
  expect(first[3]).toEqual({ role: 'user', content: REPAIR_RETRY_NUDGE });
});

test('repair: repeating the unsupported claim without the tools is a failure', async () => {
  const { round } = scripted([textRound('Готово, всё выполнено.')]);
  const row = await run('repair', round);
  expect(row.pass).toBe(false);
  expect(row.reasons).toContain('missing_or_wrong:get_events');
});

test('an HTTP failure is recorded once and the call is never replayed', async () => {
  const failure = new OpenAI.APIError(429, { message: 'rate limited' }, 'rate limited', new Headers());
  const { round, seen } = scripted([failure]);
  const row = await run('executor', round);
  expect(seen).toHaveLength(1);
  expect(row.error).toBe('HTTP_429');
  expect(row.status).toBe(429);
  expect(row.pass).toBe(false);
  expect(row.usageMissing).toBe(true);
  expect(row.unknownCostReservationUsd).toBeGreaterThan(0);
});

test('the error detail never keeps more than a bounded prefix', async () => {
  const body = 'x'.repeat(2000);
  const { round } = scripted([new OpenAI.APIError(400, { message: body }, body, new Headers())]);
  const row = await run('executor', round);
  expect((row.errorDetail ?? '').length).toBeLessThanOrEqual(300);
});

test('an empty provider answer is a recorded quality failure with its classification', async () => {
  const { round } = scripted([
    new EmptyProviderResponseError('test', {
      classification: 'reasoning_only',
      choiceCount: 1,
      toolFragmentCount: 0,
      finishReason: 'length',
      chunkCount: 3,
      maxOutputTokens: 4096,
      messageCount: 2,
      toolCount: 63,
      usage: null,
    }),
  ]);
  const row = await run('executor', round);
  expect(row.error).toBe('EMPTY_reasoning_only');
  expect(row.pass).toBe(false);
});

test('the budget refuses the request before it is made', async () => {
  const { round, seen } = scripted([textRound('never reached')]);
  const row = await run('executor', round, new Budget(0.0001));
  expect(seen).toHaveLength(0);
  expect(row.error).toBe('EXPERIMENT_BUDGET');
  expect(row.pass).toBe(false);
});

test('list-price estimate is used, and labelled, when the provider reports no cost', async () => {
  const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, reasoningTokens: null, cachedTokens: null };
  const { round } = scripted([toolRound(correctToday, usage), textRound('Вот план на сегодня.', usage)]);
  const row = await run('executor', round, new Budget(3));
  expect(row.costSource).toBe('list-estimate');
  expect(row.costUsd).toBeCloseTo(2 * (0.3 + 1.2), 9);
});

test('a round with no usage leaves the cost unknown, never zero', async () => {
  const { round } = scripted([toolRound(correctToday, null), textRound('Вот план на сегодня.')]);
  const row = await run('executor', round);
  expect(row.usageMissing).toBe(true);
  expect(row.inputTokens).toBe(20_000);
  expect(row.unknownCostReservationUsd).toBeGreaterThan(0);
  expect(row.costUsd).toBeCloseTo(0.006, 9);
});

test('a wrong write is critical and stops the loop without a further provider call', async () => {
  const { round, seen } = scripted([
    toolRound([
      {
        name: 'create_event',
        args: { title: 'Лишнее', start_at: '2026-09-28T10:00:00Z', end_at: '2026-09-28T11:00:00Z' },
      },
    ]),
    textRound('should not be asked'),
  ]);
  const row = await run('executor', round);
  expect(seen).toHaveLength(1);
  expect(row.critical).toBe(true);
  expect(row.calls[0]?.error).toBe('UNREQUESTED_MUTATION_BLOCKED_IN_SANDBOX');
});

test('an attempt that outlives its timeout is a TIMEOUT row', async () => {
  const round: RoundFn = (options) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason));
    });
  const row = await runScenario({
    candidate,
    fixture: today,
    role: 'executor',
    repetition: 0,
    round,
    budget: new Budget(1),
    limits: { ...limits, attemptTimeoutMs: 20 },
  });
  expect(row.error).toBe('TIMEOUT');
  expect(row.pass).toBe(false);
});

test('a truncated tool batch is an error, not a half-executed pass', async () => {
  const truncated = { ...toolRound(correctToday), finishReason: 'length' };
  const { round } = scripted([truncated]);
  const row = await run('executor', round);
  expect(row.error).toBe('TRUNCATED_TOOL_BATCH');
  expect(row.calls).toHaveLength(0);
});

test('lazy mode hides the schemas until discovery, as production does', async () => {
  const { round, seen } = scripted([textRound('Нет.')]);
  await runScenario({
    candidate,
    fixture: today,
    role: 'executor',
    repetition: 0,
    round,
    budget: new Budget(1),
    limits,
    mode: 'lazy',
  });
  const names = (seen[0]?.tools ?? []).flatMap((t) => (t.type === 'function' ? [t.function.name] : []));
  expect(names).not.toContain('create_event');
  expect(names).toContain('calculate');
});
