import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { readTextStream, readToolStream } from '../../scripts/test-hf-models.ts';

type Delta = OpenAI.ChatCompletionChunk.Choice.Delta;

async function* streamOf(...deltas: Array<Delta | undefined>): AsyncGenerator<OpenAI.ChatCompletionChunk> {
  for (const delta of deltas) {
    yield {
      id: 'chunk',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test',
      choices: delta ? [{ index: 0, delta, finish_reason: null }] : [],
    };
  }
}

describe('test-hf-models stream readers', () => {
  test('importing the script does not start the live model run', () => {
    expect(typeof readTextStream).toBe('function');
  });

  test('readTextStream concatenates content and counts only chunks that carry content', async () => {
    const result = await readTextStream(
      streamOf({ content: 'Hel' }, {}, { content: '' }, undefined, { content: 'lo' }),
    );
    expect(result).toEqual({ text: 'Hello', chunks: 2 });
  });

  test('readToolStream assembles a call whose arguments arrive in fragments', async () => {
    const result = await readToolStream(
      streamOf(
        { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_time', arguments: '{"tz":' } }] },
        { tool_calls: [{ index: 0, function: { arguments: '"Europe/Belgrade"}' } }] },
      ),
    );
    expect(result).toEqual({ text: '', toolCalls: ['get_time({"tz":"Europe/Belgrade"})'] });
  });

  test('readToolStream keeps parallel calls apart by index, in first-seen order, alongside text', async () => {
    const result = await readToolStream(
      streamOf(
        { content: 'Checking. ' },
        { tool_calls: [{ index: 1, function: { name: 'b', arguments: '{' } }] },
        { tool_calls: [{ index: 0, function: { name: 'a', arguments: '{}' } }] },
        { content: 'Done', tool_calls: [{ index: 1, function: { arguments: '}' } }] },
        undefined,
      ),
    );
    expect(result).toEqual({ text: 'Checking. Done', toolCalls: ['b({})', 'a({})'] });
  });

  test('readToolStream reports no calls for a text-only answer', async () => {
    const result = await readToolStream(streamOf({ content: 'It is noon.' }));
    expect(result).toEqual({ text: 'It is noon.', toolCalls: [] });
  });
});
