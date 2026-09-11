import type { EventRepository } from '../../database/repositories/event.repository';
import type { GroupMemberRepository } from '../../database/repositories/group-member.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository';
import type { ParticipantRepository } from '../../database/repositories/participant.repository';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository';
import type { Invitation, InvitationStatus } from '../../database/types';
import type { DomainEventBus } from '../scheduled/domain-event-bus.ts';

const MAX_DECLINES = 3;

export interface InvitationResult {
  success: boolean;
  invitation?: Invitation;
  error?: string;
  proposedTime?: string;
}

export class InvitationService {
  constructor(
    private invRepo: InvitationRepository,
    private eventRepo: EventRepository,
    private settingsRepo: SharingSettingsRepository,
    private participantRepo?: ParticipantRepository,
    private domainEvents?: DomainEventBus,
    private groupMemberRepo?: GroupMemberRepository,
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

  /**
   * Record one group member's RSVP directly against the event. A group invite stores the group
   * chat id as the invitation `invitee_id`, so no single member can ever satisfy the
   * `invitee_id === userId` check in `respondToInvitation`. Authorization is instead bound to the
   * group: `groupChatId` is the chat Telegram reported for the message that carried the RSVP
   * button — callback_data is forgeable, the chat id is not. An active invitation must link the
   * event to that group; without one we write nothing, so a forged or substituted event id can
   * never insert the caller into an arbitrary owner's event. `event_participants` is per-user
   * (`UNIQUE(event_id, user_id)`), so each member gets their own row and members never collide on
   * a shared invitation status.
   *
   * The invitation binding alone does not prove the tapping user is still in the group — Telegram
   * can deliver a stale callback for a message from before the user left. We additionally require
   * `groupMemberRepo` to report an active membership row (`group_members`, `left_at IS NULL`) for
   * (groupChatId, userId) before writing anything. This uses the locally-cached membership table
   * (already the source of truth for the group fanout in `handleUpdateEvent`) instead of a live
   * `getChatMember` call: it is synchronous, avoids a Telegram API round-trip on every RSVP tap,
   * and needs no extra bot permission. The tradeoff is staleness bounded by how promptly
   * join/leave events update `group_members` — acceptable here since the existing invitation-
   * binding check already blocks the higher-value IDOR case (a forged event id from another
   * group). `groupMemberRepo` is optional for backward-compatible construction, but its absence
   * fails closed: no membership repo means the check cannot be proven, so the RSVP is denied.
   */
  recordGroupAttendance(
    eventId: number,
    userId: number,
    status: 'accepted' | 'declined',
    groupChatId: number,
  ): InvitationResult {
    if (!this.participantRepo) {
      return { success: false, error: 'Participant registry not available' };
    }
    const groupInvitation = this.invRepo.findActiveByEventAndInvitee(eventId, groupChatId);
    if (!groupInvitation) {
      return { success: false, error: 'No active group invitation links this event to this chat' };
    }
    if (!this.groupMemberRepo?.isActiveMember(groupChatId, userId)) {
      return { success: false, error: 'User is not an active member of this group' };
    }
    const existing = this.participantRepo.findByEventAndUser(eventId, userId);
    if (existing) {
      this.participantRepo.updateStatus(eventId, userId, status);
    } else {
      this.participantRepo.add(eventId, userId, status);
    }
    // Mirror this member's own answer into their own Google Calendar (gated downstream on their
    // own active sync state): "going" adds the event, "not going" removes it.
    this.domainEvents?.emit('myGroup.rsvp', { userId, eventId, status });
    return { success: true };
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
