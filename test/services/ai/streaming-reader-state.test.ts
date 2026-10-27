// test/services/ai/streaming-reader-state.test.ts
// Chunk-by-chunk accumulation of consumeStream: what each kind of chunk adds to the result, in what order, and
// what stops the read. Complements streaming-reader.test.ts with chunks that mix several facts at once.

import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import type { CompletionUsage } from 'openai/resources/completions';
import { consumeStream } from '../../../src/services/ai/streaming/stream-reader.ts';

type Chunk = OpenAI.ChatCompletionChunk;
type Delta = Chunk['choices'][number]['delta'];

const USAGE: CompletionUsage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

function chunk(
  delta: Delta,
  finishReason: Chunk['choices'][number]['finish_reason'] = null,
  usage?: CompletionUsage,
): Chunk {
  return {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    ...(usage ? { usage } : {}),
  };
}

function terminalOnly(usage?: CompletionUsage): Chunk {
  return { id: 't', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], ...(usage ? { usage } : {}) };
}

async function* fromChunks(chunks: Chunk[]): AsyncGenerator<Chunk> {
  for (const next of chunks) yield next;
}

function read(chunks: Chunk[], limit?: number) {
  return consumeStream(fromChunks(chunks), {}, performance.now(), undefined, limit);
}

describe('consumeStream accumulation', () => {
  test('usage on a chunk that also carries text is kept and the text still counts', async () => {
    const result = await read([chunk({ content: 'ab' }, null, USAGE), chunk({ content: 'cd' }, 'stop')]);
    expect(result.text).toBe('abcd');
    expect(result.usage).toEqual(USAGE);
    expect(result.finishReason).toBe('stop');
  });

  test('a choices=[] chunk is counted as a chunk with zero choices and its usage survives', async () => {
    const result = await read([chunk({ content: 'x' }, 'stop'), terminalOnly(USAGE)]);
    expect(result).toMatchObject({ chunkCount: 2, choiceCount: 1, usage: USAGE, finishReason: 'stop' });
  });

  test('the last usage wins and an absent one never resets it to null', async () => {
    const later: CompletionUsage = { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 };
    const result = await read([terminalOnly(USAGE), terminalOnly(later), terminalOnly()]);
    expect(result.usage).toEqual(later);
  });

  test('a finish reason on a chunk with an empty delta is kept and marked as seen', async () => {
    const result = await read([chunk({ content: 'x' }), chunk({}, 'tool_calls')]);
    expect(result).toMatchObject({ finishReason: 'tool_calls', finishReasonSeen: true });
  });

  test('first-usable time is set by text or a named tool fragment, not by an empty fragment', async () => {
    const empty = await read([chunk({ tool_calls: [{ index: 0 }] })]);
    expect(empty.firstUsableMs).toBeNull();
    expect(empty.toolFragmentCount).toBe(1);
    const named = await read([chunk({ tool_calls: [{ index: 0, function: { name: 'calculate' } }] })]);
    expect(named.firstUsableMs).not.toBeNull();
    const texted = await read([chunk({ content: 'hi' })]);
    expect(texted.firstUsableMs).not.toBeNull();
  });

  test('a refusal delta marks the stream even without content', async () => {
    const result = await read([chunk({ refusal: 'no' }, 'stop')]);
    expect(result.refusalSeen).toBe(true);
    expect(result.text).toBe('');
  });

  test('text and tool callbacks fire in arrival order', async () => {
    const events: string[] = [];
    await consumeStream(
      fromChunks([
        chunk({ content: 'a' }),
        chunk({ tool_calls: [{ index: 0, id: 't1', function: { name: 'calculate', arguments: '{}' } }] }),
        chunk({ content: 'b' }, 'stop'),
      ]),
      { onTextDelta: (text) => events.push(`text:${text}`), onToolCallStart: (name) => events.push(`tool:${name}`) },
      performance.now(),
    );
    expect(events).toEqual(['text:a', 'tool:calculate', 'text:b']);
  });
});

describe('consumeStream visible-token limit', () => {
  test('tool-call names and argument fragments count toward the limit, not only text', async () => {
    const big = 'x'.repeat(4000);
    const result = await read(
      [
        chunk({ tool_calls: [{ index: 0, id: 't1', function: { name: 'write', arguments: big } }] }),
        chunk({ content: 'never read' }, 'stop'),
      ],
      50,
    );
    expect(result).toMatchObject({ finishReason: 'length', finishReasonSeen: true, text: '', chunkCount: 1 });
    expect(result.toolCalls).toHaveLength(1);
  });

  test('the limit overrides a finish reason already reported and stops the producer', async () => {
    let cleanedUp = false;
    async function* producer(): AsyncGenerator<Chunk> {
      try {
        yield chunk({ content: 'y'.repeat(4000) }, 'stop');
        yield chunk({ content: 'never read' });
      } finally {
        cleanedUp = true;
      }
    }
    const result = await consumeStream(producer(), {}, performance.now(), undefined, 50);
    expect(result.finishReason).toBe('length');
    expect(result.text).toBe('y'.repeat(4000));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cleanedUp).toBe(true);
  });

  test('output under the limit reads to the end with the provider finish reason', async () => {
    const result = await read([chunk({ content: 'short' }), chunk({}, 'stop')], 1000);
    expect(result).toMatchObject({ finishReason: 'stop', text: 'short', chunkCount: 2 });
  });

  test('a limit of zero stops at the first visible output', async () => {
    const result = await read([chunk({ content: 'x' }), chunk({ content: 'y' })], 0);
    expect(result).toMatchObject({ finishReason: 'length', text: 'x', chunkCount: 1 });
  });
});
