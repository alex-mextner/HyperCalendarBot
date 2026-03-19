import type { EventRepository } from '../../database/repositories/event.repository';
import type { InvitationRepository } from '../../database/repositories/invitation.repository';
import type { ParticipantRepository } from '../../database/repositories/participant.repository';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository';
import type { CalendarEvent, Invitation, InvitationStatus } from '../../database/types';
import type { ConflictChecker } from '../event/conflict-checker';
import type { DomainEventBus } from '../scheduled/domain-event-bus.ts';

const MAX_DECLINES = 3;

export interface InvitationResult {
  success: boolean;
  invitation?: Invitation;
  error?: string;
  conflicts?: CalendarEvent[];
  proposedTime?: string;
}

export class InvitationService {
  constructor(
    private invRepo: InvitationRepository,
    private eventRepo: EventRepository,
    private settingsRepo: SharingSettingsRepository,
    private participantRepo?: ParticipantRepository,
    private conflictChecker?: ConflictChecker,
    private domainEvents?: DomainEventBus,
  ) {}

  sendInvitation(eventId: number, inviterId: number, inviteeId: number, inviteeUsername?: string): InvitationResult {
    if (inviterId === inviteeId) {
      return { success: false, error: 'Cannot invite yourself' };
    }

    const event = this.eventRepo.findById(eventId, inviterId);
    if (!event) {
      return { success: false, error: 'Event not found' };
    }

    const inviteeSettings = this.settingsRepo.get(inviteeId);
    if (inviteeSettings && !inviteeSettings.allow_invitations) {
      return { success: false, error: 'User has disabled invitations' };
    }

    const existing = this.invRepo.findActiveByEventAndInvitee(eventId, inviteeId);
    if (existing) {
      return { success: false, error: 'Invitation already sent' };
    }

    const declineCount = this.invRepo.countDeclined(eventId, inviteeId);
    if (declineCount >= MAX_DECLINES) {
      return { success: false, error: 'User has declined too many times' };
    }

    const invitation = this.invRepo.create({
      event_id: eventId,
      inviter_id: inviterId,
      invitee_id: inviteeId,
      invitee_username: inviteeUsername,
    });

    return { success: true, invitation };
  }

  acceptInvitation(invitationId: number, userId: number): InvitationResult {
    return this.respondToInvitation(invitationId, userId, 'accepted');
  }

  declineInvitation(invitationId: number, userId: number): InvitationResult {
    return this.respondToInvitation(invitationId, userId, 'declined');
  }

  maybeInvitation(invitationId: number, userId: number): InvitationResult {
    return this.respondToInvitation(invitationId, userId, 'maybe');
  }

  cancelInvitation(invitationId: number, userId: number): InvitationResult {
    const invitation = this.invRepo.findById(invitationId);
    if (!invitation) {
      return { success: false, error: 'Invitation not found' };
    }
    if (invitation.inviter_id !== userId) {
      return { success: false, error: 'Not authorized to cancel' };
    }
    const ok = this.invRepo.updateStatus(invitationId, 'cancelled', invitation.status as InvitationStatus);
    if (!ok) {
      return { success: false, error: 'Cannot cancel — status already changed' };
    }
    return { success: true, invitation: this.invRepo.findById(invitationId)! };
  }

  proposeTime(invitationId: number, userId: number, proposedTime: string): InvitationResult {
    const invitation = this.invRepo.findById(invitationId);
    if (!invitation) {
      return { success: false, error: 'Invitation not found' };
    }
    if (invitation.invitee_id !== userId) {
      return { success: false, error: 'Not authorized to propose' };
    }
    this.invRepo.setProposedTime(invitationId, proposedTime);
    return { success: true, invitation: this.invRepo.findById(invitationId)! };
  }

  rescheduleFromProposal(invitationId: number, userId: number): InvitationResult {
    const invitation = this.invRepo.findById(invitationId);
    if (!invitation) {
      return { success: false, error: 'Invitation not found' };
    }
    if (invitation.inviter_id !== userId) {
      return { success: false, error: 'Not authorized to reschedule' };
    }
    if (!invitation.proposed_time) {
      return { success: false, error: 'No proposed time on this invitation' };
    }
    const proposedTime = invitation.proposed_time;
    const ok = this.invRepo.clearProposedTimeAndAccept(invitationId, invitation.status);
    if (!ok) {
      return { success: false, error: 'Cannot update status — already changed' };
    }
    if (this.participantRepo) {
      const existing = this.participantRepo.findByEventAndUser(invitation.event_id, invitation.invitee_id);
      if (existing) {
        this.participantRepo.updateStatus(invitation.event_id, invitation.invitee_id, 'accepted');
      } else {
        this.participantRepo.add(invitation.event_id, invitation.invitee_id, 'accepted');
      }
    }
    return { success: true, invitation: this.invRepo.findById(invitationId)!, proposedTime };
  }

  keepOriginalTime(invitationId: number, userId: number): InvitationResult {
    const invitation = this.invRepo.findById(invitationId);
    if (!invitation) {
      return { success: false, error: 'Invitation not found' };
    }
    if (invitation.inviter_id !== userId) {
      return { success: false, error: 'Not authorized' };
    }
    this.invRepo.clearProposedTime(invitationId);
    return { success: true, invitation: this.invRepo.findById(invitationId)! };
  }

  private respondToInvitation(invitationId: number, userId: number, newStatus: InvitationStatus): InvitationResult {
    const invitation = this.invRepo.findById(invitationId);
    if (!invitation) {
      return { success: false, error: 'Invitation not found' };
    }
    if (invitation.invitee_id !== userId) {
      return { success: false, error: 'Not authorized to respond' };
    }
    const ok = this.invRepo.updateStatus(invitationId, newStatus, invitation.status as InvitationStatus);
    if (!ok) {
      return { success: false, error: 'Cannot update — status already changed' };
    }

    if (this.participantRepo) {
      const existing = this.participantRepo.findByEventAndUser(invitation.event_id, userId);
      if (newStatus === 'accepted' || newStatus === 'maybe') {
        if (existing) {
          this.participantRepo.updateStatus(invitation.event_id, userId, newStatus);
        } else {
          this.participantRepo.add(invitation.event_id, userId, newStatus);
        }
      } else if (newStatus === 'declined' && existing) {
        this.participantRepo.updateStatus(invitation.event_id, userId, 'declined');
      }
    }

    const result: InvitationResult = { success: true, invitation: this.invRepo.findById(invitationId)! };

    if (newStatus === 'accepted' && this.conflictChecker) {
      const event = this.eventRepo.findById(invitation.event_id, invitation.inviter_id);
      if (event) {
        const conflicts = this.conflictChecker.checkConflicts(event, userId);
        if (conflicts.length > 0) {
          result.conflicts = conflicts;
        }
      }
    }

    if (this.domainEvents && (newStatus === 'accepted' || newStatus === 'declined')) {
      const event = this.eventRepo.findById(invitation.event_id, invitation.inviter_id);
      if (event) {
        if (newStatus === 'accepted') {
          this.domainEvents.emit('myInvitations.accepted', {
            userId: invitation.inviter_id,
            inviteeId: invitation.invitee_id,
            event,
          });
        } else {
          this.domainEvents.emit('myInvitations.rejected', {
            userId: invitation.inviter_id,
            inviteeId: invitation.invitee_id,
            event,
          });
        }
      }
    }

    return result;
  }
}
