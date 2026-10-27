// src/bot/scenes/connect-telegram.scene.ts

import { Scene } from '@gramio/scenes';
import { InlineKeyboard, Keyboard } from 'gramio';
import { type Messages, maskPhone, t } from '../../config/constants.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import { decryptString, encryptBlob, encryptString } from '../../services/crypto/session-crypto.ts';
import type { DeepLinkService } from '../../services/sharing/deep-link-service.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import { buildUserSessionInvitationText } from '../../services/telegram-session/invitation-text.ts';
import {
  type BridgeError,
  type BridgeResult,
  type BridgeSuccess,
  SessionBridge,
} from '../../services/telegram-session/session-bridge.ts';
import { formatDateShort, formatTime } from '../../utils/date.ts';
import { logger } from '../../utils/logger.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';

export interface ConnectTelegramConfig {
  TELEGRAM_SESSION_MASTER_KEY?: string;
}

const sceneLogger = logger.child({ module: 'connect-telegram-scene' });

// --- Exported helpers ---

export const CONNECT_TELEGRAM_SCENE = 'connect-telegram';
/**
 * Everything the user types while this wizard is open — phone number, login code, 2FA password —
 * is stored in chat_history as this marker only, never verbatim.
 */
export const CONNECT_WIZARD_REDACTION = '[redacted: connect wizard input]';

export const PHONE_REGEX = /^\+\d{7,15}$/;
export const CODE_REGEX = /^\d{5}$/;

const CONNECT_COOLDOWN_MS = 60_000;
const connectAttempts = new Map<number, number>();

/**
 * In-memory set of userIds whose step.next() is currently re-processing.
 * step.next() runs synchronously in the same tick, so this is safe.
 * Added before step.next(), checked+removed at the top of the receiving step.
 */
export const pendingStepTransitions = new Set<number>();

/** Strip spaces, dashes, and parentheses; ensure leading '+'. */
export function normalizePhone(raw: string): string | undefined {
  const normalized = raw.replace(/[\s\-()]/g, '');
  if (!normalized) return undefined;
  return normalized.startsWith('+') ? normalized : `+${normalized}`;
}

