// src/services/sharing/sharing-cleanup.ts
import type { DeepLinkRepository } from '../../database/repositories/deep-link.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import { logger } from '../../utils/logger.ts';

const sharingLogger = logger.child({ module: 'sharing-cleanup' });

export interface SharingCleanupResult {
  expiredInvitations: number;
  deletedDeepLinks: number;
  cleanedSessions: number;
}

export function runSharingCleanup(deps: {
  invitationRepo: InvitationRepository;
  deepLinkRepo: DeepLinkRepository;
}): SharingCleanupResult {
  try {
    const expiredInvitations = deps.invitationRepo.expirePastInvitations();
    const deletedDeepLinks = deps.deepLinkRepo.deleteExpired();
    const cleanedSessions = 0;

    if (expiredInvitations > 0 || deletedDeepLinks > 0) {
      sharingLogger.info({ expiredInvitations, deletedDeepLinks, cleanedSessions }, 'Sharing cleanup completed');
    }

    return { expiredInvitations, deletedDeepLinks, cleanedSessions };
  } catch (error) {
    sharingLogger.error({ err: error }, 'Sharing cleanup failed');
    return { expiredInvitations: 0, deletedDeepLinks: 0, cleanedSessions: 0 };
  }
}
