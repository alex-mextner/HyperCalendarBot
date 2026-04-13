import { t } from '../../../config/constants.ts';
import type { CalendarEvent, Visibility } from '../../../database/types.ts';
import { botLogger } from '../../../utils/logger.ts';
import { escapeHtml } from '../../../utils/telegram.ts';
import { formatInvitation } from '../../event/formatters.ts';
import { buildUserSessionInvitationText } from '../../telegram-session/invitation-text.ts';
import { deliverMessage } from '../deliver-message.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';
import { checkSecretaryAccess } from './secretary-access.ts';

const deliveryLogger = botLogger.child({ module: 'invitation-delivery' });

interface DeliveryParams {
  invitationId: number;
  eventId: number;
  inviteeId: number;
  inviteeUsername?: string;
  inviterId: number;
  inviterName: string;
  inviterUsername?: string;
  event?: CalendarEvent | null;
  lang: 'en' | 'ru';
  ctx: AgentContext;
}

async function deliverInvitation(params: DeliveryParams): Promise<{ delivered: boolean; viaDeepLink: boolean }> {
  const {
    invitationId,
    eventId,
    inviteeId,
    inviteeUsername,
    inviterId,
    inviterName,
    inviterUsername,
    event,
    lang,
    ctx,
  } = params;
  if (!ctx.sender?.sendInvitation || !ctx.sharing?.invitationRepo) {
    return { delivered: false, viaDeepLink: false };
  }

  const eventTitle = event?.title ?? `Event #${eventId}`;
  deliveryLogger.info(
    { invitationId, inviteeId, inviteeUsername: inviteeUsername ?? 'NONE', eventTitle },
    'Starting delivery chain',
  );

  const invitee = ctx.userRepo.findByTelegramId(inviteeId);
  const text = event
    ? formatInvitation(
        event,
        event.timezone,
        lang,
        inviterName,
        inviterId,
        inviterUsername,
        invitee?.timezone ?? null,
        !!invitee?.onboarding_completed,
      )
    : t(lang).invitation_received(escapeHtml(eventTitle), escapeHtml(inviterName));
  const invRepo = ctx.sharing!.invitationRepo;
  const sender = ctx.sender;
  const chatId = ctx.chatId;
  const deepLinkSvc = ctx.deepLinkService;
  const botUsername = ctx.botUsername;

  if (!deepLinkSvc || !botUsername) {
    deliveryLogger.warn(
      { invitationId, hasDeepLink: !!deepLinkSvc, hasBotUsername: !!botUsername },
      'No fallback available — deepLinkService or botUsername missing',
    );
  }

  const link = deepLinkSvc && botUsername ? deepLinkSvc.createInvitationLink(invitationId, eventId, inviterId) : null;
  const url = link && botUsername ? deepLinkSvc!.generateUrl(link.code, botUsername) : null;
  const tr = t(lang).aiTools.sharing;
  const fallbackMsg =
    url !== null ? tr.deliveryFallbackWithLink(eventTitle, url) : tr.deliveryFallbackNoLink(eventTitle);

  // User-session MTProto: first-person text via user's own connected session
  const userFirstPersonText =
    event && url && sender.sendAsConnectedUser
      ? buildUserSessionInvitationText({
          event: {
            title: event.title,
            start_utc: event.start_at,
            location: event.location,
            description: event.description,
          },
          inviterTimezone: ctx.user.timezone,
          deepLink: url,
          lang,
        })
      : null;

  const userMtprotoSend =
    userFirstPersonText && sender.sendAsConnectedUser
      ? async (targetId: number, _text: string, username?: string): Promise<boolean> =>
          sender.sendAsConnectedUser!(inviterId, targetId, userFirstPersonText, username, { invitationId })
      : undefined;

  // Admin MTProto: third-person text via admin session (existing fallback)
  const mtprotoSend =
    sender.sendAsUser && url !== null
      ? (userId: number, _text: string, username?: string): Promise<boolean> => {
          const mtprotoText = tr.mtprotoInvite(inviterName, eventTitle, url);
          return sender.sendAsUser!(userId, mtprotoText, username);
        }
      : undefined;

  // Combined: try user session first (first-person), fall back to admin session (third-person)
  const combinedMtprotoSend =
    userMtprotoSend || mtprotoSend
      ? async (targetId: number, text: string, username?: string): Promise<boolean> => {
          if (userMtprotoSend) {
            const ok = await userMtprotoSend(targetId, text, username);
            if (ok) return true;
          }
          return mtprotoSend ? mtprotoSend(targetId, text, username) : false;
        }
      : undefined;

  try {
    const result = await deliverMessage({
      targetId: inviteeId,
      targetUsername: inviteeUsername,
      text,
      fallbackRecipientId: chatId,
      fallbackText: fallbackMsg,
      botSend: async (recipientId, msgText) => {
        if (recipientId === inviteeId) {
          if (!sender.sendInvitation) throw new Error('sendInvitation not available');
          const sent = await sender.sendInvitation(recipientId, msgText, invitationId);
          if (!sent) throw new Error('Bot API delivery failed');
          return sent;
        }
        return sender.sendMessage(recipientId, msgText);
      },
      mtprotoSend: combinedMtprotoSend,
    });

    if (result.delivered && result.messageId !== undefined) {
      deliveryLogger.info({ invitationId, inviteeId }, 'Delivered via bot API');
      invRepo.setMessageInfo(invitationId, result.messageId, inviteeId);
      return { delivered: true, viaDeepLink: false };
    }
    if (result.delivered) {
      deliveryLogger.info({ invitationId, inviteeId }, 'Delivered via MTProto');
      return { delivered: true, viaDeepLink: false };
    }
    deliveryLogger.info({ invitationId, chatId }, 'Sending deep link fallback to inviter');
    return { delivered: false, viaDeepLink: true };
  } catch (error) {
    deliveryLogger.error({ invitationId, inviteeId, err: error }, 'Delivery chain failed');
    return { delivered: false, viaDeepLink: false };
  }
}

