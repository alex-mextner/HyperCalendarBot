import { afterEach, beforeEach, expect, test } from 'bun:test';
import { inspectRecipientProfile } from '../../../src/services/ai/recipient-profile.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { configureTimeoutReporter, TimeoutReporter } from '../../../src/services/incident/timeout-reporter.ts';

const realSetTimeout = globalThis.setTimeout;
let alerts: string[];

beforeEach(() => {
  alerts = [];
  configureTimeoutReporter(
    new TimeoutReporter(
      (text) => alerts.push(text),
      () => 1_000,
    ),
  );
  // Fire the 20s lookup deadline immediately.
  globalThis.setTimeout = ((fn: () => void, ms?: number) =>
    realSetTimeout(fn, ms === 20_000 ? 0 : ms)) as unknown as typeof setTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  configureTimeoutReporter(null);
});

function hangingContext(): AgentContext {
  return {
    user: { telegram_id: 10, language: 'en' },
    lookupTelegramUser: () => new Promise(() => {}),
  } as unknown as AgentContext;
}

test('hung profile lookup resolves null and reports one aggregated recipient_profile alert', async () => {
  for (let id = 1; id <= 3; id++) {
    expect(await inspectRecipientProfile(hangingContext(), id)).toBeNull();
  }
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain('Timeout (recipient_profile)');
});
