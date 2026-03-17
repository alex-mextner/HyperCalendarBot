import type { TelegramClient } from '@mtcute/bun';
import { botLogger } from '../utils/logger.ts';

const logger = botLogger.child({ module: 'mtproto-messenger' });

export function createMtprotoMessenger(client: TelegramClient): (userId: number, text: string) => Promise<boolean> {
  return async (userId: number, text: string): Promise<boolean> => {
    try {
      await client.sendText(userId, text);
      logger.info({ userId }, 'Message sent via MTProto userbot');
      return true;
    } catch (error) {
      logger.warn({ userId, error: String(error) }, 'MTProto message delivery failed');
      return false;
    }
  };
}
