import { TelegramClient } from '@mtcute/bun';
import { voiceLogger } from './types';

export interface MtprotoClientConfig {
  apiId: number;
  apiHash: string;
  sessionString: string;
}

/**
 * Create and connect an MTProto userbot client for voice call signaling.
 *
 * The client uses @mtcute/bun's TelegramClient with string session auth.
 * Session string is generated once via interactive login, then stored
 * as MTPROTO_SESSION env var.
 */
export async function createMtprotoClient(config: MtprotoClientConfig): Promise<TelegramClient> {
  const client = new TelegramClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage: 'data/mtproto-session',
  });

  if (config.sessionString) {
    await client.importSession(config.sessionString);
  }
  await client.connect();

  voiceLogger.info('MTProto userbot client connected');
  return client;
}
