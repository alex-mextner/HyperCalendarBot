import { type Lang, t } from '../../../config/constants.ts';
import type {
  EventParticipant,
  Invitation,
  InvitationStatus,
  ParticipantStatus,
  Visibility,
} from '../../../database/types.ts';
import { botLogger } from '../../../utils/logger.ts';
import { deliverInvitation, lookupInviteeUsername } from '../invitation-delivery.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';
import { handlePickUsers } from './meta.ts';
import { checkSecretaryAccess } from './secretary-access.ts';

const deliveryLogger = botLogger.child({ module: 'invitation-delivery' });

interface ShareEventInput {
  event_id: number;
  target_type: 'user' | 'group';
  target_id: number;
}

interface SendInvitationInput {
  event_id: number;
  invitee_id?: number;
  invitee_username?: string;
}

interface GetInvitationStatusInput {
  event_id: number;
}

interface ShareAgendaInput {
  period: 'today' | 'tomorrow' | 'week';
  target_type: 'user' | 'group';
  target_id: number;
}

interface SetEventVisibilityInput {
  event_id: number;
  visibility: Visibility;
  owner_id?: number;
}

export function handleShareEvent(ctx: AgentContext, input: ShareEventInput): ToolResult {
  if (!ctx.sharing?.sharedEventRepo) {
    return { success: false, error: 'Sharing is not configured.' };
  }

  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const shared = ctx.sharing.sharedEventRepo.create({
    event_id: input.event_id,
    shared_by: ctx.user.telegram_id,
    shared_to_type: input.target_type,
    shared_to_id: input.target_id,
    share_type: 'card',
  });

  return {
    success: true,
    output: t(ctx.user.language).aiTools.sharing.eventShared(
      event.title,
      shared.id,
      input.target_type,
      input.target_id,
    ),
  };
}

