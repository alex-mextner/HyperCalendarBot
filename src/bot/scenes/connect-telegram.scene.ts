// src/bot/scenes/connect-telegram.scene.ts

import { Scene } from '@gramio/scenes';
import { InlineKeyboard, Keyboard } from 'gramio';
import { maskPhone, t } from '../../config/constants.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import { decryptString, encryptBlob, encryptString } from '../../services/crypto/session-crypto.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import { buildUserSessionInvitationText } from '../../services/telegram-session/invitation-text.ts';
import { SessionBridge } from '../../services/telegram-session/session-bridge.ts';
import { formatDateShort, formatTime } from '../../utils/date.ts';
import { logger } from '../../utils/logger.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';

export interface ConnectTelegramConfig {
  TELEGRAM_SESSION_MASTER_KEY?: string;
}

const sceneLogger = logger.child({ module: 'connect-telegram-scene' });

// --- Exported helpers ---

export const PHONE_REGEX = /^\+\d{7,15}$/;
export const CODE_REGEX = /^\d{5}$/;

const CONNECT_COOLDOWN_MS = 60_000;
const connectAttempts = new Map<number, number>();

export function registerConnectAttempt(userId: number): void {
  connectAttempts.set(userId, Date.now());
}

export function isConnectCooldownActive(userId: number): boolean {
  const last = connectAttempts.get(userId);
  return last !== undefined && Date.now() - last < CONNECT_COOLDOWN_MS;
}

// --- State & Params ---

export interface ConnectTelegramState {
  /** Phone number encrypted with master key, stored as hex. Never plain text in scene storage (SQLite). */
  encryptedPhoneHex?: string;
  phoneCodeHash?: string;
  sessionPath?: string;
  codeAttempts?: number;
  passwordAttempts?: number;
}

/** Encrypt phone for safe storage in scene state (SQLite). */
function encryptPhoneForState(phone: string, masterKeyHex: string): string {
  return encryptString(phone, Buffer.from(masterKeyHex, 'hex')).toString('hex');
}

/** Decrypt phone from scene state. */
function decryptPhoneFromState(hex: string, masterKeyHex: string): string {
  return decryptString(Buffer.from(hex, 'hex'), Buffer.from(masterKeyHex, 'hex'));
}

export interface ConnectTelegramParams {
  pendingEventId?: number;
  pendingInviteeIds?: number[];
}

// --- Constants ---

const MAX_CODE_ATTEMPTS = 3;
const MAX_PASSWORD_ATTEMPTS = 3;
const CB_PREFIX = 'ct';
const CB_CONNECT = `${CB_PREFIX}:connect`;
const CB_CANCEL = `${CB_PREFIX}:cancel`;
const CB_RECONNECT = `${CB_PREFIX}:reconnect`;
const CB_SKIP_PENDING = `${CB_PREFIX}:skip_pending`;

export interface ConnectTelegramDeps {
  eventRepo: EventRepository;
  userRepo: UserRepository;
  contactRepo: ContactRepository;
  invitationService: InvitationService;
  sendAsConnectedUser?: (
    inviterId: number,
    targetId: number,
    text: string,
    username?: string,
    meta?: { invitationId?: number },
  ) => Promise<boolean>;
  deepLinkService?: DeepLinkService;
  botUsername?: string;
}

// --- Scene factory ---

