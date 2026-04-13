// src/bot/scenes/connect-telegram.scene.ts

import { Scene } from '@gramio/scenes';
import { InlineKeyboard } from 'gramio';
import { maskPhone, t } from '../../config/constants.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import { decryptString, encryptBlob, encryptString } from '../../services/crypto/session-crypto.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
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
  phone?: string;
  phoneCodeHash?: string;
  sessionPath?: string;
  codeAttempts?: number;
  passwordAttempts?: number;
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
            const masterKey = Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY, 'hex');
            try {
              const phone = decryptString(existing.encrypted_phone, masterKey);
              const masked = maskPhone(phone);
              const kb = new InlineKeyboard().text(ct.btnReconnect, CB_RECONNECT).text(ct.btnCancel, CB_CANCEL);
              await context.send(ct.alreadyConnected(masked), { reply_markup: kb });
            } catch (err) {
              sceneLogger.warn({ err, userId }, 'Failed to decrypt existing phone for display');
              const kb = new InlineKeyboard().text(ct.btnReconnect, CB_RECONNECT).text(ct.btnCancel, CB_CANCEL);
              await context.send(ct.alreadyConnected('+••• ••••'), { reply_markup: kb });
            }
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
            await context.send(ct.enterPhone);
            await context.scene.step.next();
            return;
          }
        }
      })

      // Step 1: Phone number
      .step('message', async (context) => {
        const { lang } = context;
        const l = lang ?? 'en';
        const userId = context.from.id;
        const ct = t(l).connectTelegram;
        const text = context.text?.trim();

        if (!text || !PHONE_REGEX.test(text)) {
          await context.send(ct.invalidPhone);
          return;
        }

        const phone = text;

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
          phone,
          phoneCodeHash: result.data.phone_code_hash,
          sessionPath,
          codeAttempts: 0,
        });
        await context.send(ct.codeSent);
        await context.scene.step.next();
      })

      // Step 2: OTP code
      .step('message', async (context) => {
        const { lang } = context;
        const l = lang ?? 'en';
        const userId = context.from.id;
        const ct = t(l).connectTelegram;
        const text = context.text?.trim();
        const { phone, phoneCodeHash, sessionPath, codeAttempts } = context.scene.state;

        if (!phone || !phoneCodeHash || !sessionPath) {
          sceneLogger.warn({ userId }, 'OTP step missing state');
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
        const { lang } = context;
        const l = lang ?? 'en';
        const userId = context.from.id;
        const ct = t(l).connectTelegram;
        const text = context.text?.trim();
        const { phone, sessionPath, passwordAttempts } = context.scene.state;

        if (!phone || !sessionPath) {
          sceneLogger.warn({ userId }, '2FA step missing state');
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

        // ct:send_pending:{eventId}:{inviteeId}
        if (data.startsWith(`${CB_PREFIX}:send_pending:`)) {
          await context.answer();

          if (!deps) {
            sceneLogger.warn({ userId }, 'Post-connect deps not available');
            await context.send(ct.featureUnavailable);
            await context.scene.exit();
            return;
          }

          const parts = data.split(':');
          const eventId = Number.parseInt(parts[2]!, 10);
          const inviteeId = Number.parseInt(parts[3]!, 10);

          if (Number.isNaN(eventId) || Number.isNaN(inviteeId)) {
            sceneLogger.warn({ userId, data }, 'Invalid pending callback data');
            await context.scene.exit();
            return;
          }

          const inviteeUsername = resolveInviteeUsername(deps, userId, inviteeId);
          const result = deps.invitationService.sendInvitation(eventId, userId, inviteeId, inviteeUsername);

          if (result.success) {
            sceneLogger.info({ userId, eventId, inviteeId }, 'Post-connect invitation created');
            await context.send(ct.pendingSent);
          } else {
            sceneLogger.warn({ userId, eventId, inviteeId, error: result.error }, 'Post-connect invitation failed');
            // Still show success message — the invitation might already exist
            await context.send(ct.pendingSent);
          }

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

// --- Finalize helper ---

interface FinalizeContext {
  from: { id: number };
  send: (text: string, options?: { reply_markup?: InlineKeyboard }) => Promise<unknown>;
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

    // Encrypt session and phone
    const encryptedSession = encryptBlob(sessionData, masterKey);
    const encryptedPhone = encryptString(phone, masterKey);
    const hash = SessionBridge.phoneHash(phone);

    // Persist
    sessionRepo.upsert(userId, encryptedSession, encryptedPhone, hash);

    const masked = maskPhone(phone);
    sceneLogger.info({ userId, phoneHash: hash }, 'Telegram account connected');

    // Check for pending invitation offer
    const pending = context.scene.params;
    if (deps && pending?.pendingEventId && pending.pendingInviteeIds?.length) {
      const event = deps.eventRepo.findById(pending.pendingEventId, userId);
      if (event) {
        const firstInviteeId = pending.pendingInviteeIds[0]!;
        const inviteeName = resolveInviteeName(deps, userId, firstInviteeId);
        const dateLine = `${formatDateShort(event.start_at, event.timezone, lang)} ${formatTime(event.start_at, event.timezone)}`;

        const kb = new InlineKeyboard()
          .text(ct.sendPendingBtn, `${CB_PREFIX}:send_pending:${event.id}:${firstInviteeId}`)
          .text(ct.skipPendingBtn, CB_SKIP_PENDING);

        await context.send(ct.successWithPending(masked, event.title, dateLine, inviteeName), { reply_markup: kb });
        return true; // Don't exit — wait for callback
      }
    }

    // Generic success — no pending invitation
    await context.send(ct.success(masked));
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
