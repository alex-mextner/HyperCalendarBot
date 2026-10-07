// src/bot/middleware/stale-update-guard.ts
//
// Pending Telegram updates are no longer dropped on start, so a message sent
// while the bot restarted is answered by the next process. One sent long ago
// (an outage, not a deploy) is not run as a fresh request: replaying an old
// "delete everything" hours later would be worse than asking again. Edits are
// checked the same way. Button presses carry no click time and pass through: a
// pressed button is still the user's decision, just delivered late. For the same
// reason a message its owner released with a button (one the connect-wizard guard
// held after the wizard expired) runs however long it was held.

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

interface StaleUpdateGuardDeps<C extends StaleUpdateContext> {
  maxAgeMs: number;
  now: () => number;
  sendNote: (chatId: number, text: string) => Promise<unknown>;
  /** Whether this update is a held message its owner just released with a button press. */
  isOwnerReleased: (context: C) => boolean;
}

export function createStaleUpdateGuard<C extends StaleUpdateContext>(deps: StaleUpdateGuardDeps<C>) {
  // When each private chat was last told. Webhook deliveries run concurrently and out of order,
  // so a backlog is bounded by time, not by the first fresh update that happens to arrive.
  const notedAt = new Map<number, number>();
  return async (context: C, next: Next): Promise<unknown> => {
    const message = context.update?.message ?? context.update?.edited_message;
    if (!message || deps.isOwnerReleased(context)) return next();
    const now = deps.now();
    const ageMs = now - (message.edit_date ?? message.date) * 1000;
    if (ageMs <= deps.maxAgeMs) return next();

    const chatId = message.chat.id;
    botLogger.warn({ chatId, ageMs }, 'Skipping a message that waited past the stale-update window');
    if (message.chat.type !== 'private') return;
    // One note per chat per outage: a long outage can leave many queued messages behind.
    for (const [notedChat, at] of notedAt) {
      if (now - at > deps.maxAgeMs) notedAt.delete(notedChat);
    }
    if (notedAt.has(chatId)) return;
    notedAt.set(chatId, now);
    await deps.sendNote(chatId, t(toLang(message.from?.language_code)).stale_update_skipped).catch((err: unknown) => {
      botLogger.warn({ err, chatId }, 'Failed to send the stale-update note');
    });
  };
}