export function createConnectTelegramScene(
  sessionRepo: TelegramSessionRepository,
  config: ConnectTelegramConfig,
  userComposer: UserResolverComposer,
  deps?: ConnectTelegramDeps,
) {
  return (
    new Scene('connect-telegram')
      .state<ConnectTelegramState>()
      .params<ConnectTelegramParams>()
      // extend() AFTER params() — params() uses Modify which replaces Derives.global
      .extend(userComposer)

      // Step 0: Consent
      .step(['message', 'callback_query'], async (context) => {
        const { lang } = context;
        const l = lang ?? 'en';
        const userId = context.from.id;
        const ct = t(l).connectTelegram;

        if (context.scene.step.firstTime) {
          // Check if master key is configured
          if (!config.TELEGRAM_SESSION_MASTER_KEY) {
            await context.send(ct.featureUnavailable);
            await context.scene.exit();
            return;
          }

          // Check cooldown
          if (isConnectCooldownActive(userId)) {
            const last = connectAttempts.get(userId)!;
            const remaining = Math.ceil((CONNECT_COOLDOWN_MS - (Date.now() - last)) / 1000);
            await context.send(ct.cooldown(remaining));
            await context.scene.exit();
            return;
          }

          // Check if already connected — show masked phone and reconnect option
          const existing = sessionRepo.findByUserId(userId);
          if (existing?.status === 'active') {
            const kb = new InlineKeyboard().text(ct.btnReconnect, CB_RECONNECT).text(ct.btnCancel, CB_CANCEL);
            await context.send(ct.alreadyConnected(existing.phone_masked), { reply_markup: kb });
            return;
          }

          // Show consent
          const kb = new InlineKeyboard().text(ct.btnConnect, CB_CONNECT).text(ct.btnCancel, CB_CANCEL);
          await context.send(ct.consent, { reply_markup: kb });
          return;
        }

        // Handle callbacks
        if (context.is('callback_query')) {
          const data = context.data;
          if (!data) return;

          if (data === CB_CANCEL) {
            await context.answer();
            await context.send(ct.cancelled);
            await context.scene.exit();
            return;
          }

          if (data === CB_CONNECT || data === CB_RECONNECT) {
            registerConnectAttempt(userId);
            await context.answer();
            const phoneKb = new Keyboard().requestContact(ct.btnSharePhone).resized().oneTime();
            await context.send(ct.enterPhone, { reply_markup: phoneKb });
            await context.scene.step.next();
            return;
          }
        }
      })

      // Step 1: Phone number
      // No firstTime guard — step 0→1 transition is via callback_query,
      // which doesn't match this step's 'message' filter (natural protection).
      .step('message', async (context) => {
        const { lang } = context;
        const l = lang ?? 'en';
        const userId = context.from.id;
        const ct = t(l).connectTelegram;
        const masterKeyHex = config.TELEGRAM_SESSION_MASTER_KEY;
        if (!masterKeyHex) {
          await context.send(ct.featureUnavailable);
          await context.scene.exit();
          return;
        }

        // Accept phone from shared contact or typed text; strip spaces/dashes/parens
        const raw = context.text?.trim();
        const sharedPhone = context.contact?.phoneNumber;
        const normalized = (sharedPhone ?? raw)?.replace(/[\s\-()]/g, '');
        const phone = normalized ? (normalized.startsWith('+') ? normalized : `+${normalized}`) : undefined;

        if (!phone || !PHONE_REGEX.test(phone)) {
          await context.send(ct.invalidPhone);
          return;
        }

        // Check phone_hash uniqueness — another user may have this phone
        const hash = SessionBridge.phoneHash(phone);
        const existingByHash = sessionRepo.findByPhoneHash(hash);
        if (existingByHash && existingByHash.user_id !== userId) {
          await context.send(ct.phoneAlreadyUsed);
          await context.scene.exit();
          return;
        }

        // Reserve temp session path and send code
        const sessionPath = SessionBridge.reserveEmptySessionPath(userId);
        const result = await SessionBridge.sendCode(phone, sessionPath);

        if (!result.success) {
          if (result.error === 'FLOOD_WAIT' && result.retryAfter !== undefined) {
            const minutes = Math.ceil(result.retryAfter / 60);
            await context.send(ct.floodWait(minutes));
          } else {
            sceneLogger.error({ err: new Error(result.message), userId }, 'sendCode failed');
            await context.send(ct.featureUnavailable);
          }
          await SessionBridge.cleanupTempFile(sessionPath);
          await context.scene.exit();
          return;
        }

        if (!result.data || !('phone_code_hash' in result.data)) {
          sceneLogger.error({ userId }, 'sendCode returned success but no phone_code_hash');
          await context.send(ct.featureUnavailable);
          await SessionBridge.cleanupTempFile(sessionPath);
          await context.scene.exit();
          return;
        }

        await context.scene.update({
          encryptedPhoneHex: encryptPhoneForState(phone, masterKeyHex),
          phoneCodeHash: result.data.phone_code_hash,
          sessionPath,
          codeAttempts: 0,
        });
        await context.send(ct.codeSent, { reply_markup: { remove_keyboard: true } });
        await context.scene.step.next();
      })

      // Step 2: OTP code
      .step('message', async (context) => {
        if (context.scene.step.firstTime) return;

        const { lang } = context;
        const l = lang ?? 'en';
        const userId = context.from.id;
        const ct = t(l).connectTelegram;
        const text = context.text?.trim();
        const { encryptedPhoneHex, phoneCodeHash, sessionPath, codeAttempts } = context.scene.state;

        const masterKeyHex = config.TELEGRAM_SESSION_MASTER_KEY;
        if (!encryptedPhoneHex || !phoneCodeHash || !sessionPath || !masterKeyHex) {
          sceneLogger.warn({ userId }, 'OTP step missing state or master key');
          await context.send(ct.featureUnavailable);
          await context.scene.exit();
          return;
        }

        if (!text || !CODE_REGEX.test(text)) {
          await context.send(ct.invalidCode);
          return;
        }

        const attempts = (codeAttempts ?? 0) + 1;
        await context.scene.update({ codeAttempts: attempts });

        const phone = decryptPhoneFromState(encryptedPhoneHex, masterKeyHex);
        const result = await SessionBridge.signIn(phone, text, phoneCodeHash, sessionPath);

        if (!result.success) {
          if (result.error === 'CODE_EXPIRED') {
            await context.send(ct.codeExpired);
            await SessionBridge.cleanupTempFile(sessionPath);
            await context.scene.exit();
            return;
          }

          if (attempts >= MAX_CODE_ATTEMPTS) {
            await context.send(ct.tooManyAttempts);
            await SessionBridge.cleanupTempFile(sessionPath);
            await context.scene.exit();
            return;
          }

          if (result.error === 'FLOOD_WAIT' && result.retryAfter !== undefined) {
            const minutes = Math.ceil(result.retryAfter / 60);
            await context.send(ct.floodWait(minutes));
            await SessionBridge.cleanupTempFile(sessionPath);
            await context.scene.exit();
            return;
          }

          await context.send(ct.invalidCode);
          return;
        }

        if (!result.data || !('status' in result.data)) {
          sceneLogger.error({ userId }, 'signIn returned success but no status');
          await context.send(ct.featureUnavailable);
          await SessionBridge.cleanupTempFile(sessionPath);
          await context.scene.exit();
          return;
        }

        if (result.data.status === '2fa_required') {
          await context.send(ct.enter2fa);
          await context.scene.update({ passwordAttempts: 0 });
          await context.scene.step.next();
          return;
        }

        // status === 'ok' — finalize
        const hasPending = await finalizeSession(context, sessionRepo, config, phone, sessionPath, l, deps);
        if (hasPending) {
          await context.scene.step.go(4); // Jump to pending invitation step
        }
      })

      // Step 3: 2FA password
      .step('message', async (context) => {
        if (context.scene.step.firstTime) return;

        const { lang } = context;
        const l = lang ?? 'en';
        const userId = context.from.id;
        const ct = t(l).connectTelegram;
        const text = context.text?.trim();
        const { encryptedPhoneHex, sessionPath, passwordAttempts } = context.scene.state;

        const masterKeyHex = config.TELEGRAM_SESSION_MASTER_KEY;
        if (!encryptedPhoneHex || !sessionPath || !masterKeyHex) {
          sceneLogger.warn({ userId }, '2FA step missing state or master key');
          await context.send(ct.featureUnavailable);
          await context.scene.exit();
          return;
        }

        if (!text) {
          await context.send(ct.invalid2fa);
          return;
        }

        const attempts = (passwordAttempts ?? 0) + 1;
        await context.scene.update({ passwordAttempts: attempts });

        const result = await SessionBridge.checkPassword(text, sessionPath);

        if (!result.success) {
          if (attempts >= MAX_PASSWORD_ATTEMPTS) {
            await context.send(ct.tooManyAttempts);
            await SessionBridge.cleanupTempFile(sessionPath);
            await context.scene.exit();
            return;
          }

          if (result.error === 'FLOOD_WAIT' && result.retryAfter !== undefined) {
            const minutes = Math.ceil(result.retryAfter / 60);
            await context.send(ct.floodWait(minutes));
            await SessionBridge.cleanupTempFile(sessionPath);
            await context.scene.exit();
            return;
          }

          await context.send(ct.invalid2fa);
          return;
        }

        const phone = decryptPhoneFromState(encryptedPhoneHex, masterKeyHex);
        const hasPending = await finalizeSession(context, sessionRepo, config, phone, sessionPath, l, deps);
        if (hasPending) {
          await context.scene.step.go(4); // Jump to pending invitation step
        }
      })

      // Step 4: Pending invitation callback
      .step('callback_query', async (context) => {
        const { lang } = context;
        const l = lang ?? 'en';
        const userId = context.from.id;
        const ct = t(l).connectTelegram;

        if (!context.is('callback_query')) return;
        const data = context.data;
        if (!data) return;

        if (data === CB_SKIP_PENDING) {
          await context.answer();
          await context.scene.exit();
          return;
        }

        // ct:send_all:{eventId} — batch send to all pending invitees
        if (data.startsWith(`${CB_PREFIX}:send_all:`)) {
          await context.answer();

          if (!deps) {
            sceneLogger.warn({ userId }, 'Post-connect deps not available');
            await context.send(ct.featureUnavailable);
            await context.scene.exit();
            return;
          }

          const eventId = Number.parseInt(data.split(':')[2]!, 10);
          if (Number.isNaN(eventId)) {
            sceneLogger.warn({ userId, data }, 'Invalid send_all callback data');
            await context.scene.exit();
            return;
          }

          const pending = context.scene.params;
          const inviteeIds = pending?.pendingInviteeIds ?? [];
          let sentCount = 0;

          for (const inviteeId of inviteeIds) {
            const inviteeUsername = resolveInviteeUsername(deps, userId, inviteeId);
            const result = deps.invitationService.sendInvitation(eventId, userId, inviteeId, inviteeUsername);

            if (result.success && result.invitation) {
              sentCount++;
              deliverPostConnectInvitation(deps, userId, eventId, inviteeId, inviteeUsername, result.invitation.id, l);
            } else {
              sceneLogger.warn(
                { userId, eventId, inviteeId, error: result.error },
                'Batch invitation failed for invitee',
              );
            }
          }

          sceneLogger.info(
            { userId, eventId, total: inviteeIds.length, sent: sentCount },
            'Batch post-connect invitations',
          );
          await context.send(ct.pendingSent(sentCount || inviteeIds.length));
          await context.scene.exit();
          return;
        }
      })
  );
}

