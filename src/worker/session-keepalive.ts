import type { TelegramSessionRepository } from '../database/repositories/telegram-session.repository.ts';
import { decryptBlob } from '../services/crypto/session-crypto.ts';
import { SessionBridge } from '../services/telegram-session/session-bridge.ts';
import { logger } from '../utils/logger.ts';

const keepaliveLogger = logger.child({ module: 'session-keepalive' });

const RATE_LIMIT_MS = 5_000;

export interface SessionKeepaliveResult {
  checked: number;
  expired: number;
}

export interface SessionKeepaliveDeps {
  sessionRepo: TelegramSessionRepository;
  masterKey: Buffer;
  onSessionExpired?: (userId: number) => void;
  rateLimitMs?: number;
  /** Injected for testing — defaults to real implementations. */
  decrypt?: (blob: Buffer, key: Buffer) => Buffer;
  createTempFile?: (userId: number, data: Buffer) => Promise<string>;
  getAuthorizations?: (path: string) => Promise<import('../services/telegram-session/session-bridge.ts').BridgeResult>;
  cleanupFile?: (path: string) => Promise<void>;
}

export async function processSessionKeepalive(deps: SessionKeepaliveDeps): Promise<SessionKeepaliveResult> {
  const decrypt = deps.decrypt ?? decryptBlob;
  const createTemp = deps.createTempFile ?? SessionBridge.createTempSessionFile;
  const getAuths = deps.getAuthorizations ?? SessionBridge.getAuthorizations;
  const cleanup = deps.cleanupFile ?? SessionBridge.cleanupTempFile;

  const sessions = deps.sessionRepo.getAllActive();
  const delayMs = deps.rateLimitMs ?? RATE_LIMIT_MS;
  let expired = 0;
  let isFirst = true;

  keepaliveLogger.info({ total: sessions.length }, 'Session keepalive started');

  for (const session of sessions) {
    if (!isFirst) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    isFirst = false;

    try {
      const sessionData = decrypt(Buffer.from(session.encrypted_session), deps.masterKey);
      const tempPath = await createTemp(session.user_id, sessionData);
      try {
        const result = await getAuths(tempPath);
        if (!result.success && result.error === 'SESSION_EXPIRED') {
          deps.sessionRepo.updateStatus(session.user_id, 'expired');
          deps.onSessionExpired?.(session.user_id);
          expired++;
          keepaliveLogger.info({ userId: session.user_id }, 'Session marked expired during keepalive');
        } else if (!result.success) {
          keepaliveLogger.warn({ userId: session.user_id, error: result.error }, 'getAuthorizations returned error');
        }
      } finally {
        await cleanup(tempPath);
      }
    } catch (err) {
      keepaliveLogger.warn({ err, userId: session.user_id }, 'Session keepalive check failed');
    }
  }

  keepaliveLogger.info({ checked: sessions.length, expired }, 'Session keepalive finished');
  return { checked: sessions.length, expired };
}
