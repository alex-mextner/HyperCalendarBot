// test/services/ai/streaming-reader.test.ts
// The chunk reader and the pure response shaping behind every streaming round: finish reasons and usage
// survive terminal chunks that carry no delta, unknown usage stays null (never 0), tool fragments without
// an index still assemble, and a cancelled stream stops delivering text.

import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import type { CompletionUsage } from 'openai/resources/completions';
import {
  buildResponseDiagnostics,
  hasInvalidToolCalls,
  normalizeUsage,
} from '../../../src/services/ai/streaming/response-shape.ts';
import { consumeStream } from '../../../src/services/ai/streaming/stream-reader.ts';

type Chunk = OpenAI.ChatCompletionChunk;
type ToolDelta = NonNullable<Chunk['choices'][number]['delta']['tool_calls']>[number];

function chunk(
  delta: Chunk['choices'][number]['delta'],
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

/** A terminal chunk whose choice has a finish_reason but no `delta` key at all, as some providers send it. */
function terminalWithoutDelta(finishReason: NonNullable<Chunk['choices'][number]['finish_reason']>): Chunk {
  const terminal = chunk({}, finishReason);
  Reflect.deleteProperty(terminal.choices[0] ?? {}, 'delta');
  return terminal;
}

function usageOnly(usage: CompletionUsage): Chunk {
  return { id: 'u', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [], usage };
}

async function* fromChunks(chunks: Chunk[]): AsyncGenerator<Chunk> {
  for (const next of chunks) yield next;
}

function toolDelta(fragment: Pick<ToolDelta, 'id' | 'function'> & { index?: number }): ToolDelta {
  return { index: fragment.index as number, ...fragment };
}

describe('consumeStream finish reason and usage', () => {
  test('a finish reason on a terminal chunk without a delta is kept', async () => {
    const consumed = await consumeStream(
      fromChunks([chunk({ content: 'partial' }), terminalWithoutDelta('length')]),
      {},
      performance.now(),
    );
    expect(consumed.finishReason).toBe('length');
    expect(consumed.finishReasonSeen).toBe(true);
    expect(consumed.text).toBe('partial');
  });

  test('no terminal chunk leaves the default finish reason marked as unseen', async () => {
    const consumed = await consumeStream(fromChunks([chunk({ content: 'x' })]), {}, performance.now());
    expect(consumed.finishReason).toBe('stop');
    expect(consumed.finishReasonSeen).toBe(false);
  });

  test('usage arriving in a choices=[] chunk after the finish reason is captured', async () => {
    const usage: CompletionUsage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
    const consumed = await consumeStream(
      fromChunks([chunk({ content: 'hi' }, 'stop'), usageOnly(usage)]),
      {},
      performance.now(),
    );
    expect(consumed.usage).toEqual(usage);
    expect(consumed.choiceCount).toBe(1);
    expect(consumed.chunkCount).toBe(2);
  });

  test('a stream that never reports usage yields null, not zeros', async () => {
    const consumed = await consumeStream(fromChunks([chunk({ content: 'hi' }, 'stop')]), {}, performance.now());
    expect(consumed.usage).toBeNull();
    expect(normalizeUsage(consumed.usage)).toBeNull();
  });
});

describe('normalizeUsage', () => {
  test('fields the provider did not report stay null instead of becoming 0', () => {
    const usage = normalizeUsage({ prompt_tokens: 7 } as CompletionUsage);
    expect(usage).toEqual({
      promptTokens: 7,
      completionTokens: null,
      totalTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
    });
  });

  test('non-finite numbers are unknown, a reported zero stays zero, and cost passes through', () => {
    const usage = normalizeUsage({
      prompt_tokens: Number.NaN,
      completion_tokens: 0,
      total_tokens: Number.POSITIVE_INFINITY,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 },
      cost: 0.0125,
    } as CompletionUsage);
    expect(usage).toEqual({
      promptTokens: null,
      completionTokens: 0,
      totalTokens: null,
      cachedTokens: 4,
      reasoningTokens: 2,
      costUsd: 0.0125,
    });
  });
});

describe('consumeStream tool fragments', () => {
  test('fragments without an index continue the most recently opened call', async () => {
    const started: string[] = [];
    const consumed = await consumeStream(
      fromChunks([
        chunk({ tool_calls: [toolDelta({ id: 'call_1', function: { name: 'lookup', arguments: '{"a"' } })] }),
        chunk({ tool_calls: [toolDelta({ function: { arguments: ':1}' } })] }),
        chunk({}, 'tool_calls'),
      ]),
      { onToolCallStart: (name) => started.push(name) },
      performance.now(),
    );
    expect(consumed.toolCalls).toEqual([{ id: 'call_1', name: 'lookup', arguments: '{"a":1}' }]);
    expect(started).toEqual(['lookup']);
    expect(consumed.toolFragmentCount).toBe(2);
  });

  test('an orphan fragment with nothing open is dropped but still counted', async () => {
    const consumed = await consumeStream(
      fromChunks([chunk({ tool_calls: [toolDelta({ function: { arguments: '{}' } })] })]),
      {},
      performance.now(),
    );
    expect(consumed.toolCalls).toEqual([]);
    expect(consumed.toolFragmentCount).toBe(1);
    expect(hasInvalidToolCalls(consumed.toolFragmentCount, consumed.toolCalls)).toBe(true);
  });
});

