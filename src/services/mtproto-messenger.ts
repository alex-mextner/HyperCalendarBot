import type { TelegramClient } from '@mtcute/bun';
import { botLogger } from '../utils/logger.ts';

const logger = botLogger.child({ module: 'mtproto-messenger' });

export function createMtprotoMessenger(
  client: TelegramClient,
): (userId: number, text: string, username?: string) => Promise<boolean> {
  return async (userId: number, text: string, username?: string): Promise<boolean> => {
    // Try by telegram_id first
    try {
      await client.sendText(userId, text);
      logger.info({ userId }, 'Message sent via MTProto userbot (by id)');
      return true;
    } catch (error) {
      const msg = String(error);
      if (!username || !msg.includes('not found in local cache')) {
        logger.warn({ userId, error: msg }, 'MTProto message delivery failed');
        return false;
      }
    }

    // Fallback: resolve by @username
    try {
      await client.sendText(username, text);
      logger.info({ userId, username }, 'Message sent via MTProto userbot (by username)');
      return true;
    } catch (error) {
      logger.warn({ userId, username, error: String(error) }, 'MTProto message delivery failed (by username)');
      return false;
    }
  };
}