export async function handleSendInvitation(ctx: AgentContext, input: SendInvitationInput): Promise<ToolResult> {
  if (!ctx.sharing?.invitationService) {
    return { success: false, error: 'Invitations are not configured.' };
  }

  let inviteeId = input.invitee_id;
  let inviteeUsername = input.invitee_username;
  let resolvedFirstName: string | undefined;

  // Resolve invitee_id when only username provided
  if (!inviteeId && inviteeUsername) {
    if (!ctx.resolveUsername) {
      return { success: false, error: 'Cannot resolve @username: username resolution is not available.' };
    }
    try {
      const resolved = await ctx.resolveUsername(inviteeUsername);
      if (!resolved) {
        // Username not found — open user picker automatically
        const prompt = t(ctx.user.language).invite_resolve_not_found(inviteeUsername);
        return handlePickUsers(ctx, { event_id: input.event_id, prompt });
      }
      inviteeId = resolved.id;
      resolvedFirstName = resolved.firstName;
      if (resolved.username) inviteeUsername = resolved.username;
    } catch (err) {
      deliveryLogger.error({ err, username: inviteeUsername }, 'Failed to resolve username');
      return {
        success: false,
        error: `Failed to resolve @${inviteeUsername}. Try using find_user or pick_users instead.`,
      };
    }
  }

  if (!inviteeId) {
    return { success: false, error: 'Either invitee_id or invitee_username must be provided.' };
  }

  const result = ctx.sharing.invitationService.sendInvitation(
    input.event_id,
    ctx.user.telegram_id,
    inviteeId,
    inviteeUsername,
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  const invitation = result.invitation!;

  // Auto-add invitee to inviter's contacts
  if (ctx.contactRepo) {
    const invitee = ctx.userRepo.findByTelegramId(inviteeId);
    const contactName =
      invitee?.first_name ?? invitee?.username ?? resolvedFirstName ?? inviteeUsername ?? `User ${inviteeId}`;
    ctx.contactRepo.upsert(
      ctx.user.telegram_id,
      contactName,
      inviteeUsername ?? invitee?.username ?? undefined,
      inviteeId,
    );
  }

  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  let delivery: { delivered: boolean; viaDeepLink: boolean } = { delivered: false, viaDeepLink: false };
  if (ctx.sender) {
    delivery = await deliverInvitation({
      invitationId: invitation.id,
      eventId: input.event_id,
      inviteeId,
      inviteeUsername:
        inviteeUsername ??
        lookupInviteeUsername(
          { userRepo: ctx.userRepo, contactRepo: ctx.contactRepo },
          ctx.user.telegram_id,
          inviteeId,
        ),
      inviterId: ctx.user.telegram_id,
      inviterName: ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`,
      inviterUsername: ctx.user.username ?? undefined,
      inviterTimezone: ctx.user.timezone,
      event,
      lang: (ctx.user.language ?? 'en') as 'en' | 'ru',
      inviterLang: (ctx.user.language ?? 'en') as 'en' | 'ru',
      // The deep-link fallback is a PRIVATE invite link — it must reach the inviter's
      // private chat, never ctx.chatId (which may be a group the bot was invoked from,
      // leaking the invitee's personal invitation to every member).
      fallbackChatId: ctx.user.telegram_id,
      deps: {
        sender: ctx.sender,
        invitationRepo: ctx.sharing.invitationRepo,
        userRepo: ctx.userRepo,
        deepLinkService: ctx.deepLinkService,
        botUsername: ctx.botUsername,
        contactRepo: ctx.contactRepo,
      },
    });
  }

  return {
    success: true,
    output: t(ctx.user.language).aiTools.sharing.invitationCreated(invitation.id, input.event_id, inviteeId),
    agentHint: delivery.delivered
      ? 'The invitation was delivered to the invitee via bot API or MTProto. Tell the user it is sent.'
      : delivery.viaDeepLink
        ? 'Bot-API delivery failed. A deep-link fallback was sent to the inviter to forward manually. Tell the user to share the link.'
        : 'Invitation delivery failed entirely. Tell the user there was a delivery problem.',
  };
}

export function handleCancelInvitation(ctx: AgentContext, input: { invitation_id: number }): ToolResult {
  if (!ctx.sharing?.invitationService) {
    return { success: false, error: 'Invitations are not configured.' };
  }
  const result = ctx.sharing.invitationService.cancelInvitation(input.invitation_id, ctx.user.telegram_id);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return {
    success: true,
    output: t(ctx.user.language).aiTools.sharing.invitationCancelled(input.invitation_id),
  };
}

export async function handleResendInvitation(
  ctx: AgentContext,
  input: { invitation_id: number; invitee_username?: string },
): Promise<ToolResult> {
  if (!ctx.sharing) {
    return { success: false, error: 'Invitations are not configured.' };
  }
  const invitation = ctx.sharing.invitationRepo.findById(input.invitation_id);
  if (!invitation) {
    return { success: false, error: 'Invitation not found.' };
  }
  if (invitation.inviter_id !== ctx.user.telegram_id) {
    return { success: false, error: 'Not your invitation.' };
  }
  if (invitation.status !== 'pending') {
    return { success: false, error: `Cannot resend — status is "${invitation.status}".` };
  }

  // Guard on the sender object (mirrors handleSendInvitation); deliverInvitation itself
  // reports non-delivery when the sender lacks the sendInvitation capability.
  if (ctx.sender) {
    const event = ctx.eventService.getEvent(invitation.event_id, ctx.user.telegram_id);
    // A group invitation stores the (negative) group chat id as invitee_id. Resending it must use
    // the group delivery mode (per-member RSVP keyboard, no MTProto, no deep-link forward) — exactly
    // what the chat_shared picker does. Without this it would deliver the personal inv: keyboard
    // (authorizes a single invitee, unusable in a group).
    const isGroupTarget = invitation.invitee_id < 0;
    const delivery = await deliverInvitation({
      invitationId: invitation.id,
      eventId: invitation.event_id,
      inviteeId: invitation.invitee_id,
      inviteeUsername:
        input.invitee_username ??
        invitation.invitee_username ??
        lookupInviteeUsername(
          { userRepo: ctx.userRepo, contactRepo: ctx.contactRepo },
          ctx.user.telegram_id,
          invitation.invitee_id,
        ),
      inviterId: ctx.user.telegram_id,
      inviterName: ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`,
      inviterUsername: ctx.user.username ?? undefined,
      inviterTimezone: ctx.user.timezone,
      event,
      lang: (ctx.user.language ?? 'en') as 'en' | 'ru',
      inviterLang: (ctx.user.language ?? 'en') as 'en' | 'ru',
      // The deep-link fallback is a PRIVATE invite link — it must reach the inviter's
      // private chat, never ctx.chatId (which may be a group the bot was invoked from,
      // leaking the invitee's personal invitation to every member).
      fallbackChatId: ctx.user.telegram_id,
      allowMtproto: !isGroupTarget,
      isGroupTarget,
      deps: {
        sender: ctx.sender,
        invitationRepo: ctx.sharing.invitationRepo,
        userRepo: ctx.userRepo,
        deepLinkService: ctx.deepLinkService,
        botUsername: ctx.botUsername,
        contactRepo: ctx.contactRepo,
      },
    });
    return {
      success: true,
      output: t(ctx.user.language).aiTools.sharing.invitationReminderQueued(invitation.invitee_id),
      agentHint: delivery.delivered
        ? 'The invitation reminder was delivered to the invitee. Tell the user it is sent.'
        : delivery.viaDeepLink
          ? 'Bot-API reminder failed. Deep-link fallback sent to the inviter.'
          : 'Reminder delivery failed entirely. Tell the user there was a delivery problem.',
    };
  }

  return { success: false, error: 'Message delivery not available.' };
}

function isRsvpAttending(status: ParticipantStatus | InvitationStatus): boolean {
  return status === 'accepted';
}

interface PersonalRsvpResult {
  lines: string[];
  listedUserIds: Set<number>;
  attending: number;
}

/**
 * One line per personally-invited user. Status priority:
 * 1. If the invitation is currently 'pending' (fresh or re-invite), that status wins — a historical
 *    participant row from a prior RSVP cycle must not override an active invitation.
 * 2. Otherwise, the event_participants row is authoritative (synced to Google), falling back to the
 *    invitation status when no participant row exists yet.
 * When participant and invitation statuses conflict (e.g. declined personal invite but accepted via
 * group), the conflicting invite is shown as a note on the same line. A dead personal invite
 * (declined/cancelled/expired) with no participant row is skipped.
 */
function buildPersonalRsvpLines(
  lang: Lang,
  personalInvByUser: Map<number, Invitation>,
  participantByUser: Map<number, ParticipantStatus>,
): PersonalRsvpResult {
  const lines: string[] = [];
  const listedUserIds = new Set<number>();
  let attending = 0;
  for (const [userId, inv] of personalInvByUser) {
    const participantStatus = participantByUser.get(userId);
    const inviteIsLive = inv.status === 'pending' || inv.status === 'accepted' || inv.status === 'maybe';
    if (participantStatus === undefined && !inviteIsLive) continue;
    // A pending invitation is the current invite state; a historical participant row
    // (prior RSVP from a previous acceptance or group flow) must not override it.
    const status = inv.status === 'pending' ? inv.status : (participantStatus ?? inv.status);
    const note =
      participantStatus !== undefined && participantStatus !== inv.status && inv.status !== 'pending'
        ? t(lang).aiTools.sharing.rsvpPersonalInviteNote(inv.status)
        : '';
    lines.push(t(lang).aiTools.sharing.rsvpInviteeLine(userId, status, note));
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
 * unavailable (degraded), versus [] when present but empty. When an event is shared to more than one
 * group, event_participants does not record which group a member came from, so the breakdown is
 * reported once for the whole event rather than per group chat.
 */
function describeGroupRsvp(
  lang: Lang,
  participantRows: EventParticipant[] | null,
  listedUserIds: Set<number>,
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
      ...members.map((p) => t(lang).aiTools.sharing.rsvpMemberLine(p.user_id, p.status)),
    ],
    members,
  };
}

export function handleGetInvitationStatus(ctx: AgentContext, input: GetInvitationStatusInput): ToolResult {
  if (!ctx.sharing?.invitationRepo) {
    return { success: false, error: 'Invitations are not configured.' };
  }

  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const lang = ctx.user.language;

  // One authoritative row per (event, user). A group invitation stores the (negative) group chat id
  // as invitee_id and never leaves "pending"; members RSVP per-member into event_participants. Build
  // a per-user view from the personal invitation rows plus the participant rows (the source of truth
  // synced to Google), deduping so every user appears exactly once across both sections.
  const personalInvByUser = new Map<number, Invitation>();
  let hasGroupInvite = false;
  for (const inv of ctx.sharing.invitationRepo.getByEvent(input.event_id)) {
    if (inv.invitee_id < 0) {
      if (inv.status === 'pending' || inv.status === 'accepted' || inv.status === 'maybe') hasGroupInvite = true;
      continue;
    }
    personalInvByUser.set(inv.invitee_id, inv);
  }

  const participantRows = ctx.participantRepo ? ctx.participantRepo.getByEvent(input.event_id) : null;
  const participantByUser = new Map<number, ParticipantStatus>();
  if (participantRows) {
    for (const p of participantRows) participantByUser.set(p.user_id, p.status);
  }

  const personal = buildPersonalRsvpLines(lang, personalInvByUser, participantByUser);
  const lines = [...personal.lines];
  let attending = personal.attending;
  let listedCount = personal.listedUserIds.size;
  // Group invite with no participant registry means group RSVPs are invisible; the
  // attending count would be misleadingly low (personal invitees only).
  let isGroupDegraded = false;

  if (hasGroupInvite) {
    if (participantRows === null) {
      isGroupDegraded = true;
      botLogger.warn({ eventId: input.event_id }, 'group rsvp: participant repo absent, attending count suppressed');
    }
    const group = describeGroupRsvp(lang, participantRows, personal.listedUserIds);
    lines.push(...group.lines);
    for (const member of group.members) {
      if (isRsvpAttending(member.status)) attending++;
    }
    listedCount += group.members.length;
  }

  if (listedCount > 0 && !isGroupDegraded) {
    lines.unshift(t(lang).aiTools.sharing.rsvpAttending(attending));
  }

  if (lines.length === 0) {
    return { success: true, output: t(lang).aiTools.sharing.noInvitations(event.title) };
  }

  return {
    success: true,
    output: t(lang).aiTools.sharing.invitationsFor(event.title, event.id, lines.join('\n')),
  };
}
handleGetInvitationStatus.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export function handleShareAgenda(ctx: AgentContext, input: ShareAgendaInput): ToolResult {
  if (!ctx.sharing) {
    return { success: false, error: 'Sharing is not configured.' };
  }

  const now = new Date();
  const dates: Date[] = [];

  if (input.period === 'today') {
    dates.push(now);
  } else if (input.period === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    dates.push(tomorrow);
  } else {
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      dates.push(d);
    }
  }

  const allEvents = dates.flatMap((date) =>
    ctx.sharing!.sharingService.getAgendaForSharing(ctx.user.telegram_id, date, ctx.user.timezone),
  );

  if (allEvents.length === 0) {
    return { success: true, output: t(ctx.user.language).aiTools.sharing.noEventsToShare(input.period) };
  }

  // Record the share
  for (const ev of allEvents) {
    ctx.sharing.sharedEventRepo.create({
      event_id: ev.eventId,
      shared_by: ctx.user.telegram_id,
      shared_to_type: input.target_type,
      shared_to_id: input.target_id,
      share_type: 'agenda',
    });
  }

  const lines = allEvents.map((ev) => `- ${ev.displayTitle} (${ev.startAt})`);
  return {
    success: true,
    output: t(ctx.user.language).aiTools.sharing.agendaShared(
      input.period,
      input.target_type,
      input.target_id,
      allEvents.length,
      lines.join('\n'),
    ),
  };
}