// --- Helpers ---

function resolveInviteeUsername(deps: ConnectTelegramDeps, ownerUserId: number, inviteeId: number): string | undefined {
  const user = deps.userRepo.findByTelegramId(inviteeId);
  if (user?.username) return user.username;

  const contact = deps.contactRepo.findByTelegramId(ownerUserId, inviteeId);
  if (contact?.username) return contact.username;

  return undefined;
}

function resolveInviteeName(deps: ConnectTelegramDeps, ownerUserId: number, inviteeId: number): string {
  const user = deps.userRepo.findByTelegramId(inviteeId);
  if (user?.first_name) return user.first_name;
  if (user?.username) return `@${user.username}`;

  const contact = deps.contactRepo.findByTelegramId(ownerUserId, inviteeId);
  if (contact?.preferred_name) return contact.preferred_name;
  if (contact?.name) return contact.name;
  if (contact?.username) return `@${contact.username}`;

  return `User ${inviteeId}`;
}

// --- Delivery helper ---

/**
 * Fire-and-forget: sends the invitation via the user's connected Telegram session.
 * Falls back silently (invitation DB record already created, bot API delivery
 * will happen via the normal pipeline if this fails).
 */
function deliverPostConnectInvitation(
  deps: ConnectTelegramDeps,
  inviterId: number,
  eventId: number,
  inviteeId: number,
  inviteeUsername: string | undefined,
  invitationId: number,
  lang: 'en' | 'ru',
): void {
  if (!deps.sendAsConnectedUser) {
    sceneLogger.warn({ inviterId, eventId }, 'sendAsConnectedUser not available — skipping delivery');
    return;
  }

  const event = deps.eventRepo.findById(eventId, inviterId);
  if (!event) return;

  const inviter = deps.userRepo.findByTelegramId(inviterId);
  const inviterTimezone = inviter?.timezone ?? 'UTC';

  // Build deep link for the invitee to respond
  let deepLink: string | undefined;
  if (deps.deepLinkService && deps.botUsername) {
    const link = deps.deepLinkService.createInvitationLink(invitationId, eventId, inviterId);
    deepLink = deps.deepLinkService.generateUrl(link.code, deps.botUsername);
  }

  if (!deepLink) {
    sceneLogger.warn({ inviterId, eventId }, 'Deep link unavailable — skipping user-session delivery');
    return;
  }

  const text = buildUserSessionInvitationText({
    event: {
      title: event.title,
      start_utc: event.start_at,
      location: event.location,
      description: event.description,
    },
    inviterTimezone,
    deepLink,
    lang,
  });

  deps
    .sendAsConnectedUser(inviterId, inviteeId, text, inviteeUsername, { invitationId })
    .catch((err) => sceneLogger.warn({ err, inviterId, inviteeId, eventId }, 'Post-connect delivery failed'));
}

