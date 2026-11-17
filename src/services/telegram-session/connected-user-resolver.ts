import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import { logger } from '../../utils/logger.ts';
import { decryptBlob } from '../crypto/session-crypto.ts';
import type { TelegramProfile } from './service-tier.ts';
import { SessionBridge } from './session-bridge.ts';
import { withTelegramSessionLock } from './session-lock.ts';

const resolverLogger = logger.child({ module: 'connected-user-resolver' });

/** The requester must connect their own Telegram account before this lookup can run. */
export class TelegramConnectionRequiredError extends Error {
  constructor() {
    super('The requesting user needs a Telegram connection');
    this.name = 'TelegramConnectionRequiredError';
  }
}

/** Reads one explicitly requested public profile, never another user's session or their contacts. */
export async function resolveWithConnectedUser(
  sessionRepo: TelegramSessionRepository,
  masterKey: Buffer,
  userId: number,
  username: string,
  signal?: AbortSignal,
): Promise<TelegramProfile | null> {
  const profile = await withTelegramSessionLock(
    userId,
    async () => {
      const session = sessionRepo.getActive(userId);
      if (!session) throw new TelegramConnectionRequiredError();
      let data: Buffer;
      try {
        data = decryptBlob(Buffer.from(session.encrypted_session), masterKey);
      } catch (err) {
        resolverLogger.warn({ err, userId }, 'Username lookup could not decrypt the personal session');
        if (sessionRepo.expireIfCurrent(userId, session.encrypted_session)) throw new TelegramConnectionRequiredError();
        throw new Error('The checked Telegram credential changed');
      }
      const path = await SessionBridge.createTempSessionFile(userId, data);
      try {
        signal?.throwIfAborted();
        const result = await SessionBridge.resolveUsernameAsUser(path, userId, username, signal);
        signal?.throwIfAborted();
        if (!result.success) {
          if (result.error === 'SESSION_EXPIRED' || result.error === 'SESSION_OWNER_MISMATCH') {
            if (sessionRepo.expireIfCurrent(userId, session.encrypted_session)) {
              resolverLogger.warn(
                { userId, code: result.error, reason: result.reason },
                'Personal session unusable during username lookup',
              );
              throw new TelegramConnectionRequiredError();
            }
          }
          resolverLogger.warn({ userId, error: result.error }, 'Personal username lookup unavailable');
          throw new Error('Personal username lookup unavailable');
        }
        const current = sessionRepo.getActive(userId);
        if (!current || !Buffer.from(current.encrypted_session).equals(Buffer.from(session.encrypted_session))) {
          throw new Error('The checked Telegram credential changed');
        }
        if (!('profile' in result.data)) throw new Error('Personal username lookup returned no profile');
        return result.data.profile;
      } finally {
        await SessionBridge.cleanupTempFile(path);
      }
    },
    signal,
  );
  signal?.throwIfAborted();
  return profile;
}
