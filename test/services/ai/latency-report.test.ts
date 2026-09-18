import { describe, expect, test } from 'bun:test';
import { summarizeAiLogs } from '../../../src/services/ai/latency-report.ts';

describe('AI production latency report', () => {
  test('aggregates sanitized end-to-end, token and provider metrics', () => {
    const summary = summarizeAiLogs([
      {
        msg: 'AI request metric',
        requestId: 'a',
        elapsedMs: 500,
        firstVisibleMs: 100,
        modelDurationMs: 300,
        toolDurationMs: 20,
        deliveryActionMs: 30,
        modelCalls: 2,
        modelAttempts: 3,
        providerFallbacks: 1,
        promptTokens: 1000,
        completionTokens: 100,
        reportedTotalTokens: 1150,
        reasoningTokens: 20,
        cachedTokens: 300,
        usageMissingRounds: 0,
        usagePartialRounds: 1,
        termination: 'normal',
        deliveryOutcome: 'delivered',
        userId: 123,
      },
      {
        msg: 'AI request metric',
        requestId: 'b',
        elapsedMs: 900,
        firstVisibleMs: 200,
        modelDurationMs: 700,
        toolDurationMs: 40,
        deliveryActionMs: 50,
        modelCalls: 1,
        modelAttempts: 1,
        providerFallbacks: 0,
        promptTokens: 2000,
        completionTokens: 200,
        reportedTotalTokens: 2250,
        reasoningTokens: 30,
        cachedTokens: 0,
        usageMissingRounds: 1,
        usagePartialRounds: 0,
        termination: 'error',
        deliveryOutcome: 'fallback',
        chatId: 456,
      },
      {
        msg: 'AI model call metric',
        requestId: 'a',
        provider: 'groq',
        model: 'qwen',
        providerDurationMs: 80,
        totalDurationMs: 300,
        attemptCount: 2,
        fallbackCount: 1,
        failedProviders: [{ provider: 'zai', model: 'glm' }],
        success: true,
      },
      {
        msg: 'AI model call metric',
        requestId: 'b',
        provider: 'groq',
        model: 'qwen',
        providerDurationMs: 100,
        totalDurationMs: 700,
        attemptCount: 1,
        fallbackCount: 0,
        success: true,
      },
    ]);
    expect(summary.requests).toBe(2);
    expect(summary.endToEndMs).toEqual({ n: 2, p50: 500, p90: 900, p95: 900 });
    expect(summary.tokens).toMatchObject({
      prompt: 3000,
      completion: 300,
      reportedTotal: 3400,
      reasoning: 50,
      cached: 300,
      missingRounds: 1,
      partialRounds: 1,
      fallbacks: 1,
      attempts: 4,
      calls: 3,
    });
    expect(summary.byProvider['groq:qwen']).toEqual({
      n: 2,
      p50: 80,
      p90: 100,
      p95: 100,
      failures: 0,
      skippedBeforeRequest: 0,
    });
    expect(summary.byProvider['zai:glm']).toEqual({
      n: 0,
      p50: null,
      p90: null,
      p95: null,
      failures: 1,
      skippedBeforeRequest: 0,
    });
    expect(summary.outcomes).toEqual({ delivered: 1, fallback: 1 });
    expect(summarizeAiLogs([])).toMatchObject({
      requests: 0,
      endToEndMs: { n: 0, p50: null, p90: null, p95: null },
      byProvider: {},
      byTier: {},
    });
    expect(JSON.stringify(summary)).not.toContain('123');
    expect(JSON.stringify(summary)).not.toContain('456');
  });
});

test('preflight skips are separate from actual provider failures', () => {
  const summary = summarizeAiLogs([
    {
      msg: 'AI model call metric',
      requestId: 'a',
      provider: 'gemini',
      model: 'winner',
      providerDurationMs: 30,
      totalDurationMs: 100,
      failedProviders: [{ provider: 'zai', model: 'failed' }],
      skippedProviders: [{ provider: 'groq', model: 'oversized' }],
      success: true,
    },
  ]);
  expect(summary.byProvider['groq:oversized']).toMatchObject({ n: 0, failures: 0, skippedBeforeRequest: 1 });
  expect(summary.byProvider['zai:failed']).toMatchObject({ n: 0, failures: 1, skippedBeforeRequest: 0 });
  expect(summary.byProvider['gemini:winner']).toMatchObject({ p50: 30, failures: 0, skippedBeforeRequest: 0 });
});
