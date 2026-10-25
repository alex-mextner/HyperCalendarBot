import { expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { candidateFor, QUALIFICATION_TARGETS } from '../../../scripts/model-quality/models.ts';
import { slotFor } from '../../../scripts/model-quality/slot.ts';
import { excludedModelReason, MODEL_PRESETS, presetById } from '../../../src/services/ai/model-presets.ts';
import type { ProviderId } from '../../../src/services/ai/provider-ids.ts';
import { CLAUDE_MAX_OUTPUT_TOKENS } from '../../../src/services/ai/streaming.ts';

test('the measured set is the three owner-named presets on the routes the registry gives them', () => {
  expect(QUALIFICATION_TARGETS.map((c) => `${c.preset.id}@${c.provider}`)).toEqual([
    'deepseek41-flash@openrouter',
    'glm53-flash-low@openrouter',
    'haiku@claude',
  ]);
  for (const target of QUALIFICATION_TARGETS) expect(target.preset.models[target.provider]).toBe(target.model);
});

test('nothing excluded by owner decision can be measured', () => {
  for (const target of QUALIFICATION_TARGETS) expect(excludedModelReason(target.model)).toBeNull();
});

test('prices are dated list prices with a source; registry price wins, Claude falls back to the harness table', () => {
  const deepseek = candidateFor('deepseek41-flash', 'openrouter');
  expect(presetById('deepseek41-flash')?.prices.openrouter).toEqual(deepseek.price);
  const haiku = candidateFor('haiku', 'claude');
  expect(haiku.price.inputUsdPerMTok).toBe(0.1);
  expect(haiku.price.outputUsdPerMTok).toBe(0.5);
  expect(haiku.price.source).toContain('platform.claude.com');
  expect(haiku.price.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('an unknown preset or a route the preset lacks is refused, never guessed', () => {
  expect(() => candidateFor('nope', 'openrouter')).toThrow('Unknown preset');
  expect(() => candidateFor('haiku', 'openrouter')).toThrow('has no model on openrouter');
});

test('measuring never edits the registry: no preset is qualified', () => {
  for (const preset of MODEL_PRESETS) expect(preset.qualifications).toEqual({});
});

function fakeClient(capture: (params: OpenAI.ChatCompletionCreateParamsStreaming) => void): OpenAI {
  const create = async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
    capture(params);
    async function* chunks(): AsyncGenerator<OpenAI.ChatCompletionChunk> {
      yield {
        id: 'x',
        model: params.model,
        created: 1,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
      };
      yield {
        id: 'x',
        model: params.model,
        created: 1,
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      };
    }
    return chunks();
  };
  // Only the one method the production slot calls.
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

async function requestFor(
  id: string,
  provider: ProviderId,
): Promise<{ params: OpenAI.ChatCompletionCreateParamsStreaming; text: string }> {
  let captured: OpenAI.ChatCompletionCreateParamsStreaming | null = null;
  const candidate = candidateFor(id, provider);
  const slot = slotFor(candidate, () =>
    fakeClient((params) => {
      captured = params;
    }),
  );
  const result = await slot.stream(
    candidate.model,
    { messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096, temperature: 0.3 },
    {},
    () => {},
  );
  if (!captured) throw new Error('no request captured');
  return { params: captured, text: result.text };
}

test('GLM Flash runs with its measured settings: low effort, temperature 1, raised output ceiling', async () => {
  const { params, text } = await requestFor('glm53-flash-low', 'openrouter');
  expect(text).toBe('ok');
  expect(params.model).toBe('z-ai/glm-5.3-flash');
  expect(params.temperature).toBe(1);
  expect(params.max_tokens).toBe(8192);
  expect(Reflect.get(params, 'reasoning')).toEqual({ effort: 'low' });
});

test('DeepSeek runs on the production sampling default and no effort field', async () => {
  const { params } = await requestFor('deepseek41-flash', 'openrouter');
  expect(params.model).toBe('deepseek/deepseek-v4.1-flash');
  expect(params.temperature).toBe(0.3);
  expect(params.max_tokens).toBe(4096);
  expect(Reflect.get(params, 'reasoning')).toBeUndefined();
});

test('Claude gets the production output ceiling and no temperature (it answers 400 to one)', async () => {
  const { params } = await requestFor('haiku', 'claude');
  expect(params.model).toBe('claude-haiku-5-5');
  expect(params.max_tokens).toBe(CLAUDE_MAX_OUTPUT_TOKENS);
  expect(params.temperature).toBeUndefined();
});
