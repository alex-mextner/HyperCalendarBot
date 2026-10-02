import { InlineKeyboard } from 'gramio';
import { type Lang, t } from '../../../config/constants.ts';
import type {
  EventParticipant,
  Invitation,
  InvitationStatus,
  ParticipantStatus,
  Visibility,
} from '../../../database/types.ts';
import { botLogger } from '../../../utils/logger.ts';
import { escapeHtml } from '../../../utils/telegram.ts';
import { deliverInvitation } from '../invitation-delivery.ts';
import { issueRecipientApproval } from '../recipient-confirmation.ts';
import { resolveInvitationRecipient } from '../recipient-identity.ts';
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
  force?: boolean;
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

  if (input.invitee_id === undefined && !input.invitee_username) {
    return { success: false, error: t(ctx.user.language).aiTools.meta.recipientMissing };
  }

  if (!ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id))
    return { success: false, error: 'Event not found' };

  let recipient: Awaited<ReturnType<typeof resolveInvitationRecipient>>;
  try {
    recipient = await resolveInvitationRecipient(ctx, input);
  } catch (err) {
    deliveryLogger.warn(
      { errorName: err instanceof Error ? err.name : 'UnknownError' },
      'Recipient verification failed',
    );
    return {
      success: false,
      error: input.invitee_username
        ? t(ctx.user.language).aiTools.meta.recipientLookupFailed(input.invitee_username.replace(/^@/, ''))
        : t(ctx.user.language).aiTools.meta.recipientUnverified,
    };
  }
  if (!recipient.ok) {
    if (
      !input.force &&
      !ctx.isGroup &&
      input.invitee_id !== undefined &&
      input.invitee_id > 0 &&
      ctx.sender?.sendMessageWithKeyboard
    ) {
      const token = issueRecipientApproval(ctx.user.telegram_id, input.event_id, input.invitee_id);
      const tr = t(ctx.user.language).aiTools.meta;
      const saved = ctx.contactRepo?.findByTelegramId(ctx.user.telegram_id, input.invitee_id);
      const details = [tr.recipientConfirmDetails(input.invitee_id, escapeHtml(input.invitee_username ?? '—'))];
      if (saved)
        details.push(tr.recipientSavedProfile(escapeHtml(saved.preferred_name ?? saved.name), input.invitee_id));
      if (recipient.candidate) {
        const candidate = recipient.candidate;
        details.push(
          tr.recipientResolvedProfile(escapeHtml(candidate.firstName ?? candidate.username ?? '—'), candidate.id),
        );
      }
      const text = details.join('\n');
      await ctx.sender.sendMessageWithKeyboard(
        ctx.user.telegram_id,
        text,
        new InlineKeyboard().text(tr.recipientConfirmButton, `ric:${token}`),
      );
      return {
        success: false,
        stopLoop: true,
        error: tr.recipientUnverified,
        output: tr.recipientConfirmationSent,
        agentHint:
          'Wait for the actual confirmation callback or use pick_users. force=true alone cannot bypass identity confirmation; it never changes the numeric recipient.',
      };
    }
    if (recipient.reason === 'not_found' && recipient.username) {
      const prompt = t(ctx.user.language).invite_resolve_not_found(recipient.username);
      return handlePickUsers({ ...ctx, chatId: ctx.user.telegram_id }, { event_id: input.event_id, prompt });
    }
    const tr = t(ctx.user.language).aiTools.meta;
    return {
      success: false,
      error:
        recipient.reason === 'conflict'
          ? tr.recipientIdentityConflict
          : recipient.reason === 'unavailable'
            ? tr.recipientResolveUnavailable
            : tr.recipientUnverified,
      agentHint:
        'Use find_contact, an exact user-provided @username, or pick_users. Do not guess or reuse an unverified recipient ID.',
    };
  }
  const inviteeId = recipient.id;
  const inviteeUsername = recipient.username;
  const resolvedFirstName = recipient.firstName;
  const isGroupTarget = recipient.isGroup;

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
  if (ctx.contactRepo && !isGroupTarget && !ctx.contactRepo.findByTelegramId(ctx.user.telegram_id, inviteeId)) {
    const invitee = ctx.userRepo.findByTelegramId(inviteeId);
    const contactName =
      resolvedFirstName ?? invitee?.first_name ?? inviteeUsername ?? invitee?.username ?? `User ${inviteeId}`;
    try {
      ctx.contactRepo.upsert(ctx.user.telegram_id, contactName, inviteeUsername, inviteeId);
    } catch (err) {
      // The invitation already exists; an address-book conflict must not cancel its delivery.
      deliveryLogger.warn({ err, invitationId: invitation.id }, 'Invitation recipient was not added to contacts');
    }
  }

  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  let delivery: { delivered: boolean; viaDeepLink: boolean } = { delivered: false, viaDeepLink: false };
  if (ctx.sender) {
    delivery = await deliverInvitation({
      invitationId: invitation.id,
      eventId: input.event_id,
      inviteeId,
      inviteeUsername,
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

  // The owned pending invitation establishes intent; its historical username is only metadata.
  const recipient = await resolveInvitationRecipient(
    ctx,
    {
      invitee_id: invitation.invitee_id,
      invitee_username: invitation.invitee_id < 0 ? undefined : input.invitee_username,
    },
    invitation.invitee_id,
  );
  if (!recipient.ok) {
    const tr = t(ctx.user.language).aiTools.meta;
    return {
      success: false,
      error: recipient.reason === 'conflict' ? tr.recipientIdentityConflict : tr.recipientUnverified,
    };
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
      inviteeUsername: recipient.username,
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
 * 1. Positive participant RSVP (accepted/maybe) is always authoritative — it reflects a confirmed
 *    response from any channel (personal or group) and must not be masked by a pending invite.
 * 2. A pending invitation takes priority over stale negative/neutral participant rows (declined,
 *    pending), treating them as superseded by a fresh re-invite.
 * 3. Otherwise the event_participants row is authoritative, falling back to the invitation status.
 * When participant and invitation statuses conflict, the invite is shown as a note on the same
 * line. A dead personal invite (declined/cancelled/expired) with no participant row is skipped.
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
    // A pending re-invite overrides stale negative/neutral participant rows (declined,
    // pending) but must NOT mask a confirmed RSVP (accepted/maybe) from another
    // channel such as a group invite — that positive signal is always authoritative.
    const status =
      inv.status === 'pending' && participantStatus !== 'accepted' && participantStatus !== 'maybe'
        ? inv.status
        : (participantStatus ?? inv.status);
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
  if (!ctx.sharing?.editProposalRepo) {
    return { success: false, error: 'Edit proposals are not configured.' };
  }

  const callerId = ctx.user.telegram_id;
  const ownerId = ctx.eventService.getEventOwnerId(input.event_id);
  const isOwner = ownerId === callerId;
  const hasPersonalInvitation =
    !isOwner && ctx.sharing.invitationRepo.findActiveOrRespondedByEventAndInvitee(input.event_id, callerId) !== null;

  if (!isOwner && !hasPersonalInvitation) {
    return { success: false, error: 'You are not invited to this event.' };
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
