import { describe, expect, test } from 'bun:test';
import type { TelegramUpdate } from 'gramio';
import { createChatLogging } from '../../../src/bot/middleware/chat-logging.ts';
import { createConnectWizardGuard } from '../../../src/bot/middleware/connect-wizard-guard.ts';
import { CONNECT_WIZARD_REDACTION } from '../../../src/bot/scenes/connect-telegram.scene.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';

describe('chat logging when the connect-wizard state cannot be read (GH-519)', () => {
  test('the text is stored as the connect-wizard marker, stays in the chat and still reaches the next handler', async () => {
    const db = new DatabaseService(':memory:');
    const user = db.users.create({ telegram_id: 719_900, language: 'ru', timezone: 'UTC' });
    const guard = createConnectWizardGuard({
      sceneStorage: {
        get: () => {
          throw new Error('storage unavailable');
        },
      },
      // Never reached: the scene row is read first.
      traces: { read: () => undefined, write: () => undefined },
    });
    const logging = createChatLogging({
      conversationLogger: new ConversationLogger(db.chatHistory),
      actionLog: db.actionLog,
      chatHistoryIds: new Map<number, number>(),
      isConnectWizardInput: guard.isConnectWizardInput,
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
    let deleted = false;
    let reachedNext = false;
    const context = {
      dbUser: user,
      update,
      delete: async () => {
        deleted = true;
      },
    };

    await guard.middleware(context, () =>
      logging(context, async () => {
        reachedNext = true;
      }),
    );

    const stored = db.db.query<{ content: string }, []>('SELECT content FROM chat_history').all();
    expect(stored).toEqual([{ content: CONNECT_WIZARD_REDACTION }]);
    expect(deleted).toBe(false);
    expect(reachedNext).toBe(true);
    db.db.close();
  });
});
