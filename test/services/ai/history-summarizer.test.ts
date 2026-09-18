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
    const result = await s.condenseMessage(1, 'call_abc', shortContent);
    expect(result).toBe(shortContent);
    expect(mockStream).not.toHaveBeenCalled();
  });

  test('summarizes long content via fast AI chain', async () => {
    const mockStream = mock(async () => makeStreamResult('summary text'));
    const s = new HistorySummarizer(null, mockStream);
    const result = await s.condenseMessage(2, 'call_abc', longContent);
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
    const result = await s.condenseMessage(3, 'call_abc', longContent);
    expect(result).toContain('[…]');
    expect(result.length).toBeLessThanOrEqual(PER_MSG_CHARS_LIMIT + 5);
  });

  test('caches summarized result in Redis with 24h TTL by row+subKey', async () => {
    const store = new Map<string, string>();
    let capturedExMode: string | undefined;
    let capturedTtl: string | undefined;
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, exMode?: string, ttl?: string) => {
        capturedExMode = exMode;
        capturedTtl = ttl;
        store.set(k, v);
      },
    };
    const mockStream = mock(async () => makeStreamResult('cached summary'));
    const s = new HistorySummarizer(redis, mockStream);

    const first = await s.condenseMessage(4, 'call_1', longContent);
    const second = await s.condenseMessage(4, 'call_1', longContent);

    expect(first).toBe('cached summary');
    expect(second).toBe('cached summary');
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(capturedExMode).toBe('EX');
    expect(capturedTtl).toBe('86400');
  });

  test('uses separate cache keys for different subKeys on the same row', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
      },
    };
    let callCount = 0;
    const mockStream = mock(async () => makeStreamResult(`summary-${++callCount}`));
    const s = new HistorySummarizer(redis, mockStream);

    const r1 = await s.condenseMessage(5, 'call_a', longContent);
    const r2 = await s.condenseMessage(5, 'call_b', longContent);

    expect(r1).toBe('summary-1');
    expect(r2).toBe('summary-2');
    expect(mockStream).toHaveBeenCalledTimes(2);
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

  test('collapses old messages into summary + keeps recent from nearest user boundary', async () => {
    const mockStream = mock(async () => makeStreamResult('• event A\n• event B'));
    const s = new HistorySummarizer(null, mockStream);

    // 80 messages × 100 tokens = 8000 tokens > HISTORY_TOKEN_BUDGET
    // Alternating user/assistant: default cut at index 75 ('assistant') → walks back to 74 ('user')
    // so recent = messages[74..79] = 6 messages
    const msgs: MessageParam[] = Array.from({ length: 80 }, (_, i) => bigMsg(i % 2 === 0 ? 'user' : 'assistant'));

    const result = await s.condenseHistory(msgs);

    expect(result.length).toBe(7); // 1 summary + 6 recent (walk landed on user at idx 74)
    const first = result[0];
    expect(first!.role).toBe('user');
    expect(typeof first!.content === 'string' && first!.content).toContain('[Earlier conversation summary]');
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  test('falls back to recent slice when AI fails', async () => {
    const mockStream = mock(async () => {
      throw new Error('AI down');
    });
    const s = new HistorySummarizer(null, mockStream);

    // Same 80-message layout: boundary walk gives recent = messages[74..79] = 6 items
    const msgs: MessageParam[] = Array.from({ length: 80 }, (_, i) => bigMsg(i % 2 === 0 ? 'user' : 'assistant'));

    const result = await s.condenseHistory(msgs);
    expect(result.length).toBe(6);
    expect(result).toEqual(msgs.slice(-6));
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
    // boundary walk lands on the nearest user message, so recent may be 6 instead of exactly 5
    expect(result[0]!.role).toBe('user');
    expect(typeof result[0]!.content === 'string' && result[0]!.content).toContain('[Earlier conversation summary]');
    expect(mockStream).toHaveBeenCalledTimes(1);
    // verify [structured message] was included in the text sent to AI (toolCallMsg is in older)
    const callArgs = mockStream.mock.calls[0] as unknown as [{ messages: Array<{ content: string }> }, unknown];
    expect(callArgs[0].messages[0]!.content).toContain('[structured message]');
  });

  test('boundary walk prevents orphaned tool message at start of recent', async () => {
    // Without the boundary walk, cutting at n-5 when messages[n-5] is 'tool'
    // would produce [summaryMsg, tool, ...] — OpenAI rejects this with 400.
    // The walk steps back until recent starts on a user message.
    const mockStream = mock(async () => makeStreamResult('• summary'));
    const s = new HistorySummarizer(null, mockStream);

    const toolCallMsg: MessageParam = {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function' as const, function: { name: 'add_event', arguments: '{}' } }],
    } as MessageParam;
    const toolResultMsg: MessageParam = {
      role: 'tool' as const,
      tool_call_id: 'tc1',
      content: 'Event created',
    } as MessageParam;

    // Layout (n=72, cutIdx=67 by default):
    // [0..64] 65×bigMsg alternating (6500 tokens — over budget)
    // [65]    user
    // [66]    assistant+tool_calls(tc1)
    // [67]    tool(tc1)  ← default cutIdx = 72-5 = 67 → walk back to [65] user
    // [68]    user
    // [69]    assistant
    // [70]    user
    // [71]    assistant
    const msgs: MessageParam[] = [
      ...Array.from({ length: 65 }, (_, i) => bigMsg(i % 2 === 0 ? 'user' : 'assistant')),
      { role: 'user', content: 'add an event' },
      toolCallMsg,
      toolResultMsg,
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next question' },
      { role: 'assistant', content: 'answer' },
    ];

    const result = await s.condenseHistory(msgs);

    // summary message is first
    expect(result[0]!.role).toBe('user');
    expect(typeof result[0]!.content === 'string' && result[0]!.content).toContain('[Earlier conversation summary]');
    // recent must NOT start with a tool or assistant message (was the bug)
    expect(result[1]!.role).toBe('user');
    // the tool result is paired correctly — immediately follows its assistant+tool_calls
    const toolPos = result.findIndex((m) => m.role === 'tool');
    expect(toolPos).toBeGreaterThan(1);
    expect(result[toolPos - 1]!.role).toBe('assistant');
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

describe('HistorySummarizer measured override', () => {
  test('uses request-scoped stream override for long-message summarization', async () => {
    const base = mock(async () => makeStreamResult('base'));
    const override = mock(async () => makeStreamResult('measured'));
    const s = new HistorySummarizer(null, base);
    expect(await s.condenseMessage(999, 'call', longContent, override)).toBe('measured');
    expect(override).toHaveBeenCalledTimes(1);
    expect(base).not.toHaveBeenCalled();
  });
});
