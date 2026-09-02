// src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});

export const botLogger = logger.child({ module: 'bot' });
export const dbLogger = logger.child({ module: 'db' });
export const cmdLogger = logger.child({ module: 'cmd' });
export const notifyLogger = logger.child({ module: 'notify' });
export const syncLogger = logger.child({ module: 'sync' });
export const webLogger = logger.child({ module: 'web' });
export const imageLogger = logger.child({ module: 'image' });

const alreadySaid = new Set<string>();

/**
 * Says something once per process, keyed by `key`. For conditions that are read
 * on a hot path but only change on restart — a misconfigured provider order is
 * re-read on every AI request, and repeating its warning on every round buries
 * the incident the warning exists to announce.
 */
export function logOnce(key: string, say: () => void): void {
  if (alreadySaid.has(key)) return;
  alreadySaid.add(key);
  say();
}

/**
 * Forgets what has been said. For tests: the set is process-global, so without
 * this the first test to trigger a message silences it for every later one, and
 * which test that is depends on execution order.
 */
export function resetLogOnce(): void {
  alreadySaid.clear();
}
