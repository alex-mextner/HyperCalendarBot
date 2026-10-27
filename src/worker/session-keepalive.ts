import type { TelegramSessionRepository } from '../database/repositories/telegram-session.repository.ts';
import type { TelegramSession } from '../database/types.ts';
import { decryptBlob } from '../services/crypto/session-crypto.ts';
import { type BridgeResult, SessionBridge } from '../services/telegram-session/session-bridge.ts';
import type { SessionLossReason } from '../services/telegram-session/session-loss.ts';
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
  onSessionExpired?: (userId: number, reason?: SessionLossReason) => void;
  rateLimitMs?: number;
  /** Injected for testing — defaults to real implementations. */
  decrypt?: (blob: Buffer, key: Buffer) => Buffer;
  createTempFile?: (userId: number, data: Buffer) => Promise<string>;
  getAuthorizations?: (path: string) => Promise<BridgeResult>;
  cleanupFile?: (path: string) => Promise<void>;
}

interface KeepaliveOps {
  decrypt: (blob: Buffer, key: Buffer) => Buffer;
  createTemp: (userId: number, data: Buffer) => Promise<string>;
  getAuths: (path: string) => Promise<BridgeResult>;
  cleanup: (path: string) => Promise<void>;
}

/** Marks the session expired when Telegram reports it lost; returns whether this call expired it. */
function handleAuthorizationResult(
  deps: SessionKeepaliveDeps,
  session: TelegramSession,
  result: BridgeResult,
): boolean {
  if (result.success) return false;
  if (result.error !== 'SESSION_EXPIRED') {
    keepaliveLogger.warn({ userId: session.user_id, error: result.error }, 'getAuthorizations returned error');
    return false;
  }
  if (!deps.sessionRepo.expireIfCurrent(session.user_id, session.encrypted_session)) return false;
  deps.onSessionExpired?.(session.user_id, result.reason ?? 'expired');
  keepaliveLogger.info({ userId: session.user_id }, 'Session marked expired during keepalive');
  return true;
}

/** Probes one session through a temp file; returns whether it was expired. Failures are logged, never thrown. */
async function checkSession(deps: SessionKeepaliveDeps, ops: KeepaliveOps, session: TelegramSession): Promise<boolean> {
  let expired = false;
  try {
    const sessionData = ops.decrypt(Buffer.from(session.encrypted_session), deps.masterKey);
    const tempPath = await ops.createTemp(session.user_id, sessionData);
    try {
      expired = handleAuthorizationResult(deps, session, await ops.getAuths(tempPath));
    } finally {
      await ops.cleanup(tempPath);
    }
  } catch (err) {
    keepaliveLogger.warn({ err, userId: session.user_id }, 'Session keepalive check failed');
  }
  return expired;
}

export async function processSessionKeepalive(deps: SessionKeepaliveDeps): Promise<SessionKeepaliveResult> {
  const ops: KeepaliveOps = {
    decrypt: deps.decrypt ?? decryptBlob,
    createTemp: deps.createTempFile ?? SessionBridge.createTempSessionFile,
    getAuths: deps.getAuthorizations ?? SessionBridge.getAuthorizations,
    cleanup: deps.cleanupFile ?? SessionBridge.cleanupTempFile,
  };

  const sessions = deps.sessionRepo.getAllActive();
  const delayMs = deps.rateLimitMs ?? RATE_LIMIT_MS;
  let expired = 0;

  keepaliveLogger.info({ total: sessions.length }, 'Session keepalive started');

  for (const [index, session] of sessions.entries()) {
    if (index > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    if (await checkSession(deps, ops, session)) expired++;
  }

  keepaliveLogger.info({ checked: sessions.length, expired }, 'Session keepalive finished');
  return { checked: sessions.length, expired };
}
