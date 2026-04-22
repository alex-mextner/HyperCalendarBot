import { type Lang, t } from '../../config/constants.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { ParticipantGoogleSyncRepository } from '../../database/repositories/participant-google-sync.repository.ts';
import type { CalendarEvent, ParticipantGoogleSync } from '../../database/types.ts';

type UnfilteredEvent = Pick<
  CalendarEvent,
  | 'id'
  | 'user_id'
  | 'title'
  | 'description'
  | 'start_at'
  | 'end_at'
  | 'all_day'
  | 'timezone'
  | 'location'
  | 'recurrence_rule'
  | 'reminder_overrides'
  | 'sync_version'
  | 'owner_type'
>;

import { syncLogger } from '../../utils/logger.ts';
import type { LocalEventFromGoogleSnapshot } from './change-detection.ts';
import {
  computeEventDiff,
  formatChanges,
  getPersonalChanges,
  getSharedChanges,
  snapshotFromCalendarEvent,
  snapshotFromGoogleLocal,
} from './change-detection.ts';

export interface ParticipantHandlerDeps {
  eventRepo: EventRepository;
  participantRepo: ParticipantRepository;
  participantSyncRepo: ParticipantGoogleSyncRepository;
  editProposalRepo: EditProposalRepository;
  invitationRepo: InvitationRepository;
  notifyUser: (userId: number, text: string) => Promise<void>;
  sendMessageWithButtons?: (
    userId: number,
    text: string,
    buttons: { text: string; callbackData: string }[][],
  ) => Promise<{ messageId: number; chatId: number } | null>;
  getUserLang: (userId: number) => Lang;
  getUserName: (userId: number) => string;
}

export async function handleParticipantChange(
  participantUserId: number,
  masterEvent: UnfilteredEvent,
  incomingLocal: LocalEventFromGoogleSnapshot & { google_etag: string | null },
  deps: ParticipantHandlerDeps,
): Promise<void> {
  if (masterEvent.owner_type !== 'user') return;

  const masterSnapshot = snapshotFromCalendarEvent(masterEvent);
  const incomingSnapshot = snapshotFromGoogleLocal(incomingLocal);
  const allChanges = computeEventDiff(masterSnapshot, incomingSnapshot);
  if (allChanges.length === 0) return;

  const personalChanges = getPersonalChanges(allChanges);
  for (const change of personalChanges) {
    if (change.field === 'timezone' && typeof change.newValue === 'string') {
      deps.participantSyncRepo.updateTimezoneOverride(participantUserId, masterEvent.id, change.newValue);
    }
  }

  const sharedChanges = getSharedChanges(allChanges);

  if (sharedChanges.length > 0) {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const originalValues = JSON.stringify(Object.fromEntries(sharedChanges.map((c) => [c.field, c.oldValue])));
    const changesJson = JSON.stringify(sharedChanges);

    const existing = deps.editProposalRepo.getPendingByProposerAndEvent(participantUserId, masterEvent.id);
    if (existing) {
      deps.editProposalRepo.updateChanges(existing.id, changesJson, originalValues, expiresAt);
      syncLogger.info(
        { proposalId: existing.id, participantUserId, eventId: masterEvent.id },
        'Updated existing edit proposal',
      );
    } else {
      const proposal = deps.editProposalRepo.create({
        event_id: masterEvent.id,
        proposer_id: participantUserId,
        changes: changesJson,
        original_values: originalValues,
        expires_at: expiresAt,
        source: 'google_sync',
      });

      const participantName = deps.getUserName(participantUserId);
      const orgLang = deps.getUserLang(masterEvent.user_id);
      const changesText = formatChanges(sharedChanges, orgLang);
      const text = t(orgLang).sync.changeProposed(participantName, masterEvent.title, changesText);

      if (deps.sendMessageWithButtons) {
        const buttons = [
          [
            { text: t(orgLang).sync.acceptBtn, callbackData: `epr:accept:${proposal.id}` },
            { text: t(orgLang).sync.rejectBtn, callbackData: `epr:reject:${proposal.id}` },
          ],
        ];
        const result = await deps.sendMessageWithButtons(masterEvent.user_id, text, buttons).catch((err) => {
          syncLogger.error({ err, proposalId: proposal.id }, 'Failed to send proposal with buttons');
          return null;
        });
        if (result) {
          deps.editProposalRepo.setMessageInfo(proposal.id, {
            organizer_message_id: result.messageId,
            organizer_chat_id: result.chatId,
          });
        }
      } else {
        await deps.notifyUser(masterEvent.user_id, text).catch((err) => {
          syncLogger.error({ err, proposalId: proposal.id }, 'Failed to notify organizer about proposal');
        });
      }

      syncLogger.info(
        { proposalId: proposal.id, participantUserId, eventId: masterEvent.id },
        'Created edit proposal from participant GCal change',
      );
    }
  }

  deps.participantSyncRepo.updateSyncFields(participantUserId, masterEvent.id, {
    google_etag: incomingLocal.google_etag ?? undefined,
    last_synced_at: new Date().toISOString(),
  });
}

export async function handleParticipantDelete(
  participantUserId: number,
  participantSync: ParticipantGoogleSync,
  deps: ParticipantHandlerDeps,
): Promise<void> {
  const masterEvent = deps.eventRepo.findByIdUnfiltered(participantSync.event_id);
  if (!masterEvent) return;

  deps.participantRepo.updateStatus(masterEvent.id, participantUserId, 'declined');

  const invitation = deps.invitationRepo.findActiveByEventAndInvitee(masterEvent.id, participantUserId);
  if (invitation) {
    deps.invitationRepo.updateStatus(invitation.id, 'declined', invitation.status);
  }

  deps.participantSyncRepo.delete(participantUserId, masterEvent.id);

  const pendingProposals = deps.editProposalRepo.getPendingByProposerAndEvent(participantUserId, masterEvent.id);
  if (pendingProposals) {
    deps.editProposalRepo.updateStatus(pendingProposals.id, 'rejected');
  }

  const participantName = deps.getUserName(participantUserId);
  const orgLang = deps.getUserLang(masterEvent.user_id);
  await deps
    .notifyUser(masterEvent.user_id, t(orgLang).sync.participantDeclinedViaGoogle(participantName, masterEvent.title))
    .catch((err) => {
      syncLogger.error({ err, participantUserId, eventId: masterEvent.id }, 'Failed to notify organizer about decline');
    });

  syncLogger.info({ participantUserId, eventId: masterEvent.id }, 'Participant declined via Google Calendar delete');
}
