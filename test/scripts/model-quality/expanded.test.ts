import { expect, test } from 'bun:test';
import { candidates } from '../../../scripts/model-quality/models.ts';
import { createRequestCatalog, preserveAssistant } from '../../../scripts/model-quality/request-profile.ts';
import { tools } from '../../../scripts/model-quality/sandbox.ts';

test('all explicitly requested larger candidates have real unique profiles', () => {
  for (const id of [
    'glm53-flash-low',
    'deepseek41-flash',
    'deepseek4-pro',
    'qwen38-large',
    'minimax3',
    'kimi3',
    'gemini38-low',
    'gemini31-pro-low',
  ])
    expect(candidates.some((c) => c.id === id)).toBe(true);
  expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
});
test('lazy catalog keeps all names and starts with real calculator', () => {
  const catalog = createRequestCatalog('lazy', tools);
  expect(catalog.prompt).toContain('send_invitation');
  expect(catalog.prompt).toContain('get_events');
  expect(catalog.schemas().some((t) => t.type === 'function' && t.function.name === 'calculate')).toBe(true);
  expect(catalog.schemas().some((t) => t.type === 'function' && t.function.name === 'create_event')).toBe(false);
});
test('full mode has no oracle-specific hidden tool filtering', () =>
  expect(createRequestCatalog('full', tools).schemas()).toEqual(tools));
test('provider assistant metadata survives the tool round trip', () => {
  const message = {
    role: 'assistant' as const,
    content: null,
    refusal: null,
    reasoning_content: 'synthetic opaque continuation',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'calculate', arguments: '{"expression":"2+2"}' },
        extra_content: { google: { thought_signature: 'synthetic-signature' } },
      },
    ],
  };
  const result = preserveAssistant(message, 'together');
  expect(result.content).toBe('');
  expect(Reflect.get(result, 'reasoning_content')).toBe(message.reasoning_content);
  expect(result.tool_calls).toEqual(message.tool_calls);
});

import { modelAdvertised } from '../../../scripts/model-quality/request-profile.ts';

test('Gemini model resource prefix is not an unavailable-model signal', () =>
  expect(modelAdvertised('gemini', 'gemini-3.8-flash', ['models/gemini-3.8-flash'])).toBe(true));
test('other providers never erase meaningful model namespaces', () =>
  expect(modelAdvertised('together', 'GLM-5.3', ['zai-org/GLM-5.3'])).toBe(false));

import { isTransportConfigurationError } from '../../../scripts/model-quality/request-profile.ts';

test('fixed streaming-only incompatibility stops a benchmark profile rather than repeating it', () =>
  expect(isTransportConfigurationError('HTTP_400', '400 This model only supports streaming. Set "stream": true.')).toBe(
    true,
  ));
test('invalid model-generated tool JSON stays a recorded quality error', () =>
  expect(isTransportConfigurationError('HTTP_400', '400 Failed to parse tool call arguments as JSON')).toBe(false));
