import type { Queue } from 'bullmq';
import { type Lang, t } from '../../config/constants.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { ParticipantGoogleSyncRepository } from '../../database/repositories/participant-google-sync.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';
import type { FieldChange } from '../google/change-detection.ts';
import { formatChanges, getSharedChanges, hasTimeChange } from '../google/change-detection.ts';
import type { GoogleSyncJobData } from '../google/sync-queue.ts';
import type { ReminderMaterializer } from '../notification/materializer.ts';

export type ChangeSource = 'bot' | 'google_sync' | 'proposal_accept';

export interface ChangeNotifierOptions {
  skipProposalExpiry?: boolean;
  excludeUserIds?: number[];
  source?: ChangeSource;
}

export interface EventChangeNotifierDeps {
  participantRepo: ParticipantRepository;
  editProposalRepo: EditProposalRepository;
  participantSyncRepo: ParticipantGoogleSyncRepository;
  invitationRepo: InvitationRepository;
  materializer: ReminderMaterializer;
  syncQueue: Queue<GoogleSyncJobData>;
  notifyUser: (userId: number, text: string) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
  getUserLang: (userId: number) => Lang;
}

export class EventChangeNotifier {
  constructor(private deps: EventChangeNotifierDeps) {}

  async onEventChanged(params: {
    event: CalendarEvent;
    changes: FieldChange[];
    source: ChangeSource;
    skipProposalExpiry?: boolean;
    excludeUserIds?: number[];
  }): Promise<void> {
    const { event, changes, source, skipProposalExpiry, excludeUserIds } = params;
    if (event.owner_type !== 'user') return;

    const sharedChanges = getSharedChanges(changes);
    if (sharedChanges.length === 0) return;

    const participants = this.deps.participantRepo.getByEvent(event.id);
    const active = participants.filter(
      (p) => p.status !== 'declined' && p.user_id !== event.user_id && !excludeUserIds?.includes(p.user_id),
    );

    if (!skipProposalExpiry) {
      await this.expirePendingProposals(event);
    }

    if (active.length === 0) return;

    for (const p of active) {
      const lang = this.deps.getUserLang(p.user_id);
      const text = t(lang).sync.eventChanged(event.title, formatChanges(sharedChanges, lang));
      await this.deps.notifyUser(p.user_id, text).catch((err) => {
        logger.error({ err, userId: p.user_id, eventId: event.id }, 'Failed to notify participant about event change');
      });

      await this.deps.syncQueue
        .add('push-participant-event', {
          type: 'push-participant-event',
          userId: p.user_id,
          eventId: event.id,
          action: 'update',
        })
        .catch((err) => {
          logger.error({ err, userId: p.user_id, eventId: event.id }, 'Failed to enqueue participant GCal push');
        });
    }

    if (source === 'bot' || source === 'proposal_accept') {
      await this.deps.syncQueue
        .add('push-event', {
          type: 'push-event',
          userId: event.user_id,
          eventId: event.id,
          action: 'update',
        })
        .catch((err) => {
          logger.error({ err, eventId: event.id }, 'Failed to enqueue organizer GCal push');
        });
    }

    if (source === 'google_sync' && hasTimeChange(sharedChanges)) {
      this.deps.materializer.deleteForEvent(event.id);
      this.deps.materializer.materialize(
        {
          id: event.id,
          start_at: event.start_at,
          reminder_overrides: event.reminder_overrides ?? null,
          all_day: event.all_day,
          user_timezone: event.timezone,
        },
        event.user_id,
      );
    }
  }

  async onEventDeleted(params: { event: CalendarEvent; source: ChangeSource }): Promise<void> {
    const { event, source } = params;
    if (event.owner_type !== 'user') return;

    const participants = this.deps.participantRepo.getByEvent(event.id);
    const active = participants.filter((p) => p.status !== 'declined' && p.user_id !== event.user_id);
    // Read before the first await: the event delete removes these rows in the same tick,
    // and the queued delete job must still know which Google copy to remove.
    const copies = new Map(
      active.map((p) => [p.user_id, this.deps.participantSyncRepo.getByUserAndEvent(p.user_id, event.id)]),
    );
    // Read before the first await: EventService.deleteEvent does not await this method and cancels the
    // invitations right after it returns, so later reads would no longer see which ones were open.
    const openCards = this.deps.invitationRepo
      .getByEvent(event.id)
      .flatMap(({ id, invitee_id, inviter_id, status, chat_id, message_id }) =>
        chat_id != null && message_id != null && (status === 'pending' || status === 'maybe' || status === 'accepted')
          ? // A group card (negative invitee_id: the chat) was written in the inviter's language.
            [{ id, langUserId: invitee_id < 0 ? inviter_id : invitee_id, chatId: chat_id, messageId: message_id }]
          : [],
      );

    await this.expirePendingProposals(event);

    // Editing without a keyboard removes the RSVP buttons, which could no longer be answered.
    for (const card of openCards) {
      const lang = this.deps.getUserLang(card.langUserId);
      await this.deps
        .editMessage(card.chatId, card.messageId, t(lang).sync.eventCancelled(event.title))
        .catch((err) => {
          logger.error({ err, invitationId: card.id, eventId: event.id }, 'Failed to edit invitation card on delete');
        });
    }

    for (const p of active) {
      const lang = this.deps.getUserLang(p.user_id);
      await this.deps.notifyUser(p.user_id, t(lang).sync.eventCancelled(event.title)).catch((err) => {
        logger.error({ err, userId: p.user_id, eventId: event.id }, 'Failed to notify participant about event delete');
      });

      const copy = copies.get(p.user_id);
      await this.deps.syncQueue
        .add('push-participant-event', {
          type: 'push-participant-event',
          userId: p.user_id,
          eventId: event.id,
          action: 'delete',
          ...(copy?.google_event_id
            ? { googleEventId: copy.google_event_id, calendarId: copy.google_calendar_id }
            : {}),
        })
        .catch((err) => {
          logger.error({ err, userId: p.user_id, eventId: event.id }, 'Failed to enqueue participant GCal delete');
        });
    }

    if (source === 'bot') {
      await this.deps.syncQueue
        .add('push-event', {
          type: 'push-event',
          userId: event.user_id,
          eventId: event.id,
          action: 'delete',
        })
        .catch((err) => {
          logger.error({ err, eventId: event.id }, 'Failed to enqueue organizer GCal delete');
        });
    }

    this.deps.participantSyncRepo.deleteByEvent(event.id);
  }

  private async expirePendingProposals(event: CalendarEvent): Promise<void> {
    const pendingProposals = this.deps.editProposalRepo.getPendingForEvent(event.id);
    for (const proposal of pendingProposals) {
      this.deps.editProposalRepo.updateStatus(proposal.id, 'expired');
      const lang = this.deps.getUserLang(proposal.proposer_id);
      await this.deps.notifyUser(proposal.proposer_id, t(lang).sync.proposalExpired(event.title)).catch((err) => {
        logger.error({ err, proposalId: proposal.id }, 'Failed to notify proposer about expiry');
      });
      if (proposal.organizer_chat_id && proposal.organizer_message_id) {
        const orgLang = this.deps.getUserLang(event.user_id);
        await this.deps
          .editMessage(
            proposal.organizer_chat_id,
            proposal.organizer_message_id,
            t(orgLang).sync.proposalExpiredOrganizer(event.title),
          )
          .catch((err) => {
            logger.error({ err, proposalId: proposal.id }, 'Failed to edit organizer message on expiry');
          });
      }
    }
  }
}
