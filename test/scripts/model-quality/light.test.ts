import { expect, test } from 'bun:test';
import OpenAI from 'openai';
import { Budget } from '../../../scripts/model-quality/budget.ts';
import {
  type LightCall,
  type LightResponse,
  lightRequest,
  runLightCase,
} from '../../../scripts/model-quality/light.ts';
import { gradeLight, lightCases, lightSchemas } from '../../../scripts/model-quality/light-cases.ts';
import { candidateFor } from '../../../scripts/model-quality/models.ts';
import { CLAUDE_MAX_OUTPUT_TOKENS } from '../../../src/services/ai/streaming.ts';

const candidate = candidateFor('glm53-flash-low', 'openrouter');
const catalogCase = lightCases.find((c) => c.id === 'catalog-3')!;

test('all frozen Light labels satisfy their requested schemas', () => {
  expect(lightCases.length).toBe(36);
  for (const c of lightCases) expect(gradeLight(c, c.expected)).toBe(true);
});
test('delivery cannot be inferred from success flag', () => {
  const c = lightCases.find((x) => x.id === 'outcome-6')!;
  expect(gradeLight(c, { operation: 'applied', delivery: 'delivered', may_claim_delivered: true })).toBe(false);
});
test('noncatalog enum cannot be used as execution permission', () =>
  expect(lightSchemas.catalog.safeParse({ groups: ['delete_everything'] }).success).toBe(false));

const usage = {
  promptTokens: 2_000,
  completionTokens: 30,
  reasoningTokens: null,
  cachedTokens: null,
  costUsd: 0.00002,
};
function answer(content: string, finishReason: string | null = 'stop', u: LightResponse['usage'] = usage): LightCall {
  return async () => ({ content, finishReason, usage: u });
}
function run(call: LightCall, budget = new Budget(1)) {
  return runLightCase({ candidate, fixture: catalogCase, repetition: 0, call, budget, attemptTimeoutMs: 1_000 });
}

test('planner: the exact labelled answer passes and carries its reported cost', async () => {
  const row = await run(answer(JSON.stringify(catalogCase.expected)));
  expect(row.pass).toBe(true);
  expect(row.role).toBe('planner');
  expect(row.family).toBe('catalog');
  expect(row.costUsd).toBeCloseTo(0.00002, 9);
  expect(row.costSource).toBe('reported');
});

test('planner: fenced or prose-wrapped JSON is not the requested structured answer', async () => {
  const row = await run(answer(`\`\`\`json\n${JSON.stringify(catalogCase.expected)}\n\`\`\``));
  expect(row.pass).toBe(false);
});

test('planner: a truncated answer never passes even when its prefix parses', async () => {
  const row = await run(answer(JSON.stringify(catalogCase.expected), 'length'));
  expect(row.pass).toBe(false);
});

test('planner: an HTTP failure is recorded once, with its reservation kept', async () => {
  let calls = 0;
  const row = await run(async () => {
    calls++;
    throw new OpenAI.APIError(402, { message: 'credits' }, 'credits', new Headers());
  });
  expect(calls).toBe(1);
  expect(row.error).toBe('HTTP_402');
  expect(row.usageMissing).toBe(true);
  expect(row.unknownCostReservationUsd).toBeGreaterThan(0);
});

test('planner: the budget stops the request before it is made', async () => {
  let calls = 0;
  const row = await run(async () => {
    calls++;
    return { content: '{}', finishReason: 'stop', usage };
  }, new Budget(0.000001));
  expect(calls).toBe(0);
  expect(row.error).toBe('EXPERIMENT_BUDGET');
});

test('planner request: structured output, the preset effort on OpenRouter, the preset sampling', () => {
  const request = lightRequest(candidate, catalogCase);
  expect(request.model).toBe('z-ai/glm-5.3-flash');
  expect(request.temperature).toBe(1);
  expect(request.max_tokens).toBe(8192);
  expect(Reflect.get(request, 'reasoning')).toEqual({ effort: 'low' });
  expect(request.response_format?.type).toBe('json_schema');
  expect(request.stream).toBeUndefined();
});

test('planner request: Claude gets its ceiling and no temperature', () => {
  const request = lightRequest(candidateFor('haiku', 'claude'), catalogCase);
  expect(request.max_tokens).toBe(CLAUDE_MAX_OUTPUT_TOKENS);
  expect(request.temperature).toBeUndefined();
});

test('planner request: Claude gets the group schema without maxItems, other routes keep it', () => {
  const claude = lightRequest(candidateFor('haiku', 'claude'), catalogCase);
  const other = lightRequest(candidate, catalogCase);
  expect(JSON.stringify(claude.response_format)).not.toContain('maxItems');
  expect(JSON.stringify(other.response_format)).toContain('maxItems');
});

test('planner grading still enforces the group bound the Claude schema leaves out', () => {
  expect(
    lightSchemas.catalog.safeParse({ groups: ['calendar.read', 'contacts', 'sharing', 'history', 'settings'] }).success,
  ).toBe(false);
});