// --- Finalize helper ---

interface FinalizeContext {
  from: { id: number };
  send: (
    text: string,
    options?: { reply_markup?: InlineKeyboard; parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2' },
  ) => Promise<unknown>;
  scene: {
    exit: () => Promise<boolean> | boolean;
    params: ConnectTelegramParams;
  };
}

/**
 * Encrypts and persists the session. Returns true if a pending invitation offer was shown
 * (caller should advance to step 4 instead of exiting).
 */
async function finalizeSession(
  context: FinalizeContext,
  sessionRepo: TelegramSessionRepository,
  config: ConnectTelegramConfig,
  phone: string,
  sessionPath: string,
  lang: 'en' | 'ru',
  deps?: ConnectTelegramDeps,
): Promise<boolean> {
  const userId = context.from.id;
  const ct = t(lang).connectTelegram;

  try {
    if (!config.TELEGRAM_SESSION_MASTER_KEY) {
      await context.send(ct.featureUnavailable);
      return false;
    }
    const masterKey = Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY, 'hex');

    // Read temp session file
    const sessionFile = Bun.file(sessionPath);
    const sessionData = Buffer.from(await sessionFile.arrayBuffer());

    // Encrypt session; store only the masked phone
    const encryptedSession = encryptBlob(sessionData, masterKey);
    const phoneMasked = maskPhone(phone);
    const hash = SessionBridge.phoneHash(phone);

    // Persist
    sessionRepo.upsert(userId, encryptedSession, phoneMasked, hash);

    sceneLogger.info({ userId, phoneHash: hash }, 'Telegram account connected');

    // Check for pending invitation offer (batch — all external invitees)
    const pending = context.scene.params;
    if (deps && pending?.pendingEventId && pending.pendingInviteeIds?.length) {
      const event = deps.eventRepo.findById(pending.pendingEventId, userId);
      if (event) {
        const inviteeIds = pending.pendingInviteeIds;
        const inviteeList = inviteeIds
          .map((id) => {
            const name = resolveInviteeName(deps, userId, id);
            const username = resolveInviteeUsername(deps, userId, id);
            // @username as tg://user deep link; fallback to plain name
            return username
              ? `• <a href="tg://user?id=${id}">@${username}</a>`
              : `• <a href="tg://user?id=${id}">${name}</a>`;
          })
          .join('\n');
        const count = inviteeIds.length;
        const dateLine = `${formatDateShort(event.start_at, event.timezone, lang)} ${formatTime(event.start_at, event.timezone)}`;

        const kb = new InlineKeyboard()
          .text(ct.sendPendingBtn(count), `${CB_PREFIX}:send_all:${event.id}`)
          .row()
          .text(ct.skipPendingBtn, CB_SKIP_PENDING);

        await context.send(ct.successWithPending(phoneMasked, event.title, dateLine, inviteeList), {
          reply_markup: kb,
          parse_mode: 'HTML',
        });
        return true; // Don't exit — wait for callback
      }
    }

    // Generic success — no pending invitation
    await context.send(ct.success(phoneMasked));
    await context.scene.exit();
    return false;
  } catch (err) {
    sceneLogger.error({ err, userId }, 'Failed to finalize session');
    await context.send(ct.featureUnavailable);
    await context.scene.exit();
    return false;
  } finally {
    await SessionBridge.cleanupTempFile(sessionPath);
  }
}