describe('consumeStream cancellation and limits', () => {
  test('aborting while the producer is stalled rejects and ignores what it yields afterwards', async () => {
    const gate = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<void>();
    const cleanedUp = Promise.withResolvers<void>();
    async function* producer(): AsyncGenerator<Chunk> {
      yield chunk({ content: 'a' });
      stalled.resolve();
      await gate.promise;
      yield chunk({ content: 'late' });
    }
    const source = producer();
    let lastPull: Promise<IteratorResult<Chunk>> = Promise.resolve({ done: true, value: undefined });
    const stream: AsyncIterable<Chunk> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          lastPull = source.next();
          return lastPull;
        },
        return: async () => {
          cleanedUp.resolve();
          return { done: true, value: undefined };
        },
      }),
    };
    const seen: string[] = [];
    const controller = new AbortController();
    const reading = consumeStream(
      stream,
      { onTextDelta: (text) => seen.push(text) },
      performance.now(),
      controller.signal,
    );
    const outcome = reading.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await stalled.promise;
    controller.abort(new Error('caller stopped'));
    expect(await outcome).toEqual(new Error('caller stopped'));
    gate.resolve();
    await lastPull;
    await cleanedUp.promise;
    expect(seen).toEqual(['a']);
  });

  test('a visible-token limit ends the read as a length stop', async () => {
    const delivered: string[] = [];
    const consumed = await consumeStream(
      fromChunks([chunk({ content: 'word '.repeat(40) }), chunk({ content: 'never read' })]),
      { onTextDelta: (text) => delivered.push(text) },
      performance.now(),
      undefined,
      5,
    );
    expect(consumed.finishReason).toBe('length');
    expect(consumed.finishReasonSeen).toBe(true);
    expect(delivered).toEqual(['word '.repeat(40)]);
  });
});

describe('buildResponseDiagnostics', () => {
  const base = {
    refusalSeen: false,
    finishReason: 'stop',
    finishReasonSeen: true,
    invalidTools: false,
    usage: null,
    chunkCount: 3,
    choiceCount: 3,
    toolFragmentCount: 0,
    maxOutputTokens: 100,
    messageCount: 2,
    toolCount: 0,
  };

  test('safety outranks malformed tools, which outrank a length stop', () => {
    expect(buildResponseDiagnostics({ ...base, refusalSeen: true, invalidTools: true }).classification).toBe('safety');
    expect(buildResponseDiagnostics({ ...base, finishReason: 'content_filter' }).classification).toBe('safety');
    expect(buildResponseDiagnostics({ ...base, invalidTools: true, finishReason: 'length' }).classification).toBe(
      'malformed_tools',
    );
    expect(buildResponseDiagnostics({ ...base, finishReason: 'length' }).classification).toBe('length');
  });

  test('an unseen finish reason is reported as null and an unlisted one as unknown', () => {
    expect(buildResponseDiagnostics({ ...base, finishReasonSeen: false }).finishReason).toBeNull();
    expect(buildResponseDiagnostics({ ...base, finishReason: 'weird_stop' }).finishReason).toBe('unknown');
    expect(buildResponseDiagnostics({ ...base, finishReason: 'tool_calls' }).finishReason).toBe('tool_calls');
  });

  test('without output the cause is read from reasoning spend, then chunk and choice counts', () => {
    const reasoning = {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      cachedTokens: null,
      reasoningTokens: 5,
    };
    expect(buildResponseDiagnostics({ ...base, usage: reasoning }).classification).toBe('reasoning_only');
    expect(buildResponseDiagnostics({ ...base, chunkCount: 0, choiceCount: 0 }).classification).toBe('no_chunks');
    expect(buildResponseDiagnostics({ ...base, choiceCount: 0 }).classification).toBe('no_choices');
    expect(buildResponseDiagnostics(base).classification).toBe('empty');
  });
});

describe('hasInvalidToolCalls', () => {
  const valid = { id: 'call_1', name: 'lookup', arguments: '{"a":1}' };

  test('well-formed calls pass', () => {
    expect(hasInvalidToolCalls(1, [valid])).toBe(false);
    expect(hasInvalidToolCalls(0, [])).toBe(false);
  });

  test('blank id, unusable name, non-object arguments and duplicate ids are rejected', () => {
    expect(hasInvalidToolCalls(1, [{ ...valid, id: '  ' }])).toBe(true);
    expect(hasInvalidToolCalls(1, [{ ...valid, name: 'bad name!' }])).toBe(true);
    expect(hasInvalidToolCalls(1, [{ ...valid, arguments: '[1]' }])).toBe(true);
    expect(hasInvalidToolCalls(1, [{ ...valid, arguments: '{"a":' }])).toBe(true);
    expect(hasInvalidToolCalls(2, [valid, { ...valid, name: 'other' }])).toBe(true);
  });
});
