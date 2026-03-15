// src/services/sharing/sharing-cleanup.ts
import type { DeepLinkRepository } from '../../database/repositories/deep-link.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import { logger } from '../../utils/logger.ts';

const sharingLogger = logger.child({ module: 'sharing-cleanup' });

export interface SharingCleanupHandle {
  stop: () => void;
  /** Run one cleanup tick manually (for testing). */
  tick: () => SharingCleanupResult;
}

export interface SharingCleanupResult {
  expiredInvitations: number;
  deletedDeepLinks: number;
  cleanedSessions: number;
}

const DEFAULT_INTERVAL_MS = 10 * 60_000; // 10 minutes

export function setupSharingCleanup(
  invitationRepo: InvitationRepository,
  deepLinkRepo: DeepLinkRepository,
  intervalMs = DEFAULT_INTERVAL_MS,
): SharingCleanupHandle {
  function tick(): SharingCleanupResult {
    try {
      const expiredInvitations = invitationRepo.expirePastInvitations();
      const deletedDeepLinks = deepLinkRepo.deleteExpired();
      // Placeholder for Redis share-session cleanup — no sessions to clean yet
      const cleanedSessions = 0;

      if (expiredInvitations > 0 || deletedDeepLinks > 0) {
        sharingLogger.info({ expiredInvitations, deletedDeepLinks, cleanedSessions }, 'Sharing cleanup completed');
      }

      return { expiredInvitations, deletedDeepLinks, cleanedSessions };
    } catch (error) {
      sharingLogger.error({ error: String(error) }, 'Sharing cleanup failed');
      return { expiredInvitations: 0, deletedDeepLinks: 0, cleanedSessions: 0 };
    }
  }

  const timer = setInterval(tick, intervalMs);

  sharingLogger.info({ intervalMs }, 'Sharing cleanup scheduled');

  return { stop: () => clearInterval(timer), tick };
}
