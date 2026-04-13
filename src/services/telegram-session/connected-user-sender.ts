import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import { logger } from '../../utils/logger.ts';
import { decryptBlob } from '../crypto/session-crypto.ts';
import { SessionBridge } from './session-bridge.ts';
import type { DetectionResult } from './timezone-detector.ts';

const senderLogger = logger.child({ module: 'connected-user-sender' });

// Rate-limit: ask for consent at most once per 24 h per user
const tzConsentAsked = new Map<number, number>();
const TZ_CONSENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface ConnectedUserSenderDeps {
  sessionRepo: TelegramSessionRepository;
  masterKey: Buffer;
  notifLogRepo?: NotificationLogRepository;
  getUserTimezone?: (userId: number) => string;
  onTimezoneDetected?: (userId: number, detection: DetectionResult) => void;
  onTzConsentNeeded?: (userId: number) => void;
  onSessionExpired?: (userId: number) => void;
}

interface SendMeta {
  invitationId?: number;
}

export async function checkTimezoneOpportunistically(
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

  const tzTempPath = await SessionBridge.createTempSessionFile(userId, sessionData);
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
  return async function sendAsConnectedUser(
    inviterId: number,
    targetId: number,
    text: string,
    username?: string,
    meta?: SendMeta,
  ): Promise<boolean> {
    const session = deps.sessionRepo.getActive(inviterId);
    if (!session) return false;

    let sessionData: Buffer;
    try {
      sessionData = decryptBlob(Buffer.from(session.encrypted_session), deps.masterKey);
    } catch (err) {
      senderLogger.error({ err, inviterId }, 'Failed to decrypt session — marking expired');
      deps.sessionRepo.updateStatus(inviterId, 'expired');
      deps.onSessionExpired?.(inviterId);
      return false;
    }

    const tempPath = await SessionBridge.createTempSessionFile(inviterId, sessionData);

    try {
      const result = await SessionBridge.sendAsUser(tempPath, targetId, text, username);

      if (result.success) {
        if (deps.notifLogRepo && meta?.invitationId !== undefined) {
          const referenceKey = `invitation_${meta.invitationId}_${targetId}_mtproto_user`;
          deps.notifLogRepo.insert({
            user_id: targetId,
            type: 'invitation_sent',
            reference_key: referenceKey,
            channel: 'mtproto_user',
            payload: text,
          });
        }

        if (deps.onTimezoneDetected || deps.onTzConsentNeeded) {
          checkTimezoneOpportunistically(deps, inviterId, sessionData).catch((err) =>
            senderLogger.warn({ err, inviterId }, 'Opportunistic timezone check failed'),
          );
        }

        return true;
      }

      if (result.error === 'SESSION_EXPIRED') {
        senderLogger.warn({ inviterId }, 'User Telegram session expired — marking');
        deps.sessionRepo.updateStatus(inviterId, 'expired');
        deps.onSessionExpired?.(inviterId);
      } else {
        senderLogger.warn({ inviterId, error: result.error }, 'sendAsConnectedUser failed');
      }
      return false;
    } catch (err) {
      senderLogger.error({ err, inviterId }, 'sendAsConnectedUser crashed');
      return false;
    } finally {
      await SessionBridge.cleanupTempFile(tempPath);
    }
  };
}
