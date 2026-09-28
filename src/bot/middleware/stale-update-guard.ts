// src/bot/middleware/stale-update-guard.ts
//
// Pending Telegram updates are no longer dropped on start, so a message sent
// while the bot restarted is answered by the next process. One sent long ago
// (an outage, not a deploy) is not run as a fresh request: replaying an old
// "delete everything" hours later would be worse than asking again. Edits are
// checked the same way. Button presses carry no click time and pass through: a
// pressed button is still the user's decision, just delivered late.

import type { Next } from 'gramio';
import { t, toLang } from '../../config/constants.ts';
import { botLogger } from '../../utils/logger.ts';

/** Covers a deploy restart with room to spare; anything older waited out an outage. */
export const STALE_UPDATE_MAX_AGE_MS = 10 * 60_000;

interface StaleUpdateMessage {
  /** Unix seconds when the message was first sent. */
  date: number;
  /** Unix seconds of the edit; an edit's `date` stays the original send time. */
  edit_date?: number;
  chat: { id: number; type: string };
  from?: { language_code?: string };
}

/**
 * The parts of a GramIO update the guard reads. It runs after the connect-wizard guard, so a
 * credential typed into the wizard is still taken off the chat however late it arrives; the note
 * uses the client language.
 */
export interface StaleUpdateContext {
  update?: { message?: StaleUpdateMessage; edited_message?: StaleUpdateMessage };
}

interface StaleUpdateGuardDeps {
  maxAgeMs: number;
  now: () => number;
  sendNote: (chatId: number, text: string) => Promise<unknown>;
}

export function createStaleUpdateGuard(deps: StaleUpdateGuardDeps) {
  const notifiedChats = new Set<number>();
  return async (context: StaleUpdateContext, next: Next): Promise<unknown> => {
    const message = context.update?.message ?? context.update?.edited_message;
    if (!message) return next();
    const ageMs = deps.now() - (message.edit_date ?? message.date) * 1000;
    if (ageMs <= deps.maxAgeMs) {
      // Telegram delivers pending updates in order: a fresh one ends the backlog,
      // so the next outage notifies again and the set never outgrows one backlog.
      notifiedChats.clear();
      return next();
    }

    const chatId = message.chat.id;
    botLogger.warn({ chatId, ageMs }, 'Skipping a message that waited past the stale-update window');
    // One note per chat per backlog: a long outage can leave many queued messages behind.
    if (message.chat.type !== 'private' || notifiedChats.has(chatId)) return;
    notifiedChats.add(chatId);
    await deps.sendNote(chatId, t(toLang(message.from?.language_code)).stale_update_skipped).catch((err: unknown) => {
      botLogger.warn({ err, chatId }, 'Failed to send the stale-update note');
    });
  };
}
