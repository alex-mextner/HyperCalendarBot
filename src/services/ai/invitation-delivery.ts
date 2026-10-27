import { t } from '../../config/constants.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import { botLogger } from '../../utils/logger.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { formatInvitation } from '../event/formatters.ts';
import type { DeepLinkService } from '../sharing/deep-link-service.ts';
import { readInvitationRoster } from '../sharing/invitation-roster.ts';
import { buildUserSessionInvitationText } from '../telegram-session/invitation-text.ts';
import { type DeliverMessageParams, deliverMessage, describeDeliveryError } from './deliver-message.ts';
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
  /** Human display name for the invitee (e.g. the picker's firstName). Used to label the
   *  inviter-facing fallback when the invitee has no DB row / username. */
  inviteeName?: string;
  inviterId: number;
  inviterName: string;
  inviterUsername?: string;
  /** Inviter timezone — used to render first-person user-session invitation text. */
  inviterTimezone: string;
  event?: CalendarEvent | null;
  /** Invitee-facing language — the invitation text shown to the invitee. */
  lang: 'en' | 'ru';
  /** Inviter-facing language — the deep-link fallback/forwarding message sent to the inviter. */
  inviterLang: 'en' | 'ru';
  /** Where to send the deep-link fallback (the inviter's chat). */
  fallbackChatId: number;
  /** When false, the inviter's own Telegram session is skipped (Bot API → deep-link only). Default true. */
  allowInviterSession?: boolean;
  /** When true, the target is a group chat: the deep-link fallback is suppressed. A forward
   *  invite link resolves only in a USER's private /start and authorizes against the user's
   *  telegram_id, so it can never be accepted on behalf of a group — reporting "link sent" would
   *  be a lie. On Bot-API failure the result is an honest non-delivery (viaDeepLink: false). */
  isGroupTarget?: boolean;
  deps: InvitationDeliveryDeps;
}

export interface InvitationDeliveryResult {
  delivered: boolean;
  viaDeepLink: boolean;
  /** The bot itself reached the invitee — they have started the bot and not blocked it. */
  viaBotApi: boolean;
}

type InviteeRecord = ReturnType<UserRepository['findByTelegramId']>;

const NOT_DELIVERED: InvitationDeliveryResult = { delivered: false, viaDeepLink: false, viaBotApi: false };

function buildInvitationText(params: DeliverInvitationParams, invitee: InviteeRecord, eventTitle: string): string {
  const { event, lang, inviterName, inviterId, inviterUsername, inviteeId, deps } = params;
  if (!event) return t(lang).invitation_received(escapeHtml(eventTitle), escapeHtml(inviterName));
  return formatInvitation(
    event,
    event.timezone,
    lang,
    inviterName,
    inviterId,
    inviterUsername,
    invitee?.timezone ?? null,
    !!invitee?.onboarding_completed,
    readInvitationRoster(deps.invitationRepo, event.id, inviteeId),
  );
}

/** Creates the invitation deep link URL; a creation failure degrades to no link instead of blocking the Bot API send. */
function createFallbackUrl(params: DeliverInvitationParams): string | null {
  const { invitationId, eventId, inviterId, inviteeId } = params;
  const { deepLinkService: deepLinkSvc, botUsername } = params.deps;
  try {
    const link = deepLinkSvc && botUsername ? deepLinkSvc.createInvitationLink(invitationId, eventId, inviterId) : null;
    return link && deepLinkSvc && botUsername ? deepLinkSvc.generateUrl(link.code, botUsername) : null;
  } catch (err) {
    // The deep link is only used by the user-session/fallback path. A creation failure must not
    // block the primary Bot API send to a reachable invitee — degrade to no-link (Bot API still
    // runs; the inviter fallback becomes the no-link variant; the user session, which needs the
    // link, is skipped).
    deliveryLogger.warn(
      { invitationId, inviteeId, err: describeDeliveryError(err) },
      'deep-link creation failed; continuing without link',
    );
    return null;
  }
}

/** Identify the invitee in the fallback message: a batch sends one fallback per failed invitee
 *  to the same inviter chat, concurrently — without a label the inviter can't tell which
 *  deep-link belongs to whom (could forward the wrong person's invite). */
function inviteeFallbackLabel(params: DeliverInvitationParams, invitee: InviteeRecord): string {
  const { inviteeName, inviteeUsername, inviteeId } = params;
  return (
    inviteeName ??
    invitee?.first_name ??
    (inviteeUsername ? `@${inviteeUsername}` : invitee?.username ? `@${invitee.username}` : `#${inviteeId}`)
  );
}

/** The inviter's own connected Telegram account sends a first-person invitation with the link. */
function buildUserSessionSend(
  params: DeliverInvitationParams,
  url: string | null,
): DeliverMessageParams['userSessionSend'] {
  const { event, inviterTimezone, lang, inviterId, invitationId, allowInviterSession = true } = params;
  const sendAsConnected = params.deps.sender.sendAsConnectedUser;
  if (!allowInviterSession || !event || !url || !sendAsConnected) return undefined;
  const userFirstPersonText = buildUserSessionInvitationText({ event, inviterTimezone, deepLink: url, lang });
  return async (targetId, _text, username) =>
    sendAsConnected(inviterId, targetId, userFirstPersonText, username, { invitationId });
}

