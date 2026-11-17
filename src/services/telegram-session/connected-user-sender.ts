import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import { logger } from '../../utils/logger.ts';
import { decryptBlob } from '../crypto/session-crypto.ts';
import { type BridgeError, SessionBridge } from './session-bridge.ts';
import { withTelegramSessionLock } from './session-lock.ts';
import type { DetectionResult } from './timezone-detector.ts';

const senderLogger = logger.child({ module: 'connected-user-sender' });

// Rate-limit: ask for consent at most once per 24 h per user
const tzConsentAsked = new Map<number, number>();
const TZ_CONSENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Rate-limit: max sends per hour per user to prevent FloodWait from Telegram
const SEND_RATE_LIMIT = 10;
const SEND_RATE_WINDOW_MS = 60 * 60 * 1000;
const sendCounts = new Map<number, { count: number; windowStart: number }>();

export function isRateLimited(userId: number): boolean {
  const now = Date.now();
  const entry = sendCounts.get(userId);
  if (!entry || now - entry.windowStart > SEND_RATE_WINDOW_MS) {
    sendCounts.set(userId, { count: 1, windowStart: now });
    return false;
  }
  if (entry.count >= SEND_RATE_LIMIT) return true;
  entry.count++;
  return false;
}

export interface ConnectedUserSenderDeps {
  sessionRepo: TelegramSessionRepository;
  masterKey: Buffer;
  notifLogRepo?: NotificationLogRepository;
  getUserTimezone?: (userId: number) => string;
  onTimezoneDetected?: (userId: number, detection: DetectionResult) => void;
  onTzConsentNeeded?: (userId: number) => void;
  onSessionExpired?: (userId: number, reason?: import('./session-loss.ts').SessionLossReason) => void;
}

interface SendMeta {
  invitationId?: number;
  signal?: AbortSignal;
}

export async function checkTimezoneOpportunistically(
  deps: ConnectedUserSenderDeps,
  userId: number,
  sessionData: Buffer,
): Promise<void> {
  return withTelegramSessionLock(userId, () => checkTimezoneWithCurrentSession(deps, userId, sessionData));
}

async function checkTimezoneWithCurrentSession(
  deps: ConnectedUserSenderDeps,
  userId: number,
  sessionData: Buffer,
): Promise<void> {
  const session = deps.sessionRepo.getActive(userId);
  if (!session) return;

  if (session.tz_detection_consent_at === null) {
    if (deps.onTzConsentNeeded) {
      const lastAsked = tzConsentAsked.get(userId) ?? 0;
      if (Date.now() - lastAsked >= TZ_CONSENT_COOLDOWN_MS) {
        tzConsentAsked.set(userId, Date.now());
        deps.onTzConsentNeeded(userId);
      }
    }
    return;
  }

  if (session.tz_detection_consent_at === 'never') return;

  const currentData = decryptBlob(Buffer.from(session.encrypted_session), deps.masterKey);
  if (!currentData.equals(sessionData)) return;
  const tzTempPath = await SessionBridge.createTempSessionFile(userId, currentData);
  try {
    const authResult = await SessionBridge.getAuthorizations(tzTempPath);
    if (!authResult.success || !('authorizations' in authResult.data)) return;

    const { detectTimezoneFromAuthorizations } = await import('./timezone-detector.ts');
    const currentTz = deps.getUserTimezone?.(userId) ?? 'UTC';
    const detection = detectTimezoneFromAuthorizations(authResult.data.authorizations, currentTz);
    if (!detection) return;

    deps.onTimezoneDetected?.(userId, detection);
  } finally {
    await SessionBridge.cleanupTempFile(tzTempPath);
  }
}

