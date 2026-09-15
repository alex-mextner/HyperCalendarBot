import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { sanitizeMessages } from '../../../src/services/ai/message-history.ts';

type Message = OpenAI.ChatCompletionMessageParam;
const user: Message = { role: 'user', content: 'Synthetic request' };
const assistant = (ids: string[]): Message => ({
  role: 'assistant',
  content: null,
  tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'test_value', arguments: '{}' } })),
});
const result = (id: string): Message => ({ role: 'tool', tool_call_id: id, content: '7' });

describe('provider-safe historical tool blocks', () => {
  test('drops orphan result causing Groq Harmony Tools should have a name', () => {
    expect(sanitizeMessages([user, result('unknown')])).toEqual([user]);
  });
  test('drops extra unmatched results without breaking a complete block', () => {
    expect(sanitizeMessages([user, assistant(['a']), result('a'), result('unknown')])).toEqual([
      user,
      assistant(['a']),
      result('a'),
    ]);
  });
  test('does not let the same result ID appear twice', () => {
    expect(sanitizeMessages([user, assistant(['a']), result('a'), result('a')])).toEqual([
      user,
      assistant(['a']),
      result('a'),
    ]);
  });
  test('preserves a complete parallel block; provider-specific serialization is separate', () => {
    const messages = [user, assistant(['a', 'b']), result('a'), result('b')];
    expect(sanitizeMessages(messages)).toEqual(messages);
  });
  test('incomplete block cannot leak unrelated trailing results', () => {
    expect(sanitizeMessages([user, assistant(['a', 'b']), result('a'), result('unknown')])).toEqual([user]);
  });
  test('keeps existing text fallback for incomplete calls and ordinary user/assistant history', () => {
    expect(sanitizeMessages([user, { ...assistant(['a']), content: 'Partial response' }])).toEqual([
      user,
      { role: 'assistant', content: 'Partial response' },
    ]);
    const messages: Message[] = [
      { role: 'system', content: 'Policy' },
      { role: 'assistant', content: 'Old reply' },
      user,
    ];
    expect(sanitizeMessages(messages)).toEqual([messages[0]!, { role: 'user', content: '...' }, messages[1]!, user]);
  });
  test('preserves historical names even when no active schema exists, without adding guessed result names', () => {
    const messages = [user, assistant(['a']), result('a')];
    expect(sanitizeMessages(messages)).toEqual(messages);
    expect(sanitizeMessages(messages)[2]).not.toHaveProperty('name');
  });
  test('does not mutate input arrays or shared message objects', () => {
    const messages = [user, assistant(['a']), result('a'), result('extra')];
    const snapshot = JSON.stringify(messages);
    sanitizeMessages(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});
