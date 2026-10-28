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
  event_id: number;
  invitee_id?: number;
  invitee_username?: string;
}

/** The model passed a contact_id where a Telegram ID belongs; tell it the right retry. */
function contactRowIdRejection(ctx: AgentContext, eventId: number, { contact }: ContactRowRecipient): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  const name = contact.preferred_name ?? contact.name;
  if (contact.telegram_id) {
    return {
      success: false,
      mutationState: 'not_applied',
      error: tr.recipientContactRowId,
      agentHint: `${contact.id} is the contact_id of "${name}", not a Telegram ID. For "${name}" retry with invitee_id ${contact.telegram_id}; for anyone else use pick_users.`,
    };
  }
  const usernameRoute = contact.username ? `invitee_username ${contact.username} or ` : '';
  return {
    success: false,
    mutationState: 'not_applied',
    error: tr.recipientContactWithoutTelegram(name),
    agentHint: `${contact.id} is the contact_id of "${name}", who has no Telegram ID. Use ${usernameRoute}pick_users with event_id ${eventId}.`,
  };
}

/**
 * A bare numeric ID never reaches an invitation unconfirmed: ask the inviter, in a private chat, to
 * tap a confirmation button. force=true alone cannot bypass this. Null when it does not apply.
 */
async function requestRecipientConfirmation(
  ctx: AgentContext,
  input: SendInvitationRecipientInput,
  recipient: IdentityRecipient,
): Promise<ToolResult | null> {
  const inviteeId = input.invitee_id;
  if (input.force || ctx.isGroup || inviteeId === undefined || inviteeId <= 0 || !ctx.sender?.sendMessageWithKeyboard) {
    return null;
  }
  const approval = issueRecipientApproval(ctx.user.telegram_id, input.event_id, inviteeId);
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
    agentHint:
      'Wait for the actual confirmation callback or use pick_users. force=true alone cannot bypass identity confirmation; it never changes the numeric recipient.',
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

function unverifiedRecipientRejection(ctx: AgentContext, recipient: IdentityRecipient): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  return {
    success: false,
    mutationState: 'not_applied',
    error: recipient.reason === 'conflict' ? tr.recipientIdentityConflict : tr.recipientUnverified,
    agentHint:
      'Use find_contact, an exact user-provided @username, or pick_users. Do not guess or reuse an unverified recipient ID.',
  };
}

export async function rejectUnresolvedRecipient(
  ctx: AgentContext,
  input: SendInvitationRecipientInput,
  recipient: UnresolvedRecipient,
): Promise<ToolResult> {
  if (recipient.reason === 'contact_row_id') return contactRowIdRejection(ctx, input.event_id, recipient);
  const confirmation = await requestRecipientConfirmation(ctx, input, recipient);
  if (confirmation) return confirmation;
  if ((recipient.reason === 'not_found' || recipient.reason === 'unavailable') && recipient.username) {
    return pickRecipientForUsername(ctx, input.event_id, recipient.reason, recipient.username);
  }
  return unverifiedRecipientRejection(ctx, recipient);
}
