import { describe, expect, test } from 'bun:test';
import { estimateMessageListTokens, estimateTokens } from '../../src/utils/token-estimate.ts';

describe('estimateTokens', () => {
  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('estimates English text — ceil(11/3.5) = 4', () => {
    expect(estimateTokens('Hello world')).toBe(4);
  });

  test('exact multiple — 350 chars = 100 tokens', () => {
    expect(estimateTokens('a'.repeat(350))).toBe(100);
  });

  test('rounds up — 10 chars = ceil(2.857) = 3', () => {
    expect(estimateTokens('1234567890')).toBe(3);
  });
});

describe('estimateMessageListTokens', () => {
  test('sums content across messages', () => {
    const msgs = [
      { role: 'user' as const, content: 'a'.repeat(350) }, // 100 tokens
      { role: 'assistant' as const, content: 'b'.repeat(70) }, // ceil(20) = 20 tokens
    ];
    expect(estimateMessageListTokens(msgs)).toBe(120);
  });

  test('handles null content (tool_calls message)', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'x', type: 'function' as const, function: { name: 'f', arguments: '{}' } }],
      },
    ];
    expect(estimateMessageListTokens(msgs)).toBe(0);
  });

  test('returns 0 for empty list', () => {
    expect(estimateMessageListTokens([])).toBe(0);
  });
});
