// src/utils/safe-failure.ts
// Describes a failure on a path that handles credentials (the Telegram-connect wizard) without the
// parts that may echo them. A storage, Telegram API or MTProto bridge error can carry the request,
// its payload or the provider's text — and so the phone number, login code or password — in its
// message, stack, cause, extra fields and even its `name`, which any code may overwrite (GH-645).

import { SQLiteError } from 'bun:sqlite';
import { TelegramError } from 'gramio';

type BridgeErrorCode =
  | 'CODE_EXPIRED'
  | 'CODE_INVALID'
  | 'FLOOD_WAIT'
  | 'LOG_OUT_FAILED'
  | 'NO_CODE'
  | 'PASSWORD_INVALID'
  | 'PHONE_INVALID'
  | 'UNEXPECTED';

/** Error codes the MTProto bridge (scripts/connect-session.py, session-bridge.ts) reports. */
const BRIDGE_ERRORS: Record<BridgeErrorCode, true> = {
  CODE_EXPIRED: true,
  CODE_INVALID: true,
  FLOOD_WAIT: true,
  LOG_OUT_FAILED: true,
  NO_CODE: true,
  PASSWORD_INVALID: true,
  PHONE_INVALID: true,
  UNEXPECTED: true,
};

/**
 * A fixed label for the failure's class, plus a Telegram API status in the HTTP range. Nothing the
 * error itself says — name, message, stack, cause, payload, params — is passed on.
 */
export function describeFailure(err: unknown): { errorName: string; errorCode?: number } {
  if (err instanceof TelegramError) {
    const status = Number.isInteger(err.code) && err.code >= 400 && err.code <= 599 ? err.code : undefined;
    return status === undefined ? { errorName: 'TelegramError' } : { errorName: 'TelegramError', errorCode: status };
  }
  if (err instanceof SQLiteError) return { errorName: 'SQLiteError' };
  return { errorName: err instanceof Error ? 'Error' : 'non-error' };
}

/** A bridge error code if it is one the bridge is known to report, otherwise 'other'. */
export function describeBridgeError(code: string): BridgeErrorCode | 'other' {
  // Own keys only: 'toString' and the like are no bridge code.
  return isBridgeErrorCode(code) ? code : 'other';
}

function isBridgeErrorCode(code: string): code is BridgeErrorCode {
  return Object.hasOwn(BRIDGE_ERRORS, code);
}
