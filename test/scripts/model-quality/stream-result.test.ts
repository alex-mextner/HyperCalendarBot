import { expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { collectCompletion } from '../../../scripts/model-quality/stream-result.ts';

function chunk(
  choices: OpenAI.ChatCompletionChunk.Choice[],
  usage?: OpenAI.CompletionUsage,
): OpenAI.ChatCompletionChunk {
  return {
    id: 'demo',
    model: 'streaming-model',
    created: 1,
    object: 'chat.completion.chunk',
    choices,
    ...(usage ? { usage } : {}),
  };
}
async function* source(rows: OpenAI.ChatCompletionChunk[]) {
  yield* rows;
}
test('terminal usage-only frame survives and preserves text', async () => {
  const result = await collectCompletion(
    source([
      chunk([{ index: 0, delta: { content: 'Привет' }, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]),
      chunk([], { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 }),
    ]),
  );
  expect(result.choices[0]?.message.content).toBe('Привет');
  expect(result.usage?.total_tokens).toBe(102);
});
test('tool fragments are reassembled by stream index', async () => {
  const result = await collectCompletion(
    source([
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'calculate', arguments: '{"expression":"' },
              },
            ],
          },
          finish_reason: null,
        },
      ]),
      chunk([
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '19*3"}' } }] },
          finish_reason: 'tool_calls',
        },
      ]),
    ]),
  );
  expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  const call = result.choices[0]?.message.tool_calls?.[0];
  expect(call?.type === 'function' && call.function.arguments).toBe('{"expression":"19*3"}');
});
test('missing terminal metadata is not fabricated as success', async () => {
  const result = await collectCompletion(source([]));
  expect(result.choices).toHaveLength(0);
});
test('unterminated nonempty stream cannot masquerade as a complete answer', async () => {
  await expect(
    collectCompletion(source([chunk([{ index: 0, delta: { content: 'unfinished' }, finish_reason: null }])])),
  ).rejects.toThrow('UNTERMINATED_STREAM');
});
