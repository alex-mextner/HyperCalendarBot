import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import { logger } from '../../utils/logger.ts';
import { decryptBlob } from '../crypto/session-crypto.ts';
import { SessionBridge } from './session-bridge.ts';

const senderLogger = logger.child({ module: 'connected-user-sender' });

interface ConnectedUserSenderDeps {
  sessionRepo: TelegramSessionRepository;
  masterKey: Buffer;
  notifLogRepo?: NotificationLogRepository;
}

interface SendMeta {
  invitationId?: number;
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
        return true;
      }

      if (result.error === 'SESSION_EXPIRED') {
        senderLogger.warn({ inviterId }, 'User Telegram session expired — marking');
        deps.sessionRepo.updateStatus(inviterId, 'expired');
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
