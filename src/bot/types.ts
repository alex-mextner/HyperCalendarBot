// src/bot/types.ts
import type { AnyBot, CallbackQueryContext, MessageContext } from 'gramio';
import type { User } from '../database/types.ts';

/**
 * Properties derived into GramIO context by user-resolver middleware.
 */
export interface DerivedProps {
  dbUser: User;
  userTimezone: string;
  lang: 'en' | 'ru';
}

/**
 * Additional properties GramIO injects into command/message contexts at runtime.
 * `args` is added by `.command()`, `location`/`document` are optional message fields,
 * `getFile` is a bot helper available on message contexts.
 */
export interface GramIOMessageExtras {
  /** Text after the command (injected by GramIO .command() handler) */
  args?: string | null;
  /** Shared location (present only when message contains location) */
  location?: { latitude: number; longitude: number } | null;
  /** Attached document (present only when message contains a document) */
  document?: { file_id: string; file_name?: string; mime_type?: string } | null;
  /** Get file metadata for download */
  getFile(): Promise<{ file_path: string }>;
}

/**
 * Command/message handler context — MessageContext with derived properties.
 */
export type BotCommandContext = MessageContext<AnyBot> & DerivedProps & GramIOMessageExtras;

/**
 * Callback query handler context — CallbackQueryContext with derived properties.
 */
export type BotCallbackContext = CallbackQueryContext<AnyBot> & DerivedProps;

/**
 * @deprecated Use DerivedProps instead
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
