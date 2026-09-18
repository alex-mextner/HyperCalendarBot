import { expect, test } from 'bun:test';
import { probeAiChain } from '../../scripts/probe-ai-chain.ts';
import type { StreamRoundOptions, StreamRoundResult } from '../../src/services/ai/streaming.ts';

function response(text: string): StreamRoundResult {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    providerUsed: 'synthetic',
    assistantMessage: { role: 'assistant', content: text },
  };
}
test('probe sends only its synthetic no-tool request and records no model prose', async () => {
  let options: StreamRoundOptions | undefined;
  const result = await probeAiChain(true, async (input) => {
    options = input;
    return response('HCB_RUNTIME_OK');
  });
  expect(result.ok).toBe(true);
  expect(options?.tools).toBeUndefined();
  expect(options?.userId).toBeUndefined();
  expect(options?.fast).toBe(true);
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.stringify(result)).not.toContain('HCB_RUNTIME_OK');
});
test('unexpected text cannot be reported as a successful chain probe', async () => {
  const result = await probeAiChain(false, async () => response('unverified reply'));
  expect(result.ok).toBe(false);
  expect(result.chain).toBe('smart');
  expect(JSON.stringify(result)).not.toContain('unverified reply');
});
test('probe error output does not disclose provider error bodies or credentials', async () => {
  const result = await probeAiChain(true, async () => {
    throw new Error('synthetic private detail');
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain('synthetic private detail');
});

test('matching marker with truncated generation is not success', async () => {
  const result = await probeAiChain(true, async () => ({ ...response('HCB_RUNTIME_OK'), finishReason: 'length' }));
  expect(result.ok).toBe(false);
});