export function createConnectedUserSender(deps: ConnectedUserSenderDeps) {
  /** undefined when the stored session cannot be decrypted; it is then marked expired. */
  function decryptSession(inviterId: number, encryptedSession: Buffer): Buffer | undefined {
    try {
      return decryptBlob(Buffer.from(encryptedSession), deps.masterKey);
    } catch (err) {
      senderLogger.error({ err, inviterId }, 'Failed to decrypt session — marking expired');
      if (deps.sessionRepo.expireIfCurrent(inviterId, encryptedSession)) {
        deps.onSessionExpired?.(inviterId, 'local');
      }
      return undefined;
    }
  }

  /**
   * Bookkeeping for a message that already went out, so nothing here may turn the send into a
   * failure: the caller would then hand the inviter a forward link for an invitation the invitee
   * already has. The send-log row belongs to the session owner (the /tg-sessions stats read it by
   * owner); the invitee may never have started the bot and so has no users row to reference.
   */
  function afterSuccessfulSend(
    inviterId: number,
    targetId: number,
    text: string,
    sessionData: Buffer,
    meta: SendMeta | undefined,
  ): void {
    if (deps.notifLogRepo && meta?.invitationId !== undefined) {
      try {
        const logId = deps.notifLogRepo.insert({
          user_id: inviterId,
          type: 'invitation_sent',
          reference_key: `invitation_${meta.invitationId}_${targetId}_mtproto_user`,
          channel: 'mtproto_user',
          payload: text,
        });
        // The message is already out; a row left at the default 'queued' would say otherwise.
        if (logId !== null) deps.notifLogRepo.markSent(logId);
      } catch (err) {
        senderLogger.warn(
          { err, inviterId, invitationId: meta.invitationId },
          'Sent as the connected user, but the send log was not written',
        );
      }
    }

    if (deps.onTimezoneDetected || deps.onTzConsentNeeded) {
      checkTimezoneOpportunistically(deps, inviterId, sessionData).catch((err) =>
        senderLogger.warn({ err, inviterId }, 'Opportunistic timezone check failed'),
      );
    }
  }

  function afterFailedSend(inviterId: number, encryptedSession: Buffer, result: BridgeError): void {
    if (result.error !== 'SESSION_EXPIRED') {
      senderLogger.warn({ inviterId, error: result.error }, 'sendAsConnectedUser failed');
      return;
    }
    senderLogger.warn({ inviterId }, 'User Telegram session expired — marking');
    if (deps.sessionRepo.expireIfCurrent(inviterId, encryptedSession)) {
      deps.onSessionExpired?.(inviterId, result.reason ?? 'expired');
    }
  }

  return async function sendAsConnectedUser(
    inviterId: number,
    targetId: number,
    text: string,
    username?: string,
    meta?: SendMeta,
  ): Promise<boolean> {
    return withTelegramSessionLock(
      inviterId,
      async () => {
        if (isRateLimited(inviterId)) {
          senderLogger.warn({ inviterId, targetId }, 'Personal-account sending is rate-limited');
          return false;
        }

        const session = deps.sessionRepo.getActive(inviterId);
        if (!session) return false;

        const sessionData = decryptSession(inviterId, session.encrypted_session);
        if (!sessionData) return false;

        const tempPath = await SessionBridge.createTempSessionFile(inviterId, sessionData);

        try {
          meta?.signal?.throwIfAborted();
          const result = await SessionBridge.sendAsUser(tempPath, targetId, text, username);
          if (result.success) {
            afterSuccessfulSend(inviterId, targetId, text, sessionData, meta);
            return true;
          }
          meta?.signal?.throwIfAborted();
          afterFailedSend(inviterId, session.encrypted_session, result);
          return false;
        } catch (err) {
          meta?.signal?.throwIfAborted();
          senderLogger.error({ err, inviterId }, 'sendAsConnectedUser crashed');
          return false;
        } finally {
          try {
            await SessionBridge.cleanupTempFile(tempPath);
          } catch (err) {
            senderLogger.warn({ err, inviterId }, 'Temporary session cleanup failed after the send attempt');
          }
        }
      },
      meta?.signal,
    );
  };
}