function buildBotSend(params: DeliverInvitationParams): DeliverMessageParams['botSend'] {
  const { inviteeId, event, isGroupTarget = false, invitationId, eventId, lang } = params;
  const { sender } = params.deps;
  return async (recipientId, msgText) => {
    if (recipientId !== inviteeId) return sender.sendMessage(recipientId, msgText);
    if (!sender.sendInvitation) throw new Error('sendInvitation not available');
    // A group target carries the per-member RSVP keyboard (grsvp:<eventId>:going|notgoing)
    // so any member can respond for themselves; a personal target keeps the inv: keyboard.
    // Both offer the Map button when the event's place is confirmed.
    const place = event ?? null;
    const sent = isGroupTarget
      ? await sender.sendInvitation(recipientId, msgText, invitationId, lang, { kind: 'group', eventId, place })
      : await sender.sendInvitation(recipientId, msgText, invitationId, lang, { kind: 'personal', place });
    if (!sent) throw new Error('Bot API delivery failed');
    return sent;
  };
}

function persistMessageInfo(params: DeliverInvitationParams, messageId: number): void {
  const { invitationId, inviteeId } = params;
  try {
    params.deps.invitationRepo.setMessageInfo(invitationId, messageId, inviteeId);
  } catch (err) {
    // The invitation was already delivered via Bot API; only persisting the message_id
    // (a DB UPDATE) failed. A lost message_id is a degraded-but-acceptable state. Reporting
    // non-delivery here would make the inviter retry → the invitee gets a DUPLICATE invitation.
    deliveryLogger.warn(
      { invitationId, inviteeId, err: describeDeliveryError(err) },
      'delivered but failed to persist message info',
    );
  }
}

type DeliveryOutcome = Awaited<ReturnType<typeof deliverMessage>>;

function reportDeliveryOutcome(
  params: DeliverInvitationParams,
  result: DeliveryOutcome,
  url: string | null,
): InvitationDeliveryResult {
  const { invitationId, inviteeId, fallbackChatId } = params;
  if (result.delivered && result.messageId !== undefined) {
    deliveryLogger.info({ invitationId, inviteeId }, 'Delivered via bot API');
    persistMessageInfo(params, result.messageId);
    return { delivered: true, viaDeepLink: false, viaBotApi: true };
  }
  if (result.delivered) {
    deliveryLogger.info({ invitationId, inviteeId }, "Delivered via the inviter's own Telegram account");
    return { delivered: true, viaDeepLink: false, viaBotApi: false };
  }
  // Only claim "link sent to inviter" when a real link existed AND the fallback
  // message actually reached the inviter. Otherwise report honest non-delivery.
  const linkSent = url !== null && result.fallbackSent === true;
  deliveryLogger.info(
    { invitationId, fallbackChatId, linkSent, hadLink: url !== null, fallbackSent: result.fallbackSent === true },
    'Bot API + inviter session failed — deep-link fallback attempted',
  );
  return { delivered: false, viaDeepLink: linkSent, viaBotApi: false };
}

export async function deliverInvitation(params: DeliverInvitationParams): Promise<InvitationDeliveryResult> {
  const { invitationId, eventId, inviteeId, inviteeUsername, event, inviterLang, fallbackChatId, deps } = params;
  const { sender, userRepo, deepLinkService: deepLinkSvc, botUsername } = deps;
  if (!sender.sendInvitation) return { ...NOT_DELIVERED };

  // The outer try guards every setup step after the invitation row was created, so nothing
  // propagates out of the handler. Two failure modes differ:
  //  - Deep-link creation has its OWN inner try/catch that recovers to url=null: the primary Bot
  //    API send still runs (a reachable invitee is unaffected) and only the user-session/deep-link
  //    path degrades — it does NOT reach this outer catch.
  //  - Any other setup/formatter throw (e.g. formatInvitation, message build) falls to the outer
  //    catch below and is reported as an honest non-delivery.
  try {
    const eventTitle = event?.title ?? `Event #${eventId}`;
    deliveryLogger.info(
      { invitationId, inviteeId, inviteeUsername: inviteeUsername ?? 'NONE', eventTitle },
      'Starting delivery chain',
    );

    const invitee = userRepo.findByTelegramId(inviteeId);
    const text = buildInvitationText(params, invitee, eventTitle);

    if (!deepLinkSvc || !botUsername) {
      deliveryLogger.warn(
        { invitationId, hasDeepLink: !!deepLinkSvc, hasBotUsername: !!botUsername },
        'No fallback available — deepLinkService or botUsername missing',
      );
    }

    const url = createFallbackUrl(params);
    // The fallback/forwarding message is sent to the INVITER, so it uses the inviter's language —
    // not the invitee's (`lang`), which drives the invitee-facing invitation text.
    const inviterTr = t(inviterLang).aiTools.sharing;
    const inviteeLabel = inviteeFallbackLabel(params, invitee);
    const fallbackMsg =
      url !== null
        ? inviterTr.deliveryFallbackWithLink(eventTitle, inviteeLabel, url)
        : inviterTr.deliveryFallbackNoLink(eventTitle, inviteeLabel);

    const result = await deliverMessage({
      targetId: inviteeId,
      targetUsername: inviteeUsername,
      text,
      fallbackRecipientId: fallbackChatId,
      fallbackText: fallbackMsg,
      botSend: buildBotSend(params),
      userSessionSend: buildUserSessionSend(params, url),
      suppressFallback: params.isGroupTarget ?? false,
    });
    return reportDeliveryOutcome(params, result, url);
  } catch (error) {
    // Sanitize: a thrown Telegram/API error can attach the full request body (incl. the deep
    // link) as enumerable props; describeDeliveryError reads only safe scalar fields.
    deliveryLogger.error({ invitationId, inviteeId, err: describeDeliveryError(error) }, 'Delivery chain failed');
    return { ...NOT_DELIVERED };
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
