// Roster building blocks for get_invitation_status: who is invited, who answered what, and who may
// read the roster. Kept apart from the handler so each rule (dedup, status priority, group-answer
// visibility, reader authorization) is one named step with explicit inputs and outputs.
import { type Lang, t } from '../../../config/constants.ts';
import type {
  CalendarEvent,
  Contact,
  EventParticipant,
  Invitation,
  InvitationStatus,
  ParticipantStatus,
} from '../../../database/types.ts';
import { botLogger } from '../../../utils/logger.ts';
import { effectiveRsvpStatus } from '../../sharing/invitation-roster.ts';
import type { AgentContext, SharingCapability, ToolResult } from '../types.ts';

export function isRsvpAttending(status: ParticipantStatus | InvitationStatus): boolean {
  return status === 'accepted';
}

/** An invitation that still counts: not declined, cancelled or expired. */
export function isLiveInvitation(status: InvitationStatus): boolean {
  return status === 'pending' || status === 'accepted' || status === 'maybe';
}

interface PersonalRsvpResult {
  lines: string[];
  listedUserIds: Set<number>;
  attending: number;
}

/** Plain labels cannot introduce new roster lines or split a Unicode code point. */
export function rosterLabel(value: string | null | undefined, limit = 120): string | undefined {
  const cleaned = value
    ?.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned ? [...cleaned].slice(0, limit).join('') : undefined;
}

/** Resolve only an authorized roster; never read private contact aliases for a group reply. */
export function rosterDisplayName(ctx: AgentContext, ids: number[]): (userId: number) => string {
  const profiles = ctx.userRepo.findManyByTelegramIds(ids);
  const allowed = new Set(ids);
  const contacts = new Map<number, Contact>();
  if (!ctx.isGroup && ctx.contactRepo) {
    for (const contact of ctx.contactRepo.list(ctx.user.telegram_id)) {
      if (contact.telegram_id !== null && allowed.has(contact.telegram_id) && !contacts.has(contact.telegram_id))
        contacts.set(contact.telegram_id, contact);
    }
  }
  return (userId) => {
    if (!ctx.isGroup && userId === ctx.user.telegram_id) return t(ctx.user.language).aiTools.sharing.rsvpSelf;
    const contact = contacts.get(userId);
    const profile = profiles.get(userId);
    // Tool text stays plain; the v2 delivery boundary escapes it exactly once.
    return (
      rosterLabel(contact?.preferred_name) ??
      rosterLabel(contact?.name) ??
      rosterLabel(profile?.first_name) ??
      rosterLabel(profile?.username ? `@${profile.username}` : undefined) ??
      String(userId)
    );
  };
}

/**
 * One line per personally-invited user. Status priority:
 * 1. Positive participant RSVP (accepted/maybe) is always authoritative — it reflects a confirmed
 *    response from any channel (personal or group) and must not be masked by a pending invite.
 * 2. A pending invitation takes priority over stale negative/neutral participant rows (declined,
 *    pending), treating them as superseded by a fresh re-invite.
 * 3. Otherwise the event_participants row is authoritative, falling back to the invitation status.
 * When participant and invitation statuses conflict, the invite is shown as a note on the same
 * line. A dead personal invite (declined/cancelled/expired) with no participant row is skipped.
 */
export function buildPersonalRsvpLines(
  lang: Lang,
  personalInvByUser: Map<number, Invitation>,
  participantByUser: Map<number, ParticipantStatus>,
  displayName: (userId: number) => string,
): PersonalRsvpResult {
  const lines: string[] = [];
  const listedUserIds = new Set<number>();
  let attending = 0;
  for (const [userId, inv] of personalInvByUser) {
    const participantStatus = participantByUser.get(userId);
    const inviteIsLive = isLiveInvitation(inv.status);
    if (participantStatus === undefined && !inviteIsLive) continue;
    const status = effectiveRsvpStatus(inv.status, participantStatus);
    const note =
      participantStatus !== undefined && participantStatus !== inv.status && inv.status !== 'pending'
        ? t(lang).aiTools.sharing.rsvpPersonalInviteNote(t(lang).aiTools.sharing.rsvpStatuses[inv.status])
        : '';
    lines.push(
      t(lang).aiTools.sharing.rsvpInviteeLine(displayName(userId), t(lang).aiTools.sharing.rsvpStatuses[status], note),
    );
    listedUserIds.add(userId);
    if (isRsvpAttending(status)) attending++;
  }
  return { lines, listedUserIds, attending };
}

interface GroupRsvpResult {
  lines: string[];
  members: EventParticipant[];
}

/**
 * Per-member RSVP breakdown for an event with a group invitation. The shared group invitation row
 * stays "pending" forever, so the real responses live in event_participants. Members already shown
 * in the personal-invite section (listedUserIds) are excluded so each (event, user) appears exactly
 * once across the whole output. `participantRows` is null when the participant registry is
 * unavailable (degraded), versus [] when present but empty. The caller passes only the answers the
 * reader may see (by the group chat each came through); they are reported as one breakdown.
 */
function describeGroupRsvp(
  lang: Lang,
  participantRows: EventParticipant[] | null,
  listedUserIds: Set<number>,
  displayName: (userId: number) => string,
): GroupRsvpResult {
  if (participantRows === null) {
    return { lines: [t(lang).aiTools.sharing.groupRsvpUnavailable], members: [] };
  }
  const members = participantRows.filter((p) => !listedUserIds.has(p.user_id));
  if (members.length === 0) {
    // Only show "no RSVPs yet" when there are genuinely none. If all responders appear in
    // the personal-invite section above (deduped), the group breakdown adds nothing.
    if (participantRows.length === 0) {
      return { lines: [t(lang).aiTools.sharing.groupRsvpNone], members: [] };
    }
    return { lines: [], members: [] };
  }
  return {
    lines: [
      t(lang).aiTools.sharing.groupRsvpHeader,
      ...members.map((p) =>
        t(lang).aiTools.sharing.rsvpMemberLine(displayName(p.user_id), t(lang).aiTools.sharing.rsvpStatuses[p.status]),
      ),
    ],
    members,
  };
}

