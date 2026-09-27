// Who an invitation card lists (the organizer and every invitee with their current answer) and in
// which chats that list may be shown.
import type { InvitationRepository, InvitationRosterRow } from '../../database/repositories/invitation.repository.ts';
import type { InvitationStatus, ParticipantStatus } from '../../database/types.ts';
import { botLogger } from '../../utils/logger.ts';

const logger = botLogger.child({ module: 'invitation-roster' });

/** Longest name a card shows, ellipsis included: Telegram first names alone go up to 64 characters. */
const NAME_MAX_LENGTH = 40;

/** Display order on the card: who is coming first. */
const ANSWER_RANK: Record<ParticipantStatus, number> = { accepted: 0, maybe: 1, pending: 2, declined: 3 };

export interface RosterPerson {
  userId: number;
  /** Plain text, not yet HTML-escaped; null when nothing names the person */
  name: string | null;
}

export interface RosterInvitee extends RosterPerson {
  answer: ParticipantStatus;
}

export interface InvitationRoster {
  organizer: RosterPerson;
  /** In display order: going, maybe, no answer yet, not going; invitation order within each */
  invitees: RosterInvitee[];
  /** The private-chat reader, marked on their own line; null in a group chat */
  readerId: number | null;
}

/**
 * One person's answer when their invitation and their event_participants row disagree. A "going" or
 * "maybe" given through any channel (personal or group card) is authoritative; otherwise a pending
 * invitation is a fresh re-invite and wins over a stale "declined" or "pending" row; otherwise the
 * participant row, falling back to the invitation.
 */
export function effectiveRsvpStatus(
  invitation: InvitationStatus,
  participant: ParticipantStatus | undefined,
): InvitationStatus {
  return invitation === 'pending' && participant !== 'accepted' && participant !== 'maybe'
    ? invitation
    : (participant ?? invitation);
}

function answerOf(status: InvitationStatus | null): ParticipantStatus | null {
  switch (status) {
    case 'pending':
    case 'accepted':
    case 'maybe':
    case 'declined':
      return status;
    default:
      return null;
  }
}

/** A name safe to show in a line of its own: no control or bidi characters, bounded length. */
function plainName(value: string | null): string | null {
  const cleaned = value
    ?.replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const chars = [...cleaned];
  return chars.length > NAME_MAX_LENGTH ? `${chars.slice(0, NAME_MAX_LENGTH - 1).join('')}…` : cleaned;
}

/** The person's public Telegram name first; the organizer's own contact name only when nothing public exists. */
function displayName(row: InvitationRosterRow): string | null {
  const username = plainName(row.username?.replace(/^@/, '') ?? null);
  return plainName(row.first_name) ?? (username ? `@${username}` : null) ?? plainName(row.contact_name);
}

function buildRoster(rows: InvitationRosterRow[], chatId: number): InvitationRoster | null {
  const organizerRow = rows.find((row) => row.source === 'organizer');
  if (!organizerRow) return null;

  const participantAnswers = new Map<number, ParticipantStatus>();
  const liveGroupChats = new Set<number>();
  const invitees: RosterInvitee[] = [];
  const listed = new Set<number>([organizerRow.user_id]);
  for (const row of rows) {
    const answer = answerOf(row.status);
    if (row.source === 'participant' && answer) participantAnswers.set(row.user_id, answer);
    if (row.source === 'invitation' && row.user_id < 0 && answer && answer !== 'declined') {
      liveGroupChats.add(row.user_id);
    }
  }

  // Personal invitees: the latest invitation per person, unless withdrawn or expired.
  for (const row of rows) {
    const invitation = answerOf(row.status);
    if (row.source !== 'invitation' || row.user_id < 0 || !invitation || listed.has(row.user_id)) continue;
    const answer = answerOf(effectiveRsvpStatus(invitation, participantAnswers.get(row.user_id)));
    if (!answer) continue;
    invitees.push({ userId: row.user_id, name: displayName(row), answer });
    listed.add(row.user_id);
  }

  // Group members answer through event_participants; list them while a group invitation is live.
  if (liveGroupChats.size > 0) {
    for (const row of rows) {
      const answer = answerOf(row.status);
      if (row.source !== 'participant' || listed.has(row.user_id) || !answer) continue;
      invitees.push({ userId: row.user_id, name: displayName(row), answer });
      listed.add(row.user_id);
    }
  }

  // The roster is the organizer's to share: a group chat must hold a live invitation to the event, and
  // a private reader must be on the roster (fail closed for anyone else).
  const isAllowedChat = chatId < 0 ? liveGroupChats.has(chatId) : listed.has(chatId);
  if (!isAllowedChat) return null;

  invitees.sort((a, b) => ANSWER_RANK[a.answer] - ANSWER_RANK[b.answer]);
  return {
    organizer: { userId: organizerRow.user_id, name: displayName(organizerRow) },
    invitees,
    readerId: chatId > 0 ? chatId : null,
  };
}

/**
 * The roster an invitation card shown in `chatId` may carry, or null when that chat may not see it.
 * The roster only adds context to a card, so a failed read degrades to a card without it rather than
 * blocking the delivery or update of the invitation itself.
 */
export function readInvitationRoster(
  invitationRepo: Pick<InvitationRepository, 'getRoster'>,
  eventId: number,
  chatId: number,
): InvitationRoster | null {
  try {
    return buildRoster(invitationRepo.getRoster(eventId), chatId);
  } catch (err) {
    logger.warn({ err, eventId }, 'Invitation roster unavailable; showing the card without it');
    return null;
  }
}
