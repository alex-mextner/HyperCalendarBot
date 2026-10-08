/**
 * Memory bounds of the messages the connect-wizard guard holds for their owner's decision: a held
 * message leaves memory at its expiry on its own, and no more than a fixed number are held in all.
 * Drives the guard's own middleware and callbacks; the real-chain behaviour is covered in
 * test/bot/scenes/connect-telegram.secrets.test.ts. All values are synthetic.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test';
import type { TelegramUpdate } from 'gramio';
import { createConnectWizardGuard } from '../../../src/bot/middleware/connect-wizard-guard.ts';
import { connectWizardRowKey, createConnectWizardTraces } from '../../../src/bot/scenes/connect-wizard-trace.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import type { User } from '../../../src/database/types.ts';
import { ConversationLogger } from '../../../src/services/conversation-logger.ts';

afterEach(() => {
  jest.useRealTimers();
});

/** A guard whose scene store cannot be read, over chats whose durable trace shows an open wizard. */
function makeGuard() {
  const db = new DatabaseService(':memory:');
  const traces = createConnectWizardTraces(db.db);
  const replayed: TelegramUpdate[] = [];
  let sceneStoreReadable = false;
  const guard = createConnectWizardGuard({
    sceneStorage: {
      get: () => {
        if (!sceneStoreReadable) throw new Error('synthetic scene store failure');
        return undefined;
      },
      delete: () => true,
    },
    traces,
    conversationLogger: new ConversationLogger(db.chatHistory),
    actionLog: db.actionLog,
    replay: async (update) => {
      replayed.push(update);
    },
  });

  /** A private message from a user whose wizard is open at the 2FA prompt; resolves to its hold's buttons. */
  async function holdFrom(userId: number): Promise<{ user: User; process: string }> {
    const user = db.users.create({ telegram_id: userId, language: 'en', timezone: 'UTC' });
    traces.write(connectWizardRowKey(userId, userId), { open: true, step: 3, typed: [] });
    let process: string | undefined;
    const update: TelegramUpdate = {
      update_id: userId,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: userId, type: 'private' },
        from: { id: userId, is_bot: false, first_name: 'Synthetic' },
        text: 'synthetic request',
      },
    };
    await guard.middleware(
      {
        update,
        dbUser: user,
        delete: async () => true,
        send: async (_text, opts) => {
          process = JSON.stringify(opts).match(/ctw:p:[\w-]+/)?.[0];
        },
      },
      async () => {
        throw new Error('a held message must not reach the next middleware');
      },
    );
    if (process === undefined) throw new Error('no held-message notice was sent');
    return { user, process };
  }

  /** The owner presses "process it"; returns the text the notice was edited to. */
  async function press(user: User, data: string): Promise<string | undefined> {
    let edited: string | undefined;
    await guard.callbacks(
      {
        update: {
          update_id: 1_000_000 + user.telegram_id,
          callback_query: {
            id: 'synthetic',
            chat_instance: 'synthetic',
            from: { id: user.telegram_id, is_bot: false, first_name: 'Synthetic' },
            data,
            message: { message_id: 2, date: 1, chat: { id: user.telegram_id, type: 'private' } },
          },
        },
        dbUser: user,
        answer: async () => true,
        editText: async (text) => {
          edited = text;
        },
        send: async () => undefined,
      },
      async () => undefined,
    );
    return edited;
  }

  return {
    guard,
    holdFrom,
    press,
    replayed,
    makeSceneStoreReadable: () => {
      sceneStoreReadable = true;
    },
    /** Lets @gramio/storage-sqlite's zero-delay expiry sweep run on the still-open database, then closes it. */
    close: async () => {
      jest.useRealTimers();
      const swept = Promise.withResolvers<void>();
      setTimeout(swept.resolve);
      await swept.promise;
      db.db.close();
    },
  };
}

describe('messages held by the connect-wizard guard', () => {
  test('leave memory when they expire, with no later press or hold', async () => {
    jest.useFakeTimers();
    const g = makeGuard();
    await g.holdFrom(730_001);
    expect(g.guard.heldMessageCount()).toBe(1);

    jest.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(g.guard.heldMessageCount()).toBe(0);
    await g.close();
  });

  test('are at most 100 in all: the oldest is dropped first, the newest can still be released', async () => {
    const g = makeGuard();
    const held: { user: User; process: string }[] = [];
    for (let i = 0; i <= 100; i++) held.push(await g.holdFrom(731_000 + i));
    expect(g.guard.heldMessageCount()).toBe(100);

    g.makeSceneStoreReadable();
    const oldest = held[0]!;
    expect(await g.press(oldest.user, oldest.process)).toBe(
      'I no longer have that message — if it was an ordinary request, please send it again.',
    );
    expect(g.replayed).toEqual([]);

    const newest = held[100]!;
    expect(await g.press(newest.user, newest.process)).toBe('✅ Processing it as an ordinary request.');
    expect(g.replayed).toHaveLength(1);
    expect(g.guard.heldMessageCount()).toBe(99);
    await g.close();
  });
});
