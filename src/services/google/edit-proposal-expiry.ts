import type { Queue } from 'bullmq';
import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import { syncLogger } from '../../utils/logger.ts';
import type { GoogleSyncJobData } from './sync-queue.ts';

export interface EditProposalExpiryDeps {
  editProposalRepo: EditProposalRepository;
  eventRepo: EventRepository;
  syncQueue: Queue<GoogleSyncJobData>;
  notifyUser: (userId: number, text: string) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
  getUserLang: (userId: number) => Lang;
}

export async function processExpiredEditProposals(deps: EditProposalExpiryDeps): Promise<void> {
  const expired = deps.editProposalRepo.getExpired();
  if (expired.length === 0) return;

  syncLogger.info({ count: expired.length }, 'Processing expired edit proposals');

  for (const proposal of expired) {
    deps.editProposalRepo.updateStatus(proposal.id, 'expired');

    await deps.syncQueue
      .add('push-participant-event', {
        type: 'push-participant-event',
        userId: proposal.proposer_id,
        eventId: proposal.event_id,
        action: 'update',
      })
      .catch((err) => {
        syncLogger.error({ err, proposalId: proposal.id }, 'Failed to enqueue revert push for expired proposal');
      });

    const event = deps.eventRepo.findByIdUnfiltered(proposal.event_id);
    if (!event) continue;

    const lang = deps.getUserLang(proposal.proposer_id);
    await deps.notifyUser(proposal.proposer_id, t(lang).sync.proposalExpired(event.title)).catch((err) => {
      syncLogger.error({ err, proposalId: proposal.id }, 'Failed to notify proposer about expired proposal');
    });

    if (proposal.organizer_chat_id && proposal.organizer_message_id) {
      const orgLang = deps.getUserLang(event.user_id);
      await deps
        .editMessage(
          proposal.organizer_chat_id,
          proposal.organizer_message_id,
          t(orgLang).sync.proposalExpiredOrganizer(event.title),
        )
        .catch((err) => {
          syncLogger.error({ err, proposalId: proposal.id }, 'Failed to edit organizer message for expired proposal');
        });
    }
  }
}
