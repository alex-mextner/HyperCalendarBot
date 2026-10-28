// src/bootstrap/crash-handlers.ts
//
// Process-level crash policy: uncaught exceptions and unhandled rejections are fatal (log, push a
// best-effort admin alert, exit 1), except a transient AbortError, which is logged and survived.
//
// Ordering invariant: src/index.ts installs these handlers BEFORE loadConfig() so a config error is
// handled the same way as any other crash. The alert sink only exists once the database is open
// (it writes to db.alerts), so a crash before that point is logged and exits without an alert.

import { botLogger } from '../utils/logger.ts';

export interface CrashLogger {
  fatal(obj: object, message: string): void;
  warn(obj: object, message: string): void;
}

export interface CrashHandlerDeps {
  logger: CrashLogger;
  exit: (code: number) => void;
}

export interface CrashHandlers {
  /** Best-effort and synchronous: db.alerts.push() does not await. */
  setAlertSink(sink: ((message: string) => void) | undefined): void;
  onUncaughtException(error: Error): void;
  onUnhandledRejection(reason: unknown): void;
}

/**
 * AbortError ("The connection was closed") is a transient network issue. Bun's DOMException has no
 * stack trace, so crashing on it gives zero diagnostic value.
 */
export function isTransientAbort(err: Error): boolean {
  return err.name === 'AbortError' || err.message?.includes('The connection was closed') === true;
}

export function createCrashHandlers(deps: CrashHandlerDeps): CrashHandlers {
  let alertSink: ((message: string) => void) | undefined;

  return {
    setAlertSink(sink) {
      alertSink = sink;
    },
    onUncaughtException(error) {
      deps.logger.fatal({ err: error }, 'Uncaught exception');
      alertSink?.(`Bot crashed: ${error.stack ?? error.message}`);
      deps.exit(1);
    },
    onUnhandledRejection(reason) {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      if (isTransientAbort(err)) {
        deps.logger.warn({ err, name: err.name, message: err.message }, 'Transient AbortError (not crashing)');
        return;
      }
      deps.logger.fatal({ err }, 'Unhandled promise rejection');
      alertSink?.(`Bot unhandled rejection: ${err.stack ?? err.message}`);
      deps.exit(1);
    },
  };
}

/** Registers the crash handlers on the real process. Returns the handle that arms the alert sink. */
export function installCrashHandlers(): CrashHandlers {
  const handlers = createCrashHandlers({ logger: botLogger, exit: (code) => process.exit(code) });
  process.on('uncaughtException', (error: Error) => handlers.onUncaughtException(error));
  process.on('unhandledRejection', (reason: unknown) => handlers.onUnhandledRejection(reason));
  return handlers;
}
