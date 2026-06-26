import { t } from '../../config/constants.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import { deliverInvitation } from '../../services/ai/invitation-delivery.ts';
import type { TelegramSender } from '../../services/ai/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';

/** Outcome of a picker-driven invitation delivery attempt (real Telegram delivery, not just DB row). */
export type PickerDeliveryOutcome =
  | { kind: 'delivered' }
  | { kind: 'deeplink' }
  | { kind: 'failed' }
  | { kind: 'error'; error: string }
  | { kind: 'notConfigured' };

/**
 * User-facing status line for one picker invitation, localized.
 *
 * Escaping-agnostic: the `users_shared` path sends the joined lines as PLAIN TEXT
 * (escaping would corrupt display), while the `chat_shared` path sends them with
 * `parse_mode: 'HTML'`. HTML callers MUST pass already-escaped `name`/`error`.
 */
export function pickerStatusLine(lang: 'en' | 'ru', name: string, outcome: PickerDeliveryOutcome): string {
  const m = t(lang);
  switch (outcome.kind) {
    case 'delivered':
      return m.invite_status_delivered(name);
    case 'deeplink':
      return m.invite_status_deeplink(name);
    case 'failed':
      return m.invite_status_failed(name);
    case 'error':
      return m.invite_status_error(name, outcome.error);
    case 'notConfigured':
      return m.invite_status_not_configured(name);
  }
}

/** AI-facing (English) summary line describing the real delivery result for one invitee. */
export function pickerAiLine(name: string, userId: number, outcome: PickerDeliveryOutcome): string {
  const head = `${name} (id:${userId})`;
  switch (outcome.kind) {
    case 'delivered':
      return `${head}: delivered to the invitee`;
    case 'deeplink':
      return `${head}: could not reach the invitee — a forward link was sent to the inviter`;
    case 'failed':
      return `${head}: delivery failed`;
    case 'error':
      return `${head}: invitation not created (${outcome.error})`;
    case 'notConfigured':
      return `${head}: invitations not configured`;
  }
}

/** Explicit dependencies for picker invitation delivery — no createBot closure coupling. */
export interface PickerInvitationDeps {
  sender: TelegramSender;
  invitationService?: InvitationService;
  eventService: EventService;
  invitationRepo: InvitationRepository;
  userRepo: UserRepository;
  deepLinkService?: DeepLinkService;
  botUsername?: string;
  contactRepo?: ContactRepository;
}

export interface PickerInvitationParams {
  eventId: number;
  inviter: User;
  inviteeId: number;
  inviteeUsername?: string;
  /** Where the deep-link fallback goes — always the inviter's private chat, never a group. */
  fallbackChatId: number;
  /** When false, MTProto is skipped (Bot API → deep-link only). Used for group targets. */
  allowMtproto?: boolean;
}

/**
 * Create one invitation + attempt real Telegram delivery (Bot API → MTProto → deep-link
 * fallback). Reports by ACTUAL delivery, not just by DB-row creation, so picker handlers
 * never claim "sent" for an invitation that silently vanished.
 */
export async function deliverPickerInvitation(
  params: PickerInvitationParams,
  deps: PickerInvitationDeps,
): Promise<PickerDeliveryOutcome> {
  const { invitationService } = deps;
  if (!invitationService) return { kind: 'notConfigured' };

  const inv = invitationService.sendInvitation(params.eventId, params.inviter.telegram_id, params.inviteeId);
  if (!inv.success || !inv.invitation) {
    return { kind: 'error', error: inv.error ?? 'unknown error' };
  }

  const event = deps.eventService.getEvent(params.eventId, params.inviter.telegram_id);
  const inviteeUser = deps.userRepo.findByTelegramId(params.inviteeId);
  const inviteeLang = (inviteeUser?.language ?? params.inviter.language ?? 'en') as 'en' | 'ru';

  const delivery = await deliverInvitation({
    invitationId: inv.invitation.id,
    eventId: params.eventId,
    inviteeId: params.inviteeId,
    inviteeUsername: params.inviteeUsername,
    inviterId: params.inviter.telegram_id,
    inviterName: params.inviter.first_name ?? params.inviter.username ?? `User ${params.inviter.telegram_id}`,
    inviterUsername: params.inviter.username ?? undefined,
    inviterTimezone: params.inviter.timezone,
    event,
    lang: inviteeLang,
    fallbackChatId: params.fallbackChatId,
    allowMtproto: params.allowMtproto ?? true,
    deps: {
      sender: deps.sender,
      invitationRepo: deps.invitationRepo,
      userRepo: deps.userRepo,
      deepLinkService: deps.deepLinkService,
      botUsername: deps.botUsername,
      contactRepo: deps.contactRepo,
    },
  });

  if (delivery.delivered) return { kind: 'delivered' };
  if (delivery.viaDeepLink) return { kind: 'deeplink' };
  return { kind: 'failed' };
}
