// src/bot/types.ts
import type { User } from '../database/types.ts';

/**
 * Properties derived into GramIO context by middleware
 */
export interface BotDerived {
  dbUser: User;
  userTimezone: string;
  lang: 'en' | 'ru';
}

/**
 * Session state for multi-step interactions (onboarding, /add wizard, /edit wizard)
 */
export interface UserSession {
  step: string;
  data: Record<string, unknown>;
  expiresAt: number;
}

/** In-memory session store. Resets on process restart — that's fine. */
export const sessions = new Map<number, UserSession>();

export function getSession(userId: number): UserSession | null {
  const session = sessions.get(userId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(userId);
    return null;
  }
  return session;
}

export function setSession(userId: number, step: string, data: Record<string, unknown> = {}): void {
  sessions.set(userId, {
    step,
    data,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
  });
}

export function clearSession(userId: number): void {
  sessions.delete(userId);
}
