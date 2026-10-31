// send_invitation: what to answer when the recipient could not be resolved to a verified Telegram
// account — a contact row id, a numeric id needing user confirmation, a username to pick, or an
// unverified/conflicting identity. Each outcome is its own named step, tried in this order.
import { InlineKeyboard } from 'gramio';
import { t } from '../../../config/constants.ts';
import { escapeHtml } from '../../../utils/telegram.ts';
import { issueRecipientApproval } from '../recipient-confirmation.ts';
import type { resolveInvitationRecipient } from '../recipient-identity.ts';
import type { AgentContext, ToolResult } from '../types.ts';
import { handlePickUsers } from './meta.ts';

// recipient-identity.ts does not export its resolution type, so derive it from the resolver.
type Resolution = Awaited<ReturnType<typeof resolveInvitationRecipient>>;
export type UnresolvedRecipient = Extract<Resolution, { ok: false }>;
export type ResolvedRecipient = Extract<Resolution, { ok: true }>;
type ContactRowRecipient = Extract<UnresolvedRecipient, { reason: 'contact_row_id' }>;
type IdentityRecipient = Exclude<UnresolvedRecipient, { reason: 'contact_row_id' }>;

interface SendInvitationRecipientInput {
  force?: boolean;
  owner_id?: number;
  event_id: number;
  invitee_id?: number;
  invitee_username?: string;
}

/**
 * The model passed a contact_id where a Telegram ID belongs; tell it the right retry. `forOwner`: a
 * secretary invites into the owner's calendar, where pick_users does not apply (it invites as whoever
 * taps it, from their own calendar), so the retry names the exact @username instead.
 */
function contactRowIdRejection(
  ctx: AgentContext,
  eventId: number,
  { contact }: ContactRowRecipient,
  forOwner: boolean,
): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  const name = contact.preferred_name ?? contact.name;
  if (contact.telegram_id) {
    return {
      success: false,
      mutationState: 'not_applied',
      error: tr.recipientContactRowId,
      agentHint: `${contact.id} is the contact_id of "${name}", not a Telegram ID. For "${name}" retry with invitee_id ${contact.telegram_id}; for anyone else ${forOwner ? 'resolve them with find_contact or ask the user for their @username' : 'use pick_users'}.`,
    };
  }
  // A saved @username is always a valid route; the picker or ask-the-user fallback is added unless the owner's
  // calendar already has that username to use.
  const routes = [
    ...(contact.username ? [`invitee_username ${contact.username}`] : []),
    ...(contact.username && forOwner
      ? []
      : [
          forOwner
            ? "an @username the user gives you for that person (pick_users does not work for another person's calendar)"
            : `pick_users with event_id ${eventId}`,
        ]),
  ];
  return {
    success: false,
    mutationState: 'not_applied',
    error: tr.recipientContactWithoutTelegram(name),
    agentHint: `${contact.id} is the contact_id of "${name}", who has no Telegram ID. Use ${routes.join(' or ')}.`,
  };
}

/**
 * A bare numeric ID never reaches an invitation unconfirmed: ask the inviter, in a private chat, to
 * tap a confirmation button. force=true alone cannot bypass this. Null when it does not apply. `forOwner`:
 * a secretary's tap is remembered with the owner it was for, and pick_users is no alternative for them.
 */
async function requestRecipientConfirmation(
  ctx: AgentContext,
  input: SendInvitationRecipientInput,
  recipient: IdentityRecipient,
  forOwner: boolean,
): Promise<ToolResult | null> {
  const inviteeId = input.invitee_id;
  if (input.force || ctx.isGroup || inviteeId === undefined || inviteeId <= 0 || !ctx.sender?.sendMessageWithKeyboard) {
    return null;
  }
  const approval = issueRecipientApproval(ctx.user.telegram_id, input.event_id, inviteeId, {
    ownerId: forOwner ? input.owner_id : undefined,
  });
  const tr = t(ctx.user.language).aiTools.meta;
  const saved = ctx.contactRepo?.findByTelegramId(ctx.user.telegram_id, inviteeId);
  const details = [tr.recipientConfirmDetails(inviteeId, escapeHtml(input.invitee_username ?? '—'))];
  if (saved) details.push(tr.recipientSavedProfile(escapeHtml(saved.preferred_name ?? saved.name), inviteeId));
  if (recipient.candidate) {
    const candidate = recipient.candidate;
    details.push(
      tr.recipientResolvedProfile(escapeHtml(candidate.firstName ?? candidate.username ?? '—'), candidate.id),
    );
  }
  await ctx.sender.sendMessageWithKeyboard(
    ctx.user.telegram_id,
    details.join('\n'),
    new InlineKeyboard().text(tr.recipientConfirmButton, `ric:${approval}`),
  );
  return {
    success: true,
    awaitingInput: { kind: 'chat' },
    mutationState: 'not_applied',
    stopLoop: true,
    output: tr.recipientConfirmationSent,
    // The picker invites as the person who taps it, so it is no way round the confirmation for a secretary;
    // the confirmation itself tells the model how to send for the owner.
    agentHint: `Wait for the actual confirmation callback${forOwner ? '; it says how to send' : ' or use pick_users'}. force=true alone cannot bypass identity confirmation; it never changes the numeric recipient.`,
  };
}

/** A username Telegram could not resolve goes back to the user as a picker prompt. */
function pickRecipientForUsername(
  ctx: AgentContext,
  eventId: number,
  reason: 'not_found' | 'unavailable',
  username: string,
): Promise<ToolResult> {
  const prompt =
    reason === 'not_found'
      ? t(ctx.user.language).invite_resolve_not_found(username)
      : t(ctx.user.language).invite_resolve_unavailable(username);
  return handlePickUsers({ ...ctx, chatId: ctx.user.telegram_id }, { event_id: eventId, prompt });
}

function unverifiedRecipientRejection(ctx: AgentContext, recipient: IdentityRecipient, forOwner: boolean): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  return {
    success: false,
    mutationState: 'not_applied',
    error: recipient.reason === 'conflict' ? tr.recipientIdentityConflict : tr.recipientUnverified,
    // The picker invites as the person who taps it, from their own calendar only.
    agentHint: forOwner
      ? "Use find_contact or an exact user-provided @username; pick_users cannot invite into another person's calendar, so ask the user for that person's @username instead. Do not guess or reuse an unverified recipient ID."
      : 'Use find_contact, an exact user-provided @username, or pick_users. Do not guess or reuse an unverified recipient ID.',
  };
}

/** `forOwner`: a secretary invites into the owner's calendar, where the user picker does not apply. */
export async function rejectUnresolvedRecipient(
  ctx: AgentContext,
  input: SendInvitationRecipientInput,
  recipient: UnresolvedRecipient,
  forOwner: boolean,
): Promise<ToolResult> {
  if (recipient.reason === 'contact_row_id') return contactRowIdRejection(ctx, input.event_id, recipient, forOwner);
  const confirmation = await requestRecipientConfirmation(ctx, input, recipient, forOwner);
  if (confirmation) return confirmation;
  if (!forOwner && (recipient.reason === 'not_found' || recipient.reason === 'unavailable') && recipient.username) {
    return pickRecipientForUsername(ctx, input.event_id, recipient.reason, recipient.username);
  }
  return unverifiedRecipientRejection(ctx, recipient, forOwner);
}