interface InvitationRows {
  /** One authoritative invitation row per personally-invited user. */
  personalInvByUser: Map<number, Invitation>;
  /** Group chat ids (negative invitee ids) whose invitation is still live. */
  liveGroupChatIds: number[];
}

/**
 * A group invitation stores the (negative) group chat id as invitee_id and never leaves "pending";
 * members RSVP per-member into event_participants. Split the rows so the roster can dedup every
 * user across both sections.
 */
export function collectInvitationRows(invitations: Invitation[]): InvitationRows {
  const personalInvByUser = new Map<number, Invitation>();
  const liveGroupChatIds: number[] = [];
  for (const inv of invitations) {
    if (inv.invitee_id >= 0) {
      personalInvByUser.set(inv.invitee_id, inv);
    } else if (isLiveInvitation(inv.status)) {
      liveGroupChatIds.push(inv.invitee_id);
    }
  }
  return { personalInvByUser, liveGroupChatIds };
}

export function participantStatusByUser(participantRows: EventParticipant[] | null): Map<number, ParticipantStatus> {
  const byUser = new Map<number, ParticipantStatus>();
  for (const p of participantRows ?? []) byUser.set(p.user_id, p.status);
  return byUser;
}

type RosterEventLookup = { event: CalendarEvent; organizerId: number | null } | { denied: ToolResult };

/**
 * The event the reader may see: their own, or — as an invitee — the owner's. A group invitation
 * invites every current member, whether or not they answered yet.
 */
export function resolveRosterEvent(
  ctx: AgentContext,
  invitationRepo: SharingCapability['invitationRepo'],
  eventId: number,
  requesterId: number,
  liveGroupChatIds: number[],
): RosterEventLookup {
  const own = ctx.eventService.getEvent(eventId, requesterId);
  if (own) return { event: own, organizerId: null };

  const ownerId = ctx.eventService.getEventOwnerId(eventId);
  // Same rule as propose_edit: the latest personal invitation, unless cancelled or expired.
  const hasPersonalInvitation = invitationRepo.findActiveOrRespondedByEventAndInvitee(eventId, requesterId) !== null;
  const isInvitedGroupMember = liveGroupChatIds.some(
    (chatId) => ctx.group?.groupMemberRepo.getMembership(chatId, requesterId)?.left_at === null,
  );
  const notFound: RosterEventLookup = {
    denied: { success: false, error: `Event ${eventId} not found or you are not invited to it.` },
  };
  if (ownerId === null || !(hasPersonalInvitation || isInvitedGroupMember)) return notFound;

  // The roster is the owner's to share: never post it into a group chat the owner did not invite.
  // Say why, so the model sends the invitee to a private chat instead of calling them uninvited.
  const isAllowedChat = !ctx.isGroup || (ctx.groupChatId !== undefined && liveGroupChatIds.includes(ctx.groupChatId));
  if (!isAllowedChat) {
    return {
      denied: {
        success: false,
        error: `Event ${eventId}: its roster can only be read in a private chat or in a group invited to it.`,
      },
    };
  }
  const ownerEvent = ctx.eventService.getEvent(eventId, ownerId);
  return ownerEvent ? { event: ownerEvent, organizerId: ownerId } : notFound;
}

/**
 * A member's answer counts while the group whose card carried it is still invited; in a group chat
 * only that chat's own answers are shown. Like the invitation card, an invitee never sees an answer
 * of unknown origin; only a reader who sees the event itself does, and only outside group chats.
 */
function isGroupAnswerVisible(
  ctx: AgentContext,
  participant: EventParticipant,
  liveGroupChatIds: number[],
  readerSeesEvent: boolean,
): boolean {
  if (participant.source_group_id === null) return !ctx.isGroup && readerSeesEvent;
  return (
    liveGroupChatIds.includes(participant.source_group_id) &&
    (!ctx.isGroup || participant.source_group_id === ctx.groupChatId)
  );
}

interface GroupRosterSection {
  lines: string[];
  memberIds: number[];
  attending: number;
  /** Group RSVPs are invisible (no participant registry): the attending count would be too low. */
  degraded: boolean;
}

export function buildGroupRosterSection(
  ctx: AgentContext,
  lang: Lang,
  eventId: number,
  participantRows: EventParticipant[] | null,
  liveGroupChatIds: number[],
  readerSeesEvent: boolean,
  listedUserIds: Set<number>,
  displayName: (userId: number) => string,
): GroupRosterSection {
  const degraded = participantRows === null;
  if (degraded) {
    botLogger.warn({ eventId }, 'group rsvp: participant repo absent, attending count suppressed');
  }
  const groupRows =
    participantRows?.filter((p) => isGroupAnswerVisible(ctx, p, liveGroupChatIds, readerSeesEvent)) ?? null;
  const group = describeGroupRsvp(lang, groupRows, listedUserIds, displayName);
  return {
    lines: group.lines,
    memberIds: group.members.map((member) => member.user_id),
    attending: group.members.filter((member) => isRsvpAttending(member.status)).length,
    degraded,
  };
}
