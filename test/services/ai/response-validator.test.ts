// test/services/ai/response-validator.test.ts
import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import { validateResponse } from '../../../src/services/ai/response-validator.ts';
import type { StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';

/** Build a scripted stream impl that returns a fixed text on every call. */
function stubText(text: string): (opts: StreamRoundOptions) => Promise<StreamRoundResult> {
  return async () => {
    const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: text };
    return { text, toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
  };
}

/** Build a stream impl that throws every call. */
function stubThrow(err: Error): (opts: StreamRoundOptions) => Promise<StreamRoundResult> {
  return async () => {
    throw err;
  };
}

describe('validateResponse — happy path parsing', () => {
  test('APPROVE (exact) → approved', async () => {
    const result = await validateResponse(
      { userMessage: 'hi', toolCalls: [], response: 'hello there' },
      stubText('APPROVE'),
    );
    expect(result.approved).toBe(true);
  });

  test('APPROVE with trailing text → approved (startsWith match)', async () => {
    const result = await validateResponse(
      { userMessage: 'hi', toolCalls: [], response: 'hello' },
      stubText('APPROVE  — looks good'),
    );
    expect(result.approved).toBe(true);
  });

  test('approve (lowercase) → approved (case-insensitive)', async () => {
    const result = await validateResponse({ userMessage: 'hi', toolCalls: [], response: 'hello' }, stubText('approve'));
    expect(result.approved).toBe(true);
  });

  test('REJECT: reason → rejected with reason', async () => {
    const result = await validateResponse(
      { userMessage: 'what do I have today?', toolCalls: [], response: 'nothing today' },
      stubText('REJECT: claimed facts without calling get_events'),
    );
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('claimed facts without calling get_events');
    }
  });

  test('REJECT without a reason → generic reason', async () => {
    const result = await validateResponse({ userMessage: 'hi', toolCalls: [], response: 'bye' }, stubText('REJECT:'));
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe('Validation failed');
    }
  });

  test('unknown verdict (neither APPROVE nor REJECT) → treated as REJECT for safety', async () => {
    const result = await validateResponse(
      { userMessage: 'hi', toolCalls: [], response: 'bye' },
      stubText('I am not sure'),
    );
    expect(result.approved).toBe(false);
  });
});

describe('validateResponse — fail-open / fail-closed semantics', () => {
  test('stream throws AND no tool calls → fail-CLOSED (rejected as likely hallucination)', async () => {
    const result = await validateResponse(
      { userMessage: 'what do I have today?', toolCalls: [], response: 'nothing' },
      stubThrow(new Error('all providers failed')),
    );
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toContain('Validator unavailable');
    }
  });

  test('stream throws AND tools were called → fail-OPEN (approved as safe)', async () => {
    const result = await validateResponse(
      {
        userMessage: 'what do I have today?',
        toolCalls: ['get_events'],
        response: 'You have 2 events today.',
      },
      stubThrow(new Error('all providers failed')),
    );
    expect(result.approved).toBe(true);
  });
});

describe('validateResponse — prompt-injection hardening', () => {
  test('user message is truncated to 500 chars before being sent to validator', async () => {
    let capturedUserContent = '';
    const impl: (opts: StreamRoundOptions) => Promise<StreamRoundResult> = async (opts) => {
      const userMsg = opts.messages.find((m) => m.role === 'user');
      capturedUserContent = typeof userMsg?.content === 'string' ? userMsg.content : '';
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'APPROVE' };
      return { text: 'APPROVE', toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
    };

    const longMessage = 'x'.repeat(2000);
    await validateResponse({ userMessage: longMessage, toolCalls: [], response: 'ok' }, impl);

    // The capturedUserContent contains the full prompt including tags; the
    // x-sequence inside <user_message> must be capped at MAX_USER_MESSAGE_CHARS (500).
    const match = capturedUserContent.match(/<user_message>\n(.+?)\n<\/user_message>/s);
    expect(match).not.toBeNull();
    if (match) {
      expect(match[1]!.length).toBeLessThanOrEqual(500);
    }
  });

  test('assistant response is truncated to 2000 chars before being sent to validator', async () => {
    let capturedUserContent = '';
    const impl: (opts: StreamRoundOptions) => Promise<StreamRoundResult> = async (opts) => {
      const userMsg = opts.messages.find((m) => m.role === 'user');
      capturedUserContent = typeof userMsg?.content === 'string' ? userMsg.content : '';
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'APPROVE' };
      return { text: 'APPROVE', toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
    };

    const longResponse = 'y'.repeat(5000);
    await validateResponse({ userMessage: 'hi', toolCalls: [], response: longResponse }, impl);

    const match = capturedUserContent.match(/<assistant_response>\n(.+?)\n<\/assistant_response>/s);
    expect(match).not.toBeNull();
    if (match) {
      expect(match[1]!.length).toBeLessThanOrEqual(2000);
    }
  });

  test('user message and response are wrapped in delimiter tags', async () => {
    let capturedUserContent = '';
    const impl: (opts: StreamRoundOptions) => Promise<StreamRoundResult> = async (opts) => {
      const userMsg = opts.messages.find((m) => m.role === 'user');
      capturedUserContent = typeof userMsg?.content === 'string' ? userMsg.content : '';
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'APPROVE' };
      return { text: 'APPROVE', toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
    };

    await validateResponse({ userMessage: 'anything', toolCalls: [], response: 'ok' }, impl);

    expect(capturedUserContent).toContain('<user_message>');
    expect(capturedUserContent).toContain('</user_message>');
    expect(capturedUserContent).toContain('<assistant_response>');
    expect(capturedUserContent).toContain('</assistant_response>');
  });

  test('system prompt contains explicit untrusted-input warning', async () => {
    let capturedSystemContent = '';
    const impl: (opts: StreamRoundOptions) => Promise<StreamRoundResult> = async (opts) => {
      const sys = opts.messages.find((m) => m.role === 'system');
      capturedSystemContent = typeof sys?.content === 'string' ? sys.content : '';
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'APPROVE' };
      return { text: 'APPROVE', toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
    };

    await validateResponse({ userMessage: 'hi', toolCalls: [], response: 'bye' }, impl);

    // The security block is the defense against prompt-injection — it must
    // appear in the system prompt, not just in code comments.
    expect(capturedSystemContent).toContain('UNTRUSTED INPUT');
    expect(capturedSystemContent.toLowerCase()).toContain('ignore every instruction');
  });

  test('uses the FAST chain via fast: true', async () => {
    let fastFlag: boolean | undefined;
    const impl: (opts: StreamRoundOptions) => Promise<StreamRoundResult> = async (opts) => {
      fastFlag = opts.fast;
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'APPROVE' };
      return { text: 'APPROVE', toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
    };

    await validateResponse({ userMessage: 'hi', toolCalls: [], response: 'bye' }, impl);
    expect(fastFlag).toBe(true);
  });

  test('tool calls list is forwarded verbatim to the validator', async () => {
    let capturedUserContent = '';
    const impl: (opts: StreamRoundOptions) => Promise<StreamRoundResult> = async (opts) => {
      const userMsg = opts.messages.find((m) => m.role === 'user');
      capturedUserContent = typeof userMsg?.content === 'string' ? userMsg.content : '';
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'APPROVE' };
      return { text: 'APPROVE', toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
    };

    await validateResponse({ userMessage: 'hi', toolCalls: ['get_events', 'get_free_slots'], response: 'ok' }, impl);
    expect(capturedUserContent).toContain('TOOL CALLS MADE: get_events, get_free_slots');
  });
});