function lookupInviteeUsername(ctx: AgentContext, inviteeId: number): string | undefined {
  // Try users table
  const user = ctx.userRepo.findByTelegramId(inviteeId);
  if (user?.username) return user.username;

  // Try contacts by telegram_id
  if (ctx.contactRepo) {
    const contact = ctx.contactRepo.findByTelegramId(ctx.user.telegram_id, inviteeId);
    if (contact?.username) return contact.username;

    // Last resort: scan all contacts for any with a username (small list)
    const all = ctx.contactRepo.list(ctx.user.telegram_id);
    for (const c of all) {
      if (c.telegram_id === inviteeId && c.username) return c.username;
    }
    // If only one contact with a username exists and no telegram_id match, give up
  }
  return undefined;
}

interface ShareEventInput {
  event_id: number;
  target_type: 'user' | 'group';
  target_id: number;
}

interface SendInvitationInput {
  event_id: number;
  invitee_id: number;
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

  const result = ctx.sharing.invitationService.sendInvitation(
    input.event_id,
    ctx.user.telegram_id,
    input.invitee_id,
    input.invitee_username,
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  const invitation = result.invitation!;

  // Auto-add invitee to inviter's contacts
  if (ctx.contactRepo) {
    const invitee = ctx.userRepo.findByTelegramId(input.invitee_id);
    if (invitee) {
      ctx.contactRepo.upsert(
        ctx.user.telegram_id,
        invitee.first_name ?? invitee.username ?? `User ${invitee.telegram_id}`,
        invitee.username ?? undefined,
        invitee.telegram_id,
      );
    }
  }

  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  const delivery = await deliverInvitation({
    invitationId: invitation.id,
    eventId: input.event_id,
    inviteeId: input.invitee_id,
    inviteeUsername: input.invitee_username ?? lookupInviteeUsername(ctx, input.invitee_id),
    inviterId: ctx.user.telegram_id,
    inviterName: ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`,
    inviterUsername: ctx.user.username ?? undefined,
    event,
    lang: (ctx.user.language ?? 'en') as 'en' | 'ru',
    ctx,
  });

  return {
    success: true,
    output: t(ctx.user.language).aiTools.sharing.invitationCreated(invitation.id, input.event_id, input.invitee_id),
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

  if (ctx.sender?.sendInvitation) {
    const event = ctx.eventService.getEvent(invitation.event_id, ctx.user.telegram_id);
    const delivery = await deliverInvitation({
      invitationId: invitation.id,
      eventId: invitation.event_id,
      inviteeId: invitation.invitee_id,
      inviteeUsername:
        input.invitee_username ?? invitation.invitee_username ?? lookupInviteeUsername(ctx, invitation.invitee_id),
      inviterId: ctx.user.telegram_id,
      inviterName: ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`,
      inviterUsername: ctx.user.username ?? undefined,
      event,
      lang: (ctx.user.language ?? 'en') as 'en' | 'ru',
      ctx,
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

export function handleGetInvitationStatus(ctx: AgentContext, input: GetInvitationStatusInput): ToolResult {
  if (!ctx.sharing?.invitationRepo) {
    return { success: false, error: 'Invitations are not configured.' };
  }

  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const pending = ctx.sharing.invitationRepo.getPendingForEvent(input.event_id);
  const accepted = ctx.sharing.invitationRepo.getAcceptedForEvent(input.event_id);

  const lines: string[] = [];
  for (const inv of accepted) {
    lines.push(`invitee: ${inv.invitee_id}, status: accepted`);
  }
  for (const inv of pending) {
    lines.push(`invitee: ${inv.invitee_id}, status: ${inv.status}`);
  }

  const lang = ctx.user.language;
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
