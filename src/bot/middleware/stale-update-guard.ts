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
import type { User } from '../../database/types.ts';
import { botLogger } from '../../utils/logger.ts';

/** Covers a deploy restart with room to spare; anything older waited out an outage. */
export const STALE_UPDATE_MAX_AGE_MS = 10 * 60_000;

/** The parts of a GramIO update context the guard reads. */
export interface StaleUpdateContext {
  update?: {
    message?: { date: number; chat: { id: number; type: string } };
    edited_message?: { date: number; chat: { id: number; type: string } };
  };
  dbUser?: Pick<User, 'language'> | null;
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
    const ageMs = deps.now() - message.date * 1000;
    if (ageMs <= deps.maxAgeMs) return next();

    const chatId = message.chat.id;
    botLogger.warn({ chatId, ageMs }, 'Skipping a message that waited past the stale-update window');
    // One note per chat per process: a long outage can leave many queued messages behind.
    if (message.chat.type !== 'private' || notifiedChats.has(chatId)) return;
    notifiedChats.add(chatId);
    await deps.sendNote(chatId, t(toLang(context.dbUser?.language)).stale_update_skipped).catch((err: unknown) => {
      botLogger.warn({ err, chatId }, 'Failed to send the stale-update note');
    });
  };
}
