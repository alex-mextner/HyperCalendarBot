import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resolveInvitationRecipient } from '../../../src/services/ai/recipient-identity.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { configureTimeoutReporter, TimeoutReporter } from '../../../src/services/incident/timeout-reporter.ts';

const GROUP_ID = -1001234567890;
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
  // Fire the 3s membership deadline immediately.
  globalThis.setTimeout = ((fn: () => void, ms?: number) =>
    realSetTimeout(fn, ms === 3000 ? 0 : ms)) as unknown as typeof setTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  configureTimeoutReporter(null);
});

function hangingContext(): AgentContext {
  return {
    user: { telegram_id: 10, language: 'en' },
    messageText: 'Invite the group',
    userRepo: { findByTelegramId: () => null, findByUsername: () => null },
    group: { checkGroupMembership: () => new Promise<boolean>(() => {}) },
  } as unknown as AgentContext;
}

test('hung membership check reports one aggregated recipient_lookup alert and result is unchanged', async () => {
  for (let i = 0; i < 3; i++) {
    expect(await resolveInvitationRecipient(hangingContext(), { invitee_id: GROUP_ID }, GROUP_ID)).toEqual({
      ok: false,
      reason: 'unverified',
    });
  }
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toContain('Timeout (recipient_lookup)');
});
