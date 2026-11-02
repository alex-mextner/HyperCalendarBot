import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureTimeoutReporter, TimeoutReporter } from '../../../src/services/incident/timeout-reporter.ts';
import { NliClassifier } from '../../../src/services/nli/nli-classifier.ts';

const realSetTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;
let alerts: string[];

beforeEach(() => {
  alerts = [];
  configureTimeoutReporter(
    new TimeoutReporter(
      (text) => alerts.push(text),
      () => 1_000,
    ),
  );
  globalThis.setTimeout = ((fn: () => void, ms?: number) =>
    realSetTimeout(fn, ms === 3000 ? 0 : ms)) as unknown as typeof setTimeout;
  // A request that never answers and rejects with AbortError when the classifier aborts it.
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    return promise;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.fetch = realFetch;
  configureTimeoutReporter(null);
});

test('hung NLI request fails open and reports one aggregated nli alert', async () => {
  const classifier = new NliClassifier('test-token');
  for (let i = 0; i < 3; i++) expect(await classifier.isCalendarRelated('synthetic text')).toBe(true);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain('Timeout (nli)');
});
