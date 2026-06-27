import { t } from '../../config/constants.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { User } from '../../database/types.ts';
import { describeDeliveryError } from '../../services/ai/deliver-message.ts';
import { deliverInvitation } from '../../services/ai/invitation-delivery.ts';
import type { TelegramSender } from '../../services/ai/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import { botLogger } from '../../utils/logger.ts';
import { escapeHtml } from '../../utils/telegram.ts';

const deliveryLogger = botLogger.child({ module: 'picker-invitation' });

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
  /** Display name for the invitee (e.g. the picker's firstName) — labels the inviter fallback. */
  inviteeName?: string;
  /** Where the deep-link fallback goes — always the inviter's private chat, never a group. */
  fallbackChatId: number;
  /** When false, MTProto is skipped (Bot API → deep-link only). Used for group targets. */
  allowMtproto?: boolean;
  /** When true, the target is a group chat: the deep-link fallback is suppressed (a forward
   *  invite link can't be accepted on behalf of a group), so a failed Bot-API delivery reports
   *  an honest failure instead of a useless "link sent" status. */
  isGroupTarget?: boolean;
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

  let inv: ReturnType<InvitationService['sendInvitation']>;
  try {
    inv = invitationService.sendInvitation(
      params.eventId,
      params.inviter.telegram_id,
      params.inviteeId,
      params.inviteeUsername,
    );
  } catch (err) {
    // A throw here (e.g. a DB error) must not abort the whole picker batch — report this
    // invitee as an error and let the caller continue with the rest.
    deliveryLogger.error(
      { err, eventId: params.eventId, inviteeId: params.inviteeId },
      'sendInvitation threw while creating picker invitation',
    );
    return { kind: 'error', error: 'invitation could not be created' };
  }
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
    inviteeName: params.inviteeName,
    inviterId: params.inviter.telegram_id,
    inviterName: params.inviter.first_name ?? params.inviter.username ?? `User ${params.inviter.telegram_id}`,
    inviterUsername: params.inviter.username ?? undefined,
    inviterTimezone: params.inviter.timezone,
    event,
    lang: inviteeLang,
    inviterLang: (params.inviter.language ?? 'en') as 'en' | 'ru',
    fallbackChatId: params.fallbackChatId,
    allowMtproto: params.allowMtproto ?? true,
    isGroupTarget: params.isGroupTarget ?? false,
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

/** One invitee selected from the picker modal. */
export interface PickerBatchInvitee {
  userId: number;
  firstName?: string;
  username?: string;
}

export interface PickerBatchParams {
  eventId: number;
  inviter: User;
  invitees: PickerBatchInvitee[];
  lang: 'en' | 'ru';
  /** Where the deep-link fallback goes — always the inviter's private chat, never a group. */
  fallbackChatId: number;
}

/** Result lines for one invitee, in the two flavors the caller needs. */
interface PickerBatchLine {
  statusLine: string;
  aiResultLine: string;
}

function inviteeDisplayName(invitee: PickerBatchInvitee): string {
  return invitee.firstName ?? invitee.username ?? `id:${invitee.userId}`;
}

async function deliverOneForBatch(
  params: PickerBatchParams,
  invitee: PickerBatchInvitee,
  deps: PickerInvitationDeps,
): Promise<PickerBatchLine> {
  const name = inviteeDisplayName(invitee);
  // Save/update contact (deduplicates by telegram_id/username). This is a side effect — a write
  // failure must NOT cancel the invitation delivery, so it gets its own try/catch.
  try {
    deps.contactRepo?.upsert(params.inviter.telegram_id, name, invitee.username, invitee.userId);
  } catch (err) {
    deliveryLogger.warn({ err, inviteeId: invitee.userId }, 'Contact upsert failed; delivering invitation anyway');
  }
  let outcome: PickerDeliveryOutcome;
  try {
    outcome = await deliverPickerInvitation(
      {
        eventId: params.eventId,
        inviter: params.inviter,
        inviteeId: invitee.userId,
        inviteeUsername: invitee.username,
        inviteeName: name,
        fallbackChatId: params.fallbackChatId,
      },
      deps,
    );
  } catch (err) {
    // Isolate per-invitee failures so one bad invitee never aborts the rest of the batch.
    deliveryLogger.error({ err, inviteeId: invitee.userId }, 'Picker invitation delivery threw');
    outcome = { kind: 'error', error: 'delivery error' };
  }
  return {
    statusLine: pickerStatusLine(params.lang, name, outcome),
    aiResultLine: pickerAiLine(name, invitee.userId, outcome),
  };
}

