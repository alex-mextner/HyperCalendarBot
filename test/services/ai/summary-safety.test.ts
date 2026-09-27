import { expect, test } from 'bun:test';
import { HistorySummarizer } from '../../../src/services/ai/history-summarizer.ts';
import { ProviderSafetyStopError } from '../../../src/services/ai/streaming.ts';

test('history condensation propagates a safety stop instead of silently routing around it', async () => {
  const stop = new ProviderSafetyStopError({
    classification: 'safety',
    finishReason: 'content_filter',
    chunkCount: 1,
    choiceCount: 1,
    toolFragmentCount: 0,
    maxOutputTokens: 256,
    messageCount: 1,
    toolCount: 0,
    usage: null,
  });
  const summarizer = new HistorySummarizer(null, async () => {
    throw stop;
  });
  await expect(summarizer.condenseMessage(1, 'read', 'synthetic '.repeat(100))).rejects.toBe(stop);
});
