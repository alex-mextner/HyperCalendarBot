import { describe, expect, test } from 'bun:test';
import { AgentRequestMetrics } from '../../../src/services/ai/request-metrics.ts';
import type { StreamRoundMetrics } from '../../../src/services/ai/streaming.ts';

const round = (usage: StreamRoundMetrics['usage']): StreamRoundMetrics => ({
  provider: 'groq',
  model: 'synthetic',
  chain: 'fast',
  firstUsableSinceAttemptMs: 5,
  providerDurationMs: 20,
  totalDurationMs: 30,
  attemptCount: 2,
  fallbackCount: 1,
  usage,
});

describe('AgentRequestMetrics', () => {
  test('accumulates complete, partial, missing and failed rounds without inventing usage', () => {
    const m = new AgentRequestMetrics();
    m.recordRound(
      round({ promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedTokens: 1, reasoningTokens: 0 }),
    );
    m.recordRound(
      round({ promptTokens: 5, completionTokens: 1, totalTokens: 8, cachedTokens: null, reasoningTokens: 2 }),
    );
    m.recordRound(round(null));
    m.recordFailedRound(40, 3, 2);
    m.recordTool(7);
    const s = m.snapshot('error', 'discarded', 4);
    expect(s.modelCalls).toBe(4);
    expect(s.modelAttempts).toBe(9);
    expect(s.providerFallbacks).toBe(5);
    expect(s.promptTokens).toBe(15);
    expect(s.completionTokens).toBe(3);
    expect(s.reportedTotalTokens).toBe(20);
    expect(s.cachedTokens).toBe(1);
    expect(s.reasoningTokens).toBe(2);
    expect(s.usagePartialRounds).toBe(1);
    expect(s.usageMissingRounds).toBe(2);
    expect(s.toolDurationMs).toBe(7);
  });
  test('first visible is latched once', async () => {
    const m = new AgentRequestMetrics();
    expect(m.snapshot('normal', 'delivered', 0).firstVisibleMs).toBeNull();
    m.markVisible();
    const first = m.snapshot('normal', 'delivered', 0).firstVisibleMs;
    await Bun.sleep(2);
    m.markVisible();
    expect(m.snapshot('normal', 'delivered', 0).firstVisibleMs).toBe(first);
  });
});