/**
 * Deliver invitations to every picked invitee SERIALLY (one at a time). Serial is REQUIRED:
 * each invitee's MTProto fallback spawns scripts/send-message.py against the shared, non-WAL
 * data/voice_caller.session, and concurrent spawns corrupt that session (see CLAUDE.md
 * "voice_caller.session fragility"). Serial also avoids a 429 burst on the shared 1-CPU host.
 * Each invitee is isolated — one failure does not abort the others — and the returned lines
 * preserve the input invitee order. (Supersedes the #96 Promise.all parallelization.)
 */
export async function deliverPickerInvitations(
  params: PickerBatchParams,
  deps: PickerInvitationDeps,
): Promise<{ statusLines: string[]; aiResultLines: string[] }> {
  const lines: PickerBatchLine[] = [];
  for (const invitee of params.invitees) {
    lines.push(await deliverOneForBatch(params, invitee, deps));
  }
  return {
    statusLines: lines.map((line) => line.statusLine),
    aiResultLines: lines.map((line) => line.aiResultLine),
  };
}

/**
 * Telegram I/O for the reply-fast ack pattern, injected so the orchestrators below stay
 * unit-testable without a live GramIO context. `sendAck` posts an immediate "sending…" message
 * (and, on an edit failure, the final status as a fresh message); `editAck` rewrites that message
 * in place with the final status. Both must target the same chat AND use the same parse mode so the
 * fallback re-send renders identically to the in-place edit.
 */
export interface PickerAckIo {
  sendAck(text: string): Promise<{ message_id: number }>;
  editAck(messageId: number, text: string): Promise<void>;
}

/**
 * Edit the ack message in place with the final status. If the edit fails (the user deleted the
 * message, a 429, etc.) fall back to sending the status as a new message — the user must never be
 * left staring at "sending…". The failure is logged (never swallowed) through
 * `describeDeliveryError`, since a thrown GramIO `TelegramError` attaches the full request body —
 * the final status text, chat id, event title and invitee names — as enumerable props that pino's
 * `err` serializer would otherwise copy into the logs.
 */
async function finalizeAck(io: PickerAckIo, messageId: number, finalText: string): Promise<void> {
  try {
    await io.editAck(messageId, finalText);
  } catch (err) {
    deliveryLogger.error(
      { err: describeDeliveryError(err), messageId },
      'Failed to edit picker ack message; sending the final status as a new message',
    );
    await io.sendAck(finalText);
  }
}

/**
 * Reply-fast batch delivery for the `users_shared` picker: ack immediately with "sending…",
 * deliver to every invitee SERIALLY (see {@link deliverPickerInvitations}), then edit the ack in
 * place with the per-invitee status. Returns the AI-facing result lines verbatim so the agent
 * continuation can describe what actually happened.
 */
export async function runPickerBatchWithAck(
  params: PickerBatchParams,
  deps: PickerInvitationDeps,
  io: PickerAckIo,
): Promise<{ aiResultLines: string[] }> {
  const m = t(params.lang);
  const ack = await io.sendAck(m.invite_picker_sending);
  const { statusLines, aiResultLines } = await deliverPickerInvitations(params, deps);
  await finalizeAck(io, ack.message_id, `${m.invite_picker_header}\n${statusLines.join('\n')}`);
  return { aiResultLines };
}

export interface ChatShareAckParams {
  invitation: PickerInvitationParams;
  lang: 'en' | 'ru';
  /** Event title for the result message (HTML-escaped by {@link buildChatSharedResultText}). */
  title: string;
}

/**
 * Reply-fast group invite for the `chat_shared` picker: ack immediately with "sending…", deliver the
 * single group invitation, then edit the ack in place with the localized result. Returns the
 * delivery outcome for callers that need it.
 */
export async function runChatShareWithAck(
  params: ChatShareAckParams,
  deps: PickerInvitationDeps,
  io: PickerAckIo,
): Promise<{ outcome: PickerDeliveryOutcome }> {
  const ack = await io.sendAck(t(params.lang).invite_group_sending);
  const outcome = await deliverPickerInvitation(params.invitation, deps);
  await finalizeAck(io, ack.message_id, buildChatSharedResultText(params.lang, params.title, outcome));
  return { outcome };
}

/**
 * Build the result message for a `chat_shared` (group invite) delivery. The message is sent
 * with `parse_mode: 'HTML'`, so the event/group title AND any error string must be escaped
 * here — `pickerStatusLine` is escaping-agnostic and interpolates them verbatim.
 */
export function buildChatSharedResultText(lang: 'en' | 'ru', title: string, outcome: PickerDeliveryOutcome): string {
  const groupLabel = escapeHtml(title);
  if (outcome.kind === 'delivered') {
    return t(lang).invite_delivered(groupLabel);
  }
  const htmlSafeOutcome: PickerDeliveryOutcome =
    outcome.kind === 'error' ? { kind: 'error', error: escapeHtml(outcome.error) } : outcome;
  return pickerStatusLine(lang, groupLabel, htmlSafeOutcome);
}
