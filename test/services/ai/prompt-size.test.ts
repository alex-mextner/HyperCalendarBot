// test/services/ai/prompt-size.test.ts
// The estimated size of an outgoing request, split into the parts a compaction can change. Estimates only:
// the provider's prompt_tokens stays the truth.
import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { estimatePromptSize } from '../../../src/services/ai/prompt-size.ts';
import { estimateTokens } from '../../../src/services/ai/token-estimate.ts';

type Message = OpenAI.ChatCompletionMessageParam;
type Tool = OpenAI.ChatCompletionTool;

const TOOL: Tool = {
  type: 'function',
  function: { name: 'get_events', description: 'List events', parameters: { type: 'object', properties: {} } },
};

describe('estimatePromptSize', () => {
  test('splits system, history and the last user message, and counts messages and tools', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a calendar assistant.' },
      { role: 'user', content: 'What is on Monday?' },
      { role: 'assistant', content: 'Nothing yet.' },
      { role: 'user', content: 'Add lunch at noon' },
    ];

    expect(estimatePromptSize(messages, [TOOL])).toEqual({
      systemPromptTokens: estimateTokens('You are a calendar assistant.'),
      toolCatalogTokens: estimateTokens(JSON.stringify([TOOL])),
      historyTokens: estimateTokens('What is on Monday?') + estimateTokens('Nothing yet.'),
      userTokens: estimateTokens('Add lunch at noon'),
      toolCount: 1,
      messageCount: 4,
    });
  });

  test('a request without tools has an empty catalog: 0 tools, 0 tokens, not unknown', () => {
    const size = estimatePromptSize([{ role: 'user', content: 'hi' }], undefined);
    expect(size.toolCatalogTokens).toBe(0);
    expect(size.toolCount).toBe(0);
    expect(estimatePromptSize([{ role: 'user', content: 'hi' }], []).toolCatalogTokens).toBe(0);
  });

  test('developer messages count as system; a trailing non-user message leaves user at 0', () => {
    const size = estimatePromptSize(
      [
        { role: 'developer', content: 'rules' },
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ],
      undefined,
    );
    expect(size.systemPromptTokens).toBe(estimateTokens('rules'));
    expect(size.userTokens).toBe(0);
    expect(size.historyTokens).toBe(estimateTokens('question') + estimateTokens('answer'));
  });

  test('assistant tool calls and tool results belong to the history', () => {
    const args = '{"date":"2026-10-26"}';
    const size = estimatePromptSize(
      [
        { role: 'user', content: 'what is on Monday' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_events', arguments: args } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: '[{"title":"Lunch"}]' },
        { role: 'user', content: 'thanks' },
      ],
      undefined,
    );
    expect(size.historyTokens).toBe(
      estimateTokens('what is on Monday') + estimateTokens(`get_events${args}`) + estimateTokens('[{"title":"Lunch"}]'),
    );
    expect(size.userTokens).toBe(estimateTokens('thanks'));
    expect(size.messageCount).toBe(4);
  });

  test('only text parts of a multi-part message are counted; images are ignored', () => {
    const size = estimatePromptSize(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(5000)}` } },
          ],
        },
      ],
      undefined,
    );
    expect(size.userTokens).toBe(estimateTokens('look at this'));
  });

  test('the estimate keeps no text', () => {
    const size = estimatePromptSize([{ role: 'user', content: 'SECRET-PROMPT' }], undefined);
    expect(JSON.stringify(size)).not.toContain('SECRET');
  });
});