/** Strip spaces and dashes from OTP input (users add separators to avoid Telegram anti-phishing). */
export function normalizeOtpCode(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

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
const CB_CANCEL_AUTH = `${CB_PREFIX}:cancel_auth`;

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

// --- Ending the wizard ---

/**
 * Stop an unfinished login: kill the live MTProto auth process and remove its temp session file.
 * `state` is the wizard's scene state — read back from scene storage when the wizard ends outside
 * its own steps, hence `unknown`.
 */
export async function abortConnectAuth(userId: number, state: unknown): Promise<void> {
  SessionBridge.removeLiveAuthHandle(userId);
  const sessionPath =
    typeof state === 'object' && state !== null && 'sessionPath' in state ? state.sessionPath : undefined;
  if (typeof sessionPath === 'string') await SessionBridge.cleanupTempFile(sessionPath);
}

type ConnectTelegramText = Messages['connectTelegram'];

interface CancelAuthContext {
  answer: () => Promise<unknown>;
  send: (text: string, options?: { reply_markup?: InlineKeyboard | { remove_keyboard: true } }) => Promise<unknown>;
  from: { id: number };
  scene: {
    state: ConnectTelegramState;
    exit: () => Promise<boolean> | boolean;
  };
}

/**
 * Handle the "Cancel authorization" inline button.
 * Kills the live MTProto auth process, cleans up the temp session file, removes the
 * leftover phone-share reply keyboard and exits the scene with a fixed message. Nothing the
 * user typed into the wizard is handed on: any of it may be the phone, the code or the password.
 */
async function handleCancelAuth(context: CancelAuthContext, ct: ConnectTelegramText): Promise<void> {
  await context.answer();
  await abortConnectAuth(context.from.id, context.scene.state);
  await context.send(ct.authCancelled, { reply_markup: { remove_keyboard: true } });
  await context.scene.exit();
}

// --- Step contexts ---

interface SendOptions {
  reply_markup?: InlineKeyboard | { remove_keyboard: true };
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
}

type Send = (text: string, options?: SendOptions) => Promise<unknown>;

/** Collaborators and per-update facts every wizard step needs. */
interface StepEnv {
  sessionRepo: TelegramSessionRepository;
  config: ConnectTelegramConfig;
  deps: ConnectTelegramDeps | undefined;
  lang: 'en' | 'ru';
  userId: number;
  ct: ConnectTelegramText;
}

interface WizardSceneAccess {
  state: ConnectTelegramState;
  params: ConnectTelegramParams;
  exit: () => Promise<boolean> | boolean;
  update: (patch: Partial<ConnectTelegramState>, options?: { step?: number }) => Promise<unknown>;
  step: { next: () => Promise<void>; go: (stepId: number) => Promise<void> };
}

/** The part of a step context that can end the wizard with a message. */
interface WizardExitContext {
  send: Send;
  scene: Pick<WizardSceneAccess, 'exit'>;
}

interface ConsentCallbackContext extends WizardExitContext {
  data: string | undefined;
  answer: () => Promise<unknown>;
  send: (
    text: string,
    options?: { reply_markup?: InlineKeyboard | Keyboard | { remove_keyboard: true } },
  ) => Promise<{ delete(): Promise<unknown> }>;
  scene: Pick<WizardSceneAccess, 'exit'> & { step: Pick<WizardSceneAccess['step'], 'next'> };
}

interface AuthCallbackContext extends CancelAuthContext {
  data: string | undefined;
}

/** A message update inside a wizard step (callback updates are routed elsewhere). */
interface WizardMessageContext {
  from: { id: number };
  text: string | undefined;
  contact: { phoneNumber: string } | undefined;
  send: Send;
  scene: WizardSceneAccess;
}

interface PendingInvitationContext extends WizardExitContext {
  data: string | undefined;
  answer: () => Promise<unknown>;
  scene: Pick<WizardSceneAccess, 'exit' | 'params'>;
}

// --- Scene factory ---

export function createConnectTelegramScene(
  sessionRepo: TelegramSessionRepository,
  config: ConnectTelegramConfig,
  userComposer: UserResolverComposer,
  deps?: ConnectTelegramDeps,
) {
  const envFor = (lang: 'en' | 'ru' | undefined, userId: number): StepEnv => {
    const l = lang ?? 'en';
    return { sessionRepo, config, deps, lang: l, userId, ct: t(l).connectTelegram };
  };

  return (
    new Scene(CONNECT_TELEGRAM_SCENE)
      .state<ConnectTelegramState>()
      .params<ConnectTelegramParams>()
      // extend() AFTER params() — params() uses Modify which replaces Derives.global
      .extend(userComposer)

      // Step 0: Consent
      .step(['message', 'callback_query'], async (context) => {
        const env = envFor(context.lang, context.from.id);
        if (context.scene.step.firstTime) {
          await showConsent(context, env);
        } else if (context.is('callback_query')) {
          await handleConsentCallback(context, env);
        }
        // Text typed before "Connect" goes nowhere; the connect-wizard guard has taken it off the chat.
      })

      // Step 1: Phone number
      .step(['message', 'callback_query'], async (context) => {
        const env = envFor(context.lang, context.from.id);
        if (context.is('callback_query')) {
          await handleAuthCallback(context, env.ct);
          return;
        }
        await handlePhoneStep(context, env);
      })

      // Step 2: OTP code
      .step(['message', 'callback_query'], async (context) => {
        const env = envFor(context.lang, context.from.id);
        if (context.is('callback_query')) {
          await handleAuthCallback(context, env.ct);
          return;
        }
        await handleCodeStep(context, env);
      })

      // Step 3: 2FA password
      .step(['message', 'callback_query'], async (context) => {
        const env = envFor(context.lang, context.from.id);
        if (context.is('callback_query')) {
          await handleAuthCallback(context, env.ct);
          return;
        }
        await handlePasswordStep(context, env);
      })

      // Step 4: Pending invitation callback
      .step('callback_query', async (context) => {
        if (!context.is('callback_query')) return;
        await handlePendingInvitationStep(context, envFor(context.lang, context.from.id));
      })
  );
}

// --- Step handlers ---

/** Ends the wizard with `message`, first dropping whatever login state is still alive. */
async function abortWizardWith(
  context: WizardExitContext,
  message: string,
  cleanup: { sessionPath?: string; dropLiveAuthOf?: number } = {},
): Promise<void> {
  await context.send(message);
  if (cleanup.dropLiveAuthOf !== undefined) SessionBridge.removeLiveAuthHandle(cleanup.dropLiveAuthOf);
  if (cleanup.sessionPath) await SessionBridge.cleanupTempFile(cleanup.sessionPath);
  await context.scene.exit();
}

/** Re-prompts for the same credential, keeping the "Cancel authorization" button on the prompt. */
async function promptWithCancel(context: WizardExitContext, ct: ConnectTelegramText, text: string): Promise<void> {
  const kb = new InlineKeyboard().text(ct.btnCancelAuth, CB_CANCEL_AUTH);
  await context.send(text, { reply_markup: kb });
}

function floodWaitMinutes(result: BridgeError): number | undefined {
  return result.error === 'FLOOD_WAIT' && result.retryAfter !== undefined
    ? Math.ceil(result.retryAfter / 60)
    : undefined;
}

async function handleAuthCallback(context: AuthCallbackContext, ct: ConnectTelegramText): Promise<void> {
  if (context.data === CB_CANCEL_AUTH) await handleCancelAuth(context, ct);
}

async function showConsent(context: WizardExitContext, env: StepEnv): Promise<void> {
  const { ct, userId, config, sessionRepo } = env;
  if (!config.TELEGRAM_SESSION_MASTER_KEY) {
    await abortWizardWith(context, ct.featureUnavailable);
    return;
  }
  const lastAttempt = connectAttempts.get(userId);
  if (isConnectCooldownActive(userId) && lastAttempt !== undefined) {
    const remaining = Math.ceil((CONNECT_COOLDOWN_MS - (Date.now() - lastAttempt)) / 1000);
    await abortWizardWith(context, ct.cooldown(remaining));
    return;
  }
  // Already connected — show the masked phone and the reconnect option
  const existing = sessionRepo.findByUserId(userId);
  if (existing?.status === 'active') {
    const kb = new InlineKeyboard().text(ct.btnReconnect, CB_RECONNECT).text(ct.btnCancel, CB_CANCEL);
    await context.send(ct.alreadyConnected(existing.phone_masked), { reply_markup: kb });
    return;
  }
  const kb = new InlineKeyboard().text(ct.btnConnect, CB_CONNECT).text(ct.btnCancel, CB_CANCEL);
  await context.send(ct.consent, { reply_markup: kb });
}

async function handleConsentCallback(context: ConsentCallbackContext, env: StepEnv): Promise<void> {
  const { data } = context;
  if (data === CB_CANCEL) {
    await context.answer();
    await context.send(env.ct.cancelled);
    await context.scene.exit();
  } else if (data === CB_CONNECT || data === CB_RECONNECT) {
    registerConnectAttempt(env.userId);
    await context.answer();
    await askForPhone(context, env);
  }
}

async function askForPhone(context: ConsentCallbackContext, env: StepEnv): Promise<void> {
  const { ct, userId } = env;
  const phoneKb = new Keyboard().requestContact(ct.btnSharePhone).resized().oneTime();
  // Telegram persists the reply-keyboard at chat level (not per message),
  // so we install it via a throwaway message and delete that message
  // immediately. The "📱 Поделиться номером" button stays in the input area.
  // This frees the visible prompt to carry the inline "Отменить авторизацию"
  // button instead of shipping it as a separate second message.
  const kbMsg = await context.send('…', { reply_markup: phoneKb });
  kbMsg
    .delete()
    .catch((err: unknown) => sceneLogger.warn({ err, userId }, 'failed to delete throwaway reply-keyboard message'));
  const cancelKb = new InlineKeyboard().text(ct.btnCancelAuth, CB_CANCEL_AUTH);
  await context.send(ct.enterPhone, { reply_markup: cancelKb });
  await context.scene.step.next();
}

/** A shared contact or typed text, normalised; undefined when it is not a usable phone number. */
function readPhoneInput(context: WizardMessageContext): string | undefined {
  const phoneInput = context.contact?.phoneNumber ?? context.text?.trim();
  const phone = phoneInput ? normalizePhone(phoneInput) : undefined;
  return phone && PHONE_REGEX.test(phone) ? phone : undefined;
}

/** The user-facing failure for a send-code attempt, or undefined when the code was sent. */
function sendCodeFailure(result: BridgeResult, ct: ConnectTelegramText, userId: number): string | undefined {
  if (!result.success) {
    const minutes = floodWaitMinutes(result);
    if (minutes !== undefined) return ct.floodWait(minutes);
    sceneLogger.error({ err: new Error(result.message), userId }, 'sendCode failed');
    return ct.featureUnavailable;
  }
  if (!result.data || !('phone_code_hash' in result.data)) {
    sceneLogger.error({ userId }, 'sendCode returned success but no phone_code_hash');
    return ct.featureUnavailable;
  }
  return undefined;
}

async function handlePhoneStep(context: WizardMessageContext, env: StepEnv): Promise<void> {
  const { ct, userId, sessionRepo } = env;
  const masterKeyHex = env.config.TELEGRAM_SESSION_MASTER_KEY;
  if (!masterKeyHex) {
    await abortWizardWith(context, ct.featureUnavailable);
    return;
  }

  // Accept phone from shared contact or typed text (the connect-wizard guard took the text off the chat)
  const phone = readPhoneInput(context);
  if (!phone) {
    await promptWithCancel(context, ct, ct.invalidPhone);
    return;
  }

  // Check phone_hash uniqueness — another user may have this phone
  const existingByHash = sessionRepo.findByPhoneHash(SessionBridge.phoneHash(phone));
  if (existingByHash && existingByHash.user_id !== userId) {
    await abortWizardWith(context, ct.phoneAlreadyUsed);
    return;
  }

  // Immediate feedback: remove keyboard + show progress
  await context.send(ct.sendingCode, { reply_markup: { remove_keyboard: true } });

  // Single long-lived process: send_code now, sign_in later via stdin
  const sessionPath = SessionBridge.reserveEmptySessionPath(userId);
  const result = await SessionBridge.spawnSendAndSign(phone, sessionPath, userId);
  const failure = sendCodeFailure(result, ct, userId);
  if (failure) {
    await abortWizardWith(context, failure, { sessionPath });
    return;
  }

  await context.scene.update(
    { encryptedPhoneHex: encryptPhoneForState(phone, masterKeyHex), sessionPath, codeAttempts: 0 },
    { step: undefined },
  );
  await context.send(ct.codeSent);
  pendingStepTransitions.add(userId);
  await context.scene.step.next();
}

/** Decrypts the phone and finishes the login; a pending invitation offer moves the wizard to step 4. */
async function finishLogin(
  context: WizardMessageContext,
  env: StepEnv,
  stored: { encryptedPhoneHex: string; masterKeyHex: string; sessionPath: string },
): Promise<void> {
  const phone = decryptPhoneFromState(stored.encryptedPhoneHex, stored.masterKeyHex);
  const hasPending = await finalizeSession(
    context,
    env.sessionRepo,
    env.config,
    phone,
    stored.sessionPath,
    env.lang,
    env.deps,
  );
  if (hasPending) {
    await context.scene.step.go(4); // Jump to pending invitation step
  }
}

async function handleCodeRejected(
  context: WizardMessageContext,
  env: StepEnv,
  result: BridgeError,
  attempts: number,
  sessionPath: string,
): Promise<void> {
  const { ct } = env;
  const minutes = floodWaitMinutes(result);
  let abortMessage: string | undefined;
  if (result.error === 'CODE_EXPIRED') abortMessage = ct.codeExpired;
  else if (attempts >= MAX_CODE_ATTEMPTS) abortMessage = ct.tooManyAttempts;
  else if (minutes !== undefined) abortMessage = ct.floodWait(minutes);
  if (abortMessage === undefined) await promptWithCancel(context, ct, ct.invalidCode);
  else await abortWizardWith(context, abortMessage, { sessionPath });
}

async function handleCodeAccepted(
  context: WizardMessageContext,
  env: StepEnv,
  result: BridgeSuccess,
  stored: { encryptedPhoneHex: string; masterKeyHex: string; sessionPath: string },
): Promise<void> {
  const { ct, userId } = env;
  if (!result.data || !('status' in result.data)) {
    sceneLogger.error({ userId }, 'signIn returned success but no status');
    await abortWizardWith(context, ct.featureUnavailable, { sessionPath: stored.sessionPath });
    return;
  }
  if (result.data.status === '2fa_required') {
    await promptWithCancel(context, ct, ct.enter2fa);
    await context.scene.update({ passwordAttempts: 0 }, { step: undefined });
    pendingStepTransitions.add(userId);
    await context.scene.step.next();
    return;
  }
  // status === 'ok' — finalize
  await finishLogin(context, env, stored);
}

async function handleCodeStep(context: WizardMessageContext, env: StepEnv): Promise<void> {
  const { ct, userId } = env;
  // Fallback: contact shares are never OTP codes
  // onNext in compose() persists the step unconditionally after all middleware runs
  if (pendingStepTransitions.delete(userId) || context.contact) return;

  const { encryptedPhoneHex, sessionPath, codeAttempts } = context.scene.state;
  const masterKeyHex = env.config.TELEGRAM_SESSION_MASTER_KEY;
  if (!encryptedPhoneHex || !sessionPath || !masterKeyHex) {
    sceneLogger.warn({ userId }, 'OTP step missing state or master key');
    await abortWizardWith(context, ct.featureUnavailable);
    return;
  }

  // Normalize: user enters "1 2 3 4 5" or "12-345" to avoid Telegram anti-phishing
  const text = context.text?.trim();
  const code = text ? normalizeOtpCode(text) : undefined;
  if (!code || !CODE_REGEX.test(code)) {
    await promptWithCancel(context, ct, ct.invalidCode);
    return;
  }

  const attempts = (codeAttempts ?? 0) + 1;
  await context.scene.update({ codeAttempts: attempts }, { step: undefined });

  // Use the live auth handle (same MTProto session as send_code)
  const handle = SessionBridge.getLiveAuthHandle(userId);
  if (!handle) {
    sceneLogger.warn({ userId }, 'No live auth handle — session expired, must start over');
    await abortWizardWith(context, ct.codeExpired, { sessionPath });
    return;
  }
  const result = await handle.submitCode(code);
  if (result.success) await handleCodeAccepted(context, env, result, { encryptedPhoneHex, masterKeyHex, sessionPath });
  else await handleCodeRejected(context, env, result, attempts, sessionPath);
}

async function handlePasswordRejected(
  context: WizardMessageContext,
  env: StepEnv,
  result: BridgeError,
  attempts: number,
  sessionPath: string,
): Promise<void> {
  const { ct, userId } = env;
  const minutes = floodWaitMinutes(result);
  let abortMessage: string | undefined;
  if (attempts >= MAX_PASSWORD_ATTEMPTS) abortMessage = ct.tooManyAttempts;
  else if (minutes !== undefined) abortMessage = ct.floodWait(minutes);
  if (abortMessage === undefined) await promptWithCancel(context, ct, ct.invalid2fa);
  else await abortWizardWith(context, abortMessage, { sessionPath, dropLiveAuthOf: userId });
}

async function handlePasswordStep(context: WizardMessageContext, env: StepEnv): Promise<void> {
  const { ct, userId } = env;
  if (pendingStepTransitions.delete(userId)) return;
  const text = context.text?.trim();
  // Fallback: if text looks like an OTP code (digits with optional spaces/dashes), it's re-processing
  const maybeOtp = text ? normalizeOtpCode(text) : undefined;
  if (maybeOtp && CODE_REGEX.test(maybeOtp)) return;

  const { encryptedPhoneHex, sessionPath, passwordAttempts } = context.scene.state;
  const masterKeyHex = env.config.TELEGRAM_SESSION_MASTER_KEY;
  if (!encryptedPhoneHex || !sessionPath || !masterKeyHex) {
    sceneLogger.warn({ userId }, '2FA step missing state or master key');
    await abortWizardWith(context, ct.featureUnavailable);
    return;
  }

  if (!text) {
    await promptWithCancel(context, ct, ct.invalid2fa);
    return;
  }

  // Use the same live auth handle — same Python process and MTProto connection
  // that did send_code + sign_in. No new process = no session_empty overwrite.
  const handle = SessionBridge.getLiveAuthHandle(userId);
  if (!handle) {
    sceneLogger.warn({ userId }, 'No live auth handle for 2FA — session expired, must start over');
    await abortWizardWith(context, ct.codeExpired, { sessionPath });
    return;
  }

  const attempts = (passwordAttempts ?? 0) + 1;
  await context.scene.update({ passwordAttempts: attempts }, { step: undefined });

  const result = await handle.submitPassword(text);
  if (result.success) await finishLogin(context, env, { encryptedPhoneHex, masterKeyHex, sessionPath });
  else await handlePasswordRejected(context, env, result, attempts, sessionPath);
}

/** Sends the pending invitation to every invitee; returns how many were created. */
function sendPendingInvitations(
  deps: ConnectTelegramDeps,
  userId: number,
  eventId: number,
  inviteeIds: number[],
  lang: 'en' | 'ru',
): number {
  let sentCount = 0;
  for (const inviteeId of inviteeIds) {
    const inviteeUsername = resolveInviteeUsername(deps, userId, inviteeId);
    const result = deps.invitationService.sendInvitation(eventId, userId, inviteeId, inviteeUsername);

    if (result.success && result.invitation) {
      sentCount++;
      deliverPostConnectInvitation(deps, userId, eventId, inviteeId, inviteeUsername, result.invitation.id, lang);
    } else {
      sceneLogger.warn({ userId, eventId, inviteeId, error: result.error }, 'Batch invitation failed for invitee');
    }
  }
  return sentCount;
}

async function handlePendingInvitationStep(context: PendingInvitationContext, env: StepEnv): Promise<void> {
  const { data } = context;
  if (!data) return;

  if (data === CB_SKIP_PENDING) {
    await context.answer();
    await context.scene.exit();
    return;
  }

  // ct:send_all:{eventId} — batch send to all pending invitees
  if (!data.startsWith(`${CB_PREFIX}:send_all:`)) return;
  await context.answer();

  const { deps, ct, userId } = env;
  if (!deps) {
    sceneLogger.warn({ userId }, 'Post-connect deps not available');
    await abortWizardWith(context, ct.featureUnavailable);
    return;
  }

  const eventId = Number.parseInt(data.split(':')[2]!, 10);
  if (Number.isNaN(eventId)) {
    sceneLogger.warn({ userId, data }, 'Invalid send_all callback data');
    await context.scene.exit();
    return;
  }

  const inviteeIds = context.scene.params?.pendingInviteeIds ?? [];
  const sentCount = sendPendingInvitations(deps, userId, eventId, inviteeIds, env.lang);
  sceneLogger.info({ userId, eventId, total: inviteeIds.length, sent: sentCount }, 'Batch post-connect invitations');
  await context.send(ct.pendingSent(sentCount || inviteeIds.length));
  await context.scene.exit();
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

  const text = buildUserSessionInvitationText({ event, inviterTimezone, deepLink, lang });

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
