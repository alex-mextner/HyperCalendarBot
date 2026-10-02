import { describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { createLightRouterRequest } from '../../../src/services/ai/light-router-client.ts';
import type { RoutingPacketRequest } from '../../../src/services/ai/turn-routing.ts';

const packet = {
  messages: [{ role: 'user', content: 'synthetic' }],
  response_format: { type: 'json_object' },
  max_completion_tokens: 128,
} as unknown as RoutingPacketRequest;

function response(text: string): OpenAI.ChatCompletion {
  return {
    id: 'synthetic',
    object: 'chat.completion',
    created: 0,
    model: 'synthetic',
    choices: [
      { index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: text, refusal: null } },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
}

describe('Light router Groq model chain', () => {
  test('uses Qwen first with reasoning disabled', async () => {
    const create = mock(async (_params: OpenAI.ChatCompletionCreateParamsNonStreaming) => response('{"tier":"light"}'));
    const request = createLightRouterRequest({ chat: { completions: { create } } } as unknown as Parameters<
      typeof createLightRouterRequest
    >[0]);
    expect(await request(packet, new AbortController().signal)).toBe('{"tier":"light"}');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'qwen/qwen3.8-27b',
      reasoning_effort: 'none',
      temperature: 0,
    });
  });

  test('falls back to OSS20 when Qwen fails', async () => {
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsNonStreaming) => {
      if (params.model.includes('qwen')) throw new Error('synthetic qwen failure');
      return response('{"tier":"medium"}');
    });
    const request = createLightRouterRequest({ chat: { completions: { create } } } as unknown as Parameters<
      typeof createLightRouterRequest
    >[0]);
    expect(await request(packet, new AbortController().signal)).toBe('{"tier":"medium"}');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toMatchObject({ model: 'openai/gpt-oss-20b', reasoning_effort: 'low' });
  });
});
