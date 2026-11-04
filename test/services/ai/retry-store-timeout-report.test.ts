import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { storeRetryWithin } from '../../../src/services/ai/agent/retry-store.ts';
import { configureTimeoutReporter, TimeoutReporter } from '../../../src/services/incident/timeout-reporter.ts';

describe('retry store wait bound reports to the timeout alerts', () => {
  let alerts: Array<{ text: string; source: string }>;
  const hung = () => new Promise<boolean>(() => {});

  beforeEach(() => {
    alerts = [];
    configureTimeoutReporter(
      new TimeoutReporter(
        (text, source) => alerts.push({ text, source }),
        () => 1_000,
      ),
    );
  });
  afterEach(() => configureTimeoutReporter(null));

  test('a store that never answers is still unknown and raises one aggregated alert', async () => {
    expect(await storeRetryWithin(hung, 'm', 1, 5)).toBe('unknown');

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.source).toBe('timeout');
    expect(alerts[0]?.text).toContain('Timeout (retry_store)');
    expect(alerts[0]?.text).toContain('limitMs: 5');
    expect(alerts[0]?.text).toContain('unrecovered=1 recovered=0');
  });

  test('repeated timeouts inside the window stay one alert', async () => {
    expect(await storeRetryWithin(hung, 'm', 1, 5)).toBe('unknown');
    expect(await storeRetryWithin(hung, 'm', 1, 5)).toBe('unknown');
    expect(alerts).toHaveLength(1);
  });

  test('stored, declined and failed stores raise no timeout alert', async () => {
    expect(await storeRetryWithin(async () => true, 'm', 1, 50)).toBe('stored');
    expect(await storeRetryWithin(async () => false, 'm', 1, 50)).toBe('gave_up');
    expect(
      await storeRetryWithin(
        async () => {
          throw new Error('queue down');
        },
        'm',
        1,
        50,
      ),
    ).toBe('not_stored');
    expect(alerts).toEqual([]);
  });
});
