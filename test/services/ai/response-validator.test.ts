import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { validateResponse } from '../../../src/services/ai/response-validator.ts';

function makeMockClient(responseText: string): Anthropic {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'text' as const, text: responseText }],
      }),
    },
  } as unknown as Anthropic;
}

function makeFailingClient(error: Error): Anthropic {
  return {
    messages: {
      create: async () => {
        throw error;
      },
    },
  } as unknown as Anthropic;
}

const MODEL = 'claude-haiku-test';

describe('validateResponse', () => {
  test('returns approved=true when validator responds with APPROVE', async () => {
    const client = makeMockClient('APPROVE');
    const result = await validateResponse(client, MODEL, {
      userMessage: 'Hello!',
      toolCalls: [],
      response: 'Hi there, how can I help you?',
    });
    expect(result).toEqual({ approved: true });
  });

  test('returns approved=true when APPROVE has trailing text', async () => {
    const client = makeMockClient('APPROVE - greeting response, no tools needed');
    const result = await validateResponse(client, MODEL, {
      userMessage: 'Hi',
      toolCalls: [],
      response: 'Hello!',
    });
    expect(result).toEqual({ approved: true });
  });

  test('returns approved=false with reason when validator responds with REJECT', async () => {
    const client = makeMockClient('REJECT: No tool calls for a data question');
    const result = await validateResponse(client, MODEL, {
      userMessage: 'What events do I have tomorrow?',
      toolCalls: [],
      response: 'You have a meeting at 10am.',
    });
    expect(result).toEqual({
      approved: false,
      reason: 'No tool calls for a data question',
    });
  });

  test('returns fallback reason when REJECT has no message', async () => {
    const client = makeMockClient('REJECT:');
    const result = await validateResponse(client, MODEL, {
      userMessage: 'Delete my event',
      toolCalls: [],
      response: 'Done!',
    });
    expect(result).toEqual({
      approved: false,
      reason: 'Validation failed',
    });
  });

  test('returns approved=false when REJECT has only whitespace after colon', async () => {
    const client = makeMockClient('REJECT:   ');
    const result = await validateResponse(client, MODEL, {
      userMessage: 'Show my week',
      toolCalls: [],
      response: 'Here is your week...',
    });
    expect(result).toEqual({
      approved: false,
      reason: 'Validation failed',
    });
  });

  test('returns approved=false when API fails and no tools were called', async () => {
    const client = makeFailingClient(new Error('API timeout'));
    const result = await validateResponse(client, MODEL, {
      userMessage: 'What is on my calendar?',
      toolCalls: [],
      response: 'You have 3 events.',
    });
    expect(result).toEqual({
      approved: false,
      reason: 'Validator unavailable and no tools were called — likely hallucination',
    });
  });

  test('returns approved=true when API fails but tools were called', async () => {
    const client = makeFailingClient(new Error('Network error'));
    const result = await validateResponse(client, MODEL, {
      userMessage: 'What is on my calendar?',
      toolCalls: ['get_events', 'get_upcoming'],
      response: 'You have a meeting at 10am and lunch at noon.',
    });
    expect(result).toEqual({ approved: true });
  });

  test('handles unexpected empty content from API', async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [],
        }),
      },
    } as unknown as Anthropic;

    const result = await validateResponse(client, MODEL, {
      userMessage: 'Hi',
      toolCalls: [],
      response: 'Hello!',
    });
    // Empty text doesn't start with APPROVE, so falls through to reject path
    expect(result.approved).toBe(false);
    expect((result as { approved: false; reason: string }).reason).toBe('Validation failed');
  });

  test('handles non-text content block from API', async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [{ type: 'tool_use', id: 'x', name: 'y', input: {} }],
        }),
      },
    } as unknown as Anthropic;

    const result = await validateResponse(client, MODEL, {
      userMessage: 'Hi',
      toolCalls: ['search_events'],
      response: 'No events found.',
    });
    // Non-text block yields empty string, doesn't start with APPROVE
    expect(result.approved).toBe(false);
    expect((result as { approved: false; reason: string }).reason).toBe('Validation failed');
  });

  test('REJECT reason is case-insensitive for the prefix', async () => {
    const client = makeMockClient('reject: lowercase prefix test');
    const result = await validateResponse(client, MODEL, {
      userMessage: 'Show events',
      toolCalls: [],
      response: 'Here are your events...',
    });
    // The text doesn't start with "APPROVE", so it's a reject.
    // The regex /^REJECT:\s*/i strips the prefix case-insensitively.
    expect(result).toEqual({
      approved: false,
      reason: 'lowercase prefix test',
    });
  });

  test('passes tool calls summary to the API', async () => {
    let capturedBody: { messages?: Array<{ content: string }> } = {};
    const client = {
      messages: {
        create: async (body: { messages: Array<{ content: string }> }) => {
          capturedBody = body;
          return { content: [{ type: 'text' as const, text: 'APPROVE' }] };
        },
      },
    } as unknown as Anthropic;

    await validateResponse(client, MODEL, {
      userMessage: 'When is my dentist?',
      toolCalls: ['search_events'],
      response: 'Your dentist appointment is Thursday at 2pm.',
    });

    const userContent = capturedBody.messages?.[0]?.content ?? '';
    expect(userContent).toContain('search_events');
    expect(userContent).toContain('When is my dentist?');
  });

  test('shows (none) when no tools were called', async () => {
    let capturedBody: { messages?: Array<{ content: string }> } = {};
    const client = {
      messages: {
        create: async (body: { messages: Array<{ content: string }> }) => {
          capturedBody = body;
          return { content: [{ type: 'text' as const, text: 'APPROVE' }] };
        },
      },
    } as unknown as Anthropic;

    await validateResponse(client, MODEL, {
      userMessage: 'Hello',
      toolCalls: [],
      response: 'Hi!',
    });

    const userContent = capturedBody.messages?.[0]?.content ?? '';
    expect(userContent).toContain('(none');
  });

  test('truncates long responses to 2000 chars in the prompt', async () => {
    let capturedBody: { messages?: Array<{ content: string }> } = {};
    const client = {
      messages: {
        create: async (body: { messages: Array<{ content: string }> }) => {
          capturedBody = body;
          return { content: [{ type: 'text' as const, text: 'APPROVE' }] };
        },
      },
    } as unknown as Anthropic;

    const longResponse = 'A'.repeat(5000);
    await validateResponse(client, MODEL, {
      userMessage: 'Show events',
      toolCalls: ['get_events'],
      response: longResponse,
    });

    const userContent = capturedBody.messages?.[0]?.content ?? '';
    // The response portion should be truncated at 2000 chars
    // Total content includes headers, so we check the response doesn't contain 5000 A's
    expect(userContent).not.toContain('A'.repeat(3000));
    expect(userContent).toContain('A'.repeat(2000));
  });
});
