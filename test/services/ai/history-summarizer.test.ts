import { describe, expect, mock, test } from 'bun:test';
import { HistorySummarizer, PER_MSG_CHARS_LIMIT } from '../../../src/services/ai/history-summarizer.ts';
import type { StreamRoundResult } from '../../../src/services/ai/streaming.ts';

const shortContent = 'short message';
const longContent = 'x'.repeat(PER_MSG_CHARS_LIMIT + 1);

function makeStreamResult(text: string): StreamRoundResult {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: text },
    providerUsed: 'mock',
  };
}

describe('HistorySummarizer.condenseMessage', () => {
  test('returns short content unchanged without calling AI', async () => {
    const mockStream = mock(async () => makeStreamResult('should not be called'));
    const s = new HistorySummarizer(null, mockStream);
    const result = await s.condenseMessage(1, 'tool', shortContent);
    expect(result).toBe(shortContent);
    expect(mockStream).not.toHaveBeenCalled();
  });

  test('summarizes long content via fast AI chain', async () => {
    const mockStream = mock(async () => makeStreamResult('summary text'));
    const s = new HistorySummarizer(null, mockStream);
    const result = await s.condenseMessage(2, 'tool', longContent);
    expect(result).toBe('summary text');
    expect(mockStream).toHaveBeenCalledTimes(1);
    const callArgs = mockStream.mock.calls[0] as unknown as [{ fast?: boolean }, unknown];
    expect(callArgs[0].fast).toBe(true);
  });

  test('truncates with ellipsis when AI call fails', async () => {
    const mockStream = mock(async () => {
      throw new Error('AI unavailable');
    });
    const s = new HistorySummarizer(null, mockStream);
    const result = await s.condenseMessage(3, 'tool', longContent);
    expect(result).toContain('[…]');
    expect(result.length).toBeLessThanOrEqual(PER_MSG_CHARS_LIMIT + 5);
  });

  test('caches summarized result in Redis by row ID', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, _exMode?: string, _ttl?: string) => {
        store.set(k, v);
      },
    };
    const mockStream = mock(async () => makeStreamResult('cached summary'));
    const s = new HistorySummarizer(redis, mockStream);

    const first = await s.condenseMessage(4, 'tool', longContent);
    const second = await s.condenseMessage(4, 'tool', longContent);

    expect(first).toBe('cached summary');
    expect(second).toBe('cached summary');
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});
