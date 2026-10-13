// Shared validation for reflection queries over UTC, second-resolution SQLite timestamps.
import { isValid, parseISO } from 'date-fns';
import type { AgentContext } from '../types.ts';

export type ReflectionContext = Pick<AgentContext, 'user' | 'chatId' | 'isGroup' | 'groupChatId'>;

export function hasInvalidReflectionScope(ctx: ReflectionContext): boolean {
  return ctx.isGroup && (!ctx.groupChatId || ctx.groupChatId >= 0 || ctx.groupChatId !== ctx.chatId);
}

export function normalizeReflectionLimit(value: number | undefined, defaultLimit: number): number {
  return value === undefined || !Number.isFinite(value) ? defaultLimit : Math.max(1, Math.min(100, Math.trunc(value)));
}

/** Zone-less dates and datetimes explicitly mean UTC, independent of the process timezone. */
export function reflectionBoundary(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) throw new Error('Invalid timestamp');
  const [, day, hour = '00', minute = '00', second = '00', fraction = '', zone = 'Z'] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) throw new Error('Invalid timestamp');
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) {
    throw new Error('Invalid timestamp');
  }
  const date = parseISO(`${day}T${hour}:${minute}:${second}${zone}`);
  if (!isValid(date) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) {
    throw new Error('Invalid timestamp');
  }
  // Keep nonzero fractions for exclusive text comparisons; .000 must equal a stored whole second.
  // Only the parameter is normalized, so created_at range indexes remain usable.
  const normalizedFraction = fraction.replace(/0+$/, '').replace(/\.$/, '');
  return date.toISOString().slice(0, 19).replace('T', ' ') + normalizedFraction;
}
