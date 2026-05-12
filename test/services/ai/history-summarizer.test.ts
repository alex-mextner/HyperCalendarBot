import { describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import { HistorySummarizer, PER_MSG_CHARS_LIMIT } from '../../../src/services/ai/history-summarizer.ts';
import type { StreamRoundResult } from '../../../src/services/ai/streaming.ts';

type MessageParam = OpenAI.ChatCompletionMessageParam;

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

// 350 chars per message = 100 tokens each
const bigMsg = (role: 'user' | 'assistant'): MessageParam => ({
  role,
  content: 'x'.repeat(350),
});

describe('HistorySummarizer.condenseHistory', () => {
  test('returns same reference when under budget', async () => {
    const mockStream = mock(async () => makeStreamResult('unused'));
    const s = new HistorySummarizer(null, mockStream);
    const msgs: MessageParam[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const result = await s.condenseHistory(msgs);
    expect(result).toBe(msgs);
    expect(mockStream).not.toHaveBeenCalled();
  });

  test('collapses old messages into summary + keeps 5 recent', async () => {
    const mockStream = mock(async () => makeStreamResult('• event A\n• event B'));
    const s = new HistorySummarizer(null, mockStream);

    // 80 messages × 100 tokens = 8000 tokens > HISTORY_TOKEN_BUDGET
    const msgs: MessageParam[] = Array.from({ length: 80 }, (_, i) => bigMsg(i % 2 === 0 ? 'user' : 'assistant'));

    const result = await s.condenseHistory(msgs);

    expect(result.length).toBe(6); // 1 summary + 5 recent
    const first = result[0];
    expect(first!.role).toBe('user');
    expect(typeof first!.content === 'string' && first!.content).toContain('[Earlier conversation summary]');
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  test('falls back to 5 most recent when AI fails', async () => {
    const mockStream = mock(async () => {
      throw new Error('AI down');
    });
    const s = new HistorySummarizer(null, mockStream);

    const msgs: MessageParam[] = Array.from({ length: 80 }, (_, i) => bigMsg(i % 2 === 0 ? 'user' : 'assistant'));

    const result = await s.condenseHistory(msgs);
    expect(result.length).toBe(5);
    expect(result).toEqual(msgs.slice(-5));
  });

  test('formats non-string content as [structured message] in older segment', async () => {
    const mockStream = mock(async () => makeStreamResult('• event A'));
    const s = new HistorySummarizer(null, mockStream);

    // First message is non-string (tool_calls) — will be in "older" segment
    const toolCallMsg: MessageParam = {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: 't1', type: 'function' as const, function: { name: 'get_events', arguments: '{}' } }],
    } as MessageParam;

    // 81 messages: toolCallMsg + 80 bigMsg — over budget, toolCallMsg ends up in "older"
    const msgs: MessageParam[] = [
      toolCallMsg,
      ...Array.from({ length: 80 }, (_, i) => bigMsg(i % 2 === 0 ? 'user' : 'assistant')),
    ];

    const result = await s.condenseHistory(msgs);
    expect(result.length).toBe(6); // 1 summary + 5 recent
    expect(mockStream).toHaveBeenCalledTimes(1);
    // verify [structured message] was included in the text sent to AI
    const callArgs = mockStream.mock.calls[0] as unknown as [{ messages: Array<{ content: string }> }, unknown];
    expect(callArgs[0].messages[0]!.content).toContain('[structured message]');
  });

  test('does not condense when message count <= RECENT_KEEP', async () => {
    const mockStream = mock(async () => makeStreamResult('unused'));
    const s = new HistorySummarizer(null, mockStream);

    // 5 massive messages — still only 5, can't split
    const msgs: MessageParam[] = Array.from({ length: 5 }, () => ({
      role: 'user' as const,
      content: 'x'.repeat(350 * 100), // huge
    }));

    const result = await s.condenseHistory(msgs);
    expect(result).toBe(msgs); // returned as-is, can't split further
    expect(mockStream).not.toHaveBeenCalled();
  });
});