export function handleSetEventVisibility(ctx: AgentContext, input: SetEventVisibilityInput): ToolResult {
  if (!ctx.sharing?.sharingSettingsRepo) {
    return { success: false, error: 'Sharing settings are not configured.' };
  }

  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;

  const event = ctx.eventService.getEvent(input.event_id, userId);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  ctx.sharing.sharingSettingsRepo.setEventVisibility(input.event_id, input.visibility);

  return {
    success: true,
    output: t(ctx.user.language).aiTools.sharing.visibilitySet(event.title, event.id, input.visibility),
  };
}

interface ProposeEditInput {
  event_id: number;
  changes: Record<string, string | null>;
  reason?: string;
}

export async function handleProposeEdit(ctx: AgentContext, input: ProposeEditInput): Promise<ToolResult> {
  if (!ctx.participantRepo) {
    return { success: false, error: 'Participants feature is not configured.' };
  }
  if (!ctx.sharing?.editProposalRepo) {
    return { success: false, error: 'Edit proposals are not configured.' };
  }

  const participant = ctx.participantRepo.findByEventAndUser(input.event_id, ctx.user.telegram_id);
  if (!participant || participant.status !== 'accepted') {
    return { success: false, error: 'You are not an accepted participant of this event.' };
  }

  const proposal = ctx.sharing.editProposalRepo.create({
    event_id: input.event_id,
    proposer_id: ctx.user.telegram_id,
    changes: JSON.stringify(input.changes),
    reason: input.reason,
  });

  let ownerNotified = true;
  if (ctx.sender?.sendEditProposal) {
    const ownerId = ctx.eventService.getEventOwnerId(input.event_id);
    if (ownerId) {
      const proposerName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
      const changeLines = Object.entries(input.changes)
        .map(([k, v]) => `  ${k}: ${v ?? '(remove)'}`)
        .join('\n');
      const text = `📝 <b>Edit proposal</b> from ${proposerName}:\n${changeLines}${input.reason ? `\n\nReason: ${input.reason}` : ''}`;
      try {
        await ctx.sender.sendEditProposal(ownerId, text, proposal.id);
      } catch (err) {
        deliveryLogger.error(
          { err, proposalId: proposal.id, ownerId },
          'Failed to notify event owner of edit proposal',
        );
        ownerNotified = false;
      }
    } else {
      ownerNotified = false;
    }
  } else {
    ownerNotified = false;
  }

  return {
    success: true,
    output: t(ctx.user.language).aiTools.sharing.editProposalSubmitted(proposal.id),
    agentHint: ownerNotified
      ? undefined
      : 'Proposal is saved in the DB but the owner notification could NOT be delivered. Tell the user the owner may not see it immediately.',
  };
}
