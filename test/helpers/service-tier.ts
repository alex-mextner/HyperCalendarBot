// Synthetic service tiers for consumer tests. Consumers get the shared MTProto account only through
// the tier, so a test picks "off" or "on, answering like this" and never touches env, a session
// file or a Python process.
import {
  type DisabledServiceTier,
  type EnabledServiceTier,
  SERVICE_SCRIPTS,
} from '../../src/services/telegram-session/service-tier.ts';

export const disabledServiceTier: DisabledServiceTier = { enabled: false, reason: 'service_user_id_unset' };

/** An enabled tier whose every lookup answers "unavailable" unless the test overrides it. */
export function enabledServiceTier(overrides: Partial<Omit<EnabledServiceTier, 'enabled'>> = {}): EnabledServiceTier {
  return {
    enabled: true,
    accountId: 5_000_000_001,
    voiceBridgeScript: SERVICE_SCRIPTS.voiceBridge,
    resolveUsername: async () => null,
    lookupUser: async () => null,
    getChatMembers: async () => null,
    fetchBirthdays: async () => null,
    ...overrides,
  };
}
