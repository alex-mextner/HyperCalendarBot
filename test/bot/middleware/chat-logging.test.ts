import { describe, expect, test } from 'bun:test';
import type { TelegramUpdate } from 'gramio';
import { createChatLogging } from '../../../src/bot/middleware/chat-logging.ts';
import { createConnectWizardGuard } from '../../../src/bot/middleware/connect-wizard-guard.ts';
import { CONNECT_WIZARD_REDACTION } from '../../../src/bot/scenes/connect-telegram.scene.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import { currentChatTurn } from '../../../src/services/ai/chat-turn-context.ts';
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
      reserveChatTurn: (chatId, rowId) => ({ chatId, rowId, release() {} }),
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

describe('the row saved for each update', () => {
  function textUpdate(updateId: number, userId: number, text: string): TelegramUpdate {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 1,
        chat: { id: userId, type: 'private' },
        from: { id: userId, is_bot: false, first_name: 'Synthetic' },
        text,
      },
    };
  }

  test('each update’s context names its own row even after a later message replaced the user’s latest row', async () => {
    const db = new DatabaseService(':memory:');
    const user = db.users.create({ telegram_id: 719_901, language: 'ru', timezone: 'UTC' });
    const chatHistoryIds = new Map<number, number>();
    const logging = createChatLogging({
      conversationLogger: new ConversationLogger(db.chatHistory),
      actionLog: db.actionLog,
      chatHistoryIds,
      reserveChatTurn: (chatId, rowId) => ({ chatId, rowId, release() {} }),
      isConnectWizardInput: () => false,
    });
    const first: { dbUser: typeof user; update: TelegramUpdate; chatHistoryId?: number } = {
      dbUser: user,
      update: textUpdate(1, user.telegram_id, 'first'),
    };
    const second: typeof first = { dbUser: user, update: textUpdate(2, user.telegram_id, 'second') };
    const command: typeof first = { dbUser: user, update: textUpdate(3, user.telegram_id, '/today') };

    await logging(first, async () => {});
    await logging(second, async () => {});
    await logging(command, async () => {});

    const rows = db.db
      .query<{ id: number; content: string }, []>(
        "SELECT id, content FROM chat_history WHERE role = 'user' ORDER BY id",
      )
      .all();
    expect(rows.map((row) => row.content).slice(0, 2)).toEqual(['first', 'second']);
    expect(first.chatHistoryId).toBe(rows[0]?.id);
    expect(second.chatHistoryId).toBe(rows[1]?.id);
    expect(chatHistoryIds.get(user.telegram_id)).toBe(rows[1]?.id); // the per-user entry only knows the latest
    expect(command.chatHistoryId).toBeUndefined(); // a command is logged as a command, not as a turn to answer
    db.db.close();
  });

  test('a saved turn holds its place in the chat at once and gives it up when its handling ends', async () => {
    const db = new DatabaseService(':memory:');
    const user = db.users.create({ telegram_id: 719_902, language: 'ru', timezone: 'UTC' });
    const events: string[] = [];
    const logging = createChatLogging({
      conversationLogger: new ConversationLogger(db.chatHistory),
      actionLog: db.actionLog,
      chatHistoryIds: new Map<number, number>(),
      reserveChatTurn: (chatId, rowId) => {
        events.push(`reserve ${chatId}:${rowId}`);
        return { chatId, rowId, release: () => events.push(`release ${rowId}`) };
      },
      isConnectWizardInput: () => false,
    });
    const message: { dbUser: typeof user; update: TelegramUpdate; chatHistoryId?: number } = {
      dbUser: user,
      update: textUpdate(1, user.telegram_id, 'Yes'),
    };
    const command: typeof message = { dbUser: user, update: textUpdate(2, user.telegram_id, '/today') };

    let seenInHandler: number | undefined;
    await logging(message, async () => {
      events.push('handler');
      seenInHandler = currentChatTurn()?.rowId; // what an agent run started by this update finds to take over
    });
    await logging(command, async () => {});

    const rowId = message.chatHistoryId;
    expect(seenInHandler).toBe(rowId);
    expect(currentChatTurn()).toBeUndefined(); // and nothing leaks out of the update
    expect(events).toEqual([`reserve ${user.telegram_id}:${rowId}`, 'handler', `release ${rowId}`]); // none for the command
    db.db.close();
  });
});
