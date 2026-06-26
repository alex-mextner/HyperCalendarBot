import { t } from '../../config/constants.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import { botLogger } from '../../utils/logger.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { formatInvitation } from '../event/formatters.ts';
import type { DeepLinkService } from '../sharing/deep-link-service.ts';
import { buildUserSessionInvitationText } from '../telegram-session/invitation-text.ts';
import { deliverMessage } from './deliver-message.ts';
import type { TelegramSender } from './types.ts';

const deliveryLogger = botLogger.child({ module: 'invitation-delivery' });

/** Explicit dependencies for invitation delivery — no AgentContext coupling. */
export interface InvitationDeliveryDeps {
  sender: TelegramSender;
  invitationRepo: InvitationRepository;
  userRepo: UserRepository;
  deepLinkService?: DeepLinkService;
  botUsername?: string;
  contactRepo?: ContactRepository;
}

export interface DeliverInvitationParams {
  invitationId: number;
  eventId: number;
  inviteeId: number;
  inviteeUsername?: string;
  inviterId: number;
  inviterName: string;
  inviterUsername?: string;
  /** Inviter timezone — used to render first-person user-session invitation text. */
  inviterTimezone: string;
  event?: CalendarEvent | null;
  lang: 'en' | 'ru';
  /** Where to send the deep-link fallback (the inviter's chat). */
  fallbackChatId: number;
  /** When false, MTProto is skipped entirely (Bot API → deep-link only). Default true. */
  allowMtproto?: boolean;
  deps: InvitationDeliveryDeps;
}

export async function deliverInvitation(
  params: DeliverInvitationParams,
): Promise<{ delivered: boolean; viaDeepLink: boolean }> {
  const {
    invitationId,
    eventId,
    inviteeId,
    inviteeUsername,
    inviterId,
    inviterName,
    inviterUsername,
    inviterTimezone,
    event,
    lang,
    fallbackChatId,
    allowMtproto = true,
    deps,
  } = params;
  const { sender, invitationRepo, userRepo, deepLinkService: deepLinkSvc, botUsername } = deps;
  if (!sender.sendInvitation) {
    return { delivered: false, viaDeepLink: false };
  }

  const eventTitle = event?.title ?? `Event #${eventId}`;
  deliveryLogger.info(
    { invitationId, inviteeId, inviteeUsername: inviteeUsername ?? 'NONE', eventTitle },
    'Starting delivery chain',
  );

  const invitee = userRepo.findByTelegramId(inviteeId);
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
          inviterTimezone,
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
      fallbackRecipientId: fallbackChatId,
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
      mtprotoSend: allowMtproto ? combinedMtprotoSend : undefined,
    });

    if (result.delivered && result.messageId !== undefined) {
      deliveryLogger.info({ invitationId, inviteeId }, 'Delivered via bot API');
      invitationRepo.setMessageInfo(invitationId, result.messageId, inviteeId);
      return { delivered: true, viaDeepLink: false };
    }
    if (result.delivered) {
      deliveryLogger.info({ invitationId, inviteeId }, 'Delivered via MTProto');
      return { delivered: true, viaDeepLink: false };
    }
    // Only claim "link sent to inviter" when a real link existed AND the fallback
    // message actually reached the inviter. Otherwise report honest non-delivery.
    const linkSent = url !== null && result.fallbackSent === true;
    deliveryLogger.info(
      { invitationId, fallbackChatId, linkSent, hadLink: url !== null, fallbackSent: result.fallbackSent === true },
      'Bot API + MTProto failed — deep-link fallback attempted',
    );
    return { delivered: false, viaDeepLink: linkSent };
  } catch (error) {
    deliveryLogger.error({ invitationId, inviteeId, err: error }, 'Delivery chain failed');
    return { delivered: false, viaDeepLink: false };
  }
}

export function lookupInviteeUsername(
  deps: { userRepo: UserRepository; contactRepo?: ContactRepository },
  ownerId: number,
  inviteeId: number,
): string | undefined {
  // Try users table
  const user = deps.userRepo.findByTelegramId(inviteeId);
  if (user?.username) return user.username;

  // Try contacts by telegram_id
  if (deps.contactRepo) {
    const contact = deps.contactRepo.findByTelegramId(ownerId, inviteeId);
    if (contact?.username) return contact.username;

    // Last resort: scan all contacts for any with a username (small list)
    const all = deps.contactRepo.list(ownerId);
    for (const c of all) {
      if (c.telegram_id === inviteeId && c.username) return c.username;
    }
    // If only one contact with a username exists and no telegram_id match, give up
  }
  return undefined;
}
