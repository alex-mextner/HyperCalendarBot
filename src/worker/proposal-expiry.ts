import type { CalendarProposal } from '../database/types.ts';
import { logger } from '../utils/logger.ts';

export async function runProposalExpiry(deps: {
  proposalRepo: { expirePending(): CalendarProposal[] };
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
}): Promise<void> {
  const expired = deps.proposalRepo.expirePending();

  for (const p of expired) {
    if (p.dm_message_id) {
      await deps
        .editMessage(p.target_id, p.dm_message_id, 'Предложение истекло.')
        .catch((err) => logger.error({ err, proposalId: p.id }, 'failed to edit expired proposal DM'));
    }
    if (p.group_message_id) {
      await deps
        .editMessage(p.group_chat_id, p.group_message_id, '⏱ Предложение истекло.')
        .catch((err) => logger.error({ err, proposalId: p.id }, 'failed to edit expired proposal group message'));
    }
  }
}
