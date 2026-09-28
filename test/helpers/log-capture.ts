/**
 * Captures every line any logger writes, as the JSON pino hands to its output stream — before
 * pino-pretty formats it in its worker. Child loggers share the root logger's stream, so this sees
 * module loggers created at import time too. Captured lines are not printed.
 */
import { spyOn } from 'bun:test';
import pino from 'pino';
import { logger } from '../../src/utils/logger.ts';

function isLogStream(value: unknown): value is { write(chunk: string): boolean } {
  return typeof value === 'object' && value !== null && 'write' in value && typeof value.write === 'function';
}

export function captureLogs(): { text(): string; restore(): void } {
  const stream: unknown = Reflect.get(logger, pino.symbols.streamSym);
  if (!isLogStream(stream)) throw new Error('the logger has no output stream to observe');
  const lines: string[] = [];
  const spy = spyOn(stream, 'write').mockImplementation((chunk: string) => {
    lines.push(chunk);
    return true;
  });
  return { text: () => lines.join(''), restore: () => spy.mockRestore() };
}
