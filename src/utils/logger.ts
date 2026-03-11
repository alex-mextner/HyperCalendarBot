// src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});

export const botLogger = logger.child({ module: 'bot' });
export const dbLogger = logger.child({ module: 'db' });
export const cmdLogger = logger.child({ module: 'cmd' });
