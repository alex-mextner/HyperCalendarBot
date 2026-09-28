import { describe, expect, test } from 'bun:test';
import type { TelegramUpdate } from 'gramio';
import { createChatLogging } from '../../../src/bot/middleware/chat-logging.ts';
import { CONNECT_WIZARD_REDACTION } from '../../../src/bot/scenes/connect-telegram.scene.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';

describe('chat logging when the scene store cannot be read (GH-519)', () => {
  test('the text is stored as the connect-wizard marker and the update still reaches the next handler', async () => {
    const db = new DatabaseService(':memory:');
    const user = db.users.create({ telegram_id: 719_900, language: 'ru', timezone: 'UTC' });
    const middleware = createChatLogging({
      conversationLogger: new ConversationLogger(db.chatHistory),
      actionLog: db.actionLog,
      chatHistoryIds: new Map<number, number>(),
      sceneStorage: {
        get: () => Promise.reject(new Error('storage unavailable')),
      },
    });
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 5,
        date: 1,
        chat: { id: user.telegram_id, type: 'private' },
        from: { id: user.telegram_id, is_bot: false, first_name: 'Synthetic' },
        text: 'Synthetic pass phrase',
      },
    };
    let reachedNext = false;

    await middleware({ dbUser: user, update }, async () => {
      reachedNext = true;
    });

    const stored = db.db.query<{ content: string }, []>('SELECT content FROM chat_history').all();
    expect(stored).toEqual([{ content: CONNECT_WIZARD_REDACTION }]);
    expect(reachedNext).toBe(true);
    db.db.close();
  });
});
