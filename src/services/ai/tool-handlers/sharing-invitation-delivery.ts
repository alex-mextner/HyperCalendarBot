// Delivery step shared by send_invitation and resend_invitation: build the deliverInvitation call
// from the agent context, classify its outcome, and attach the optional /connect_telegram hint.
import type { CalendarEvent } from '../../../database/types.ts';
import { botLogger } from '../../../utils/logger.ts';
import { deliverInvitation, type InvitationDeliveryResult } from '../invitation-delivery.ts';
import type { AgentContext, SharingCapability } from '../types.ts';
import { takeConnectTelegramSuggestion } from './settings.ts';

export const deliveryLogger = botLogger.child({ module: 'invitation-delivery' });

export type DeliveryState = 'delivered' | 'manual_forward' | 'failed';

export function deliveryState(delivery: InvitationDeliveryResult): DeliveryState {
  if (delivery.delivered) return 'delivered';
  return delivery.viaDeepLink ? 'manual_forward' : 'failed';
}

const CONNECT_SUGGESTION_HINT =
  'The bot could not reach the invitee directly: end your reply with the /connect_telegram line above, verbatim.';

/**
 * Decided here, not by the model: a prompt step asking it to check connect_telegram_status first
 * made weak models call that tool on plain event creation (#511).
 */
export function connectSuggestionAfterDelivery(
  ctx: AgentContext,
  delivery: InvitationDeliveryResult,
  isGroupTarget: boolean,
  invitationId: number,
): string | null {
  try {
    return takeConnectTelegramSuggestion(ctx, delivery, isGroupTarget);
  } catch (err) {
    // The invitation is already sent; an optional hint must not turn it into a failed write.
    deliveryLogger.warn({ err, invitationId }, 'Connect-Telegram suggestion failed');
    return null;
  }
}

/** The agent hint, extended with the verbatim-/connect_telegram instruction when a suggestion exists. */
export function hintWithConnectSuggestion(deliveryHint: string, connectSuggestion: string | null): string {
  return connectSuggestion ? `${deliveryHint} ${CONNECT_SUGGESTION_HINT}` : deliveryHint;
}

interface InvitationDeliveryTarget {
  invitationId: number;
  eventId: number;
  inviteeId: number;
  inviteeUsername: string | undefined;
  event: CalendarEvent | null | undefined;
  isGroupTarget: boolean;
}

/** Callers must have checked ctx.sender: deliverInvitation needs a sender to reach anyone. */
export function deliverInvitationFromContext(
  ctx: AgentContext,
  sharing: SharingCapability,
  sender: NonNullable<AgentContext['sender']>,
  target: InvitationDeliveryTarget,
): Promise<InvitationDeliveryResult> {
  return deliverInvitation({
    invitationId: target.invitationId,
    eventId: target.eventId,
    inviteeId: target.inviteeId,
    inviteeUsername: target.inviteeUsername,
    inviterId: ctx.user.telegram_id,
    inviterName: ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`,
    inviterUsername: ctx.user.username ?? undefined,
    inviterTimezone: ctx.user.timezone,
    event: target.event,
    lang: (ctx.user.language ?? 'en') as 'en' | 'ru',
    inviterLang: (ctx.user.language ?? 'en') as 'en' | 'ru',
    // The deep-link fallback is a PRIVATE invite link — it must reach the inviter's
    // private chat, never ctx.chatId (which may be a group the bot was invoked from,
    // leaking the invitee's personal invitation to every member).
    fallbackChatId: ctx.user.telegram_id,
    allowInviterSession: !target.isGroupTarget,
    isGroupTarget: target.isGroupTarget,
    deps: {
      sender,
      invitationRepo: sharing.invitationRepo,
      userRepo: ctx.userRepo,
      deepLinkService: ctx.deepLinkService,
      botUsername: ctx.botUsername,
      contactRepo: ctx.contactRepo,
    },
  });
}
