import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import { logger } from '../../utils/logger.ts';
import { decryptBlob } from './session-crypto.ts';

const checkLogger = logger.child({ module: 'master-key-check' });

export type VerifyMasterKeyResult =
  | { ok: true; reason: 'no-sessions' | 'verified' }
  | { ok: false; reason: 'mismatch'; err: Error };

export function verifyMasterKey(sessionRepo: TelegramSessionRepository, masterKey: Buffer): VerifyMasterKeyResult {
  const latest = sessionRepo.getMostRecentActive();
  if (!latest) return { ok: true, reason: 'no-sessions' };
  try {
    decryptBlob(Buffer.from(latest.encrypted_session), masterKey);
    checkLogger.info({ userId: latest.user_id }, 'Master key verified against latest session');
    return { ok: true, reason: 'verified' };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    checkLogger.error(
      { err: error, userId: latest.user_id },
      'TELEGRAM_SESSION_MASTER_KEY does not match existing sessions — refusing to start',
    );
    return { ok: false, reason: 'mismatch', err: error };
  }
}
