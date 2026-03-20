/**
 * Integration tests for chat isolation:
 * createSceneStorage (real bun:sqlite) + wrapWithChatId + runWithChatId.
 *
 * Reproduces the original bug: same userId in two different chats must have
 * completely independent scene state — switching chats must NOT resume the
 * scene from a different chat.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { runWithChatId, wrapWithChatId } from '../../../src/bot/scenes/chat-scoped-storage.ts';
import { createSceneStorage } from '../../../src/bot/scenes/storage.ts';

// GramIO generates keys in this exact format
const sceneKey = (userId: number) => `@gramio/scenes:${userId}`;

describe('chat isolation — real SQLite storage', () => {
  test('same userId in different chats sees independent scene state', () => {
    const storage = createSceneStorage(new Database(':memory:'));
    const wrapped = wrapWithChatId(storage);

    const userId = 42;
    const key = sceneKey(userId);

    // Chat A (100): user is at step 3 of timezone wizard
    runWithChatId(100, () => wrapped.set(key, { step: 3, state: { city: 'Moscow' } }));

    // Chat B (200): same user starts a fresh scene
    runWithChatId(200, () => wrapped.set(key, { step: 0, state: {} }));

    // Chat A is untouched
    const stateA = runWithChatId(100, () => wrapped.get(key)) as { step: number; state: unknown } | undefined;
    expect(stateA?.step).toBe(3);
    expect((stateA?.state as { city?: string })?.city).toBe('Moscow');

    // Chat B is independent
    const stateB = runWithChatId(200, () => wrapped.get(key)) as { step: number } | undefined;
    expect(stateB?.step).toBe(0);

    // Chat C (300) — never set — returns nothing
    const stateC = runWithChatId(300, () => wrapped.get(key));
    expect(stateC).toBeUndefined();
  });

  test('completing scene in one chat does not affect another', () => {
    const storage = createSceneStorage(new Database(':memory:'));
    const wrapped = wrapWithChatId(storage);

    const key = sceneKey(7);

    runWithChatId(10, () => wrapped.set(key, { step: 2 }));
    runWithChatId(20, () => wrapped.set(key, { step: 5 }));

    // Scene completes in chat 10 → delete its state
    runWithChatId(10, () => wrapped.delete(key));

    expect(runWithChatId(10, () => wrapped.get(key))).toBeUndefined();
    expect((runWithChatId(20, () => wrapped.get(key)) as { step: number } | undefined)?.step).toBe(5);
  });

  test('has() returns true only for the chat that set the key', () => {
    const storage = createSceneStorage(new Database(':memory:'));
    const wrapped = wrapWithChatId(storage);

    const key = sceneKey(99);
    runWithChatId(1, () => wrapped.set(key, { step: 0 }));

    const hasInChat1 = runWithChatId(1, () => (wrapped as { has?(k: string): boolean }).has?.(key));
    const hasInChat2 = runWithChatId(2, () => (wrapped as { has?(k: string): boolean }).has?.(key));

    expect(hasInChat1).toBe(true);
    expect(hasInChat2).toBe(false);
  });

  test('multiple users in same chat are isolated from each other', () => {
    const storage = createSceneStorage(new Database(':memory:'));
    const wrapped = wrapWithChatId(storage);

    const chatId = 500;

    // User 1 and user 2 in the same chat
    runWithChatId(chatId, () => wrapped.set(sceneKey(1), { step: 1 }));
    runWithChatId(chatId, () => wrapped.set(sceneKey(2), { step: 9 }));

    const u1 = runWithChatId(chatId, () => wrapped.get(sceneKey(1))) as { step: number } | undefined;
    const u2 = runWithChatId(chatId, () => wrapped.get(sceneKey(2))) as { step: number } | undefined;

    expect(u1?.step).toBe(1);
    expect(u2?.step).toBe(9);
  });

  test('switching chats mid-scene does not resume old session (the original bug)', () => {
    const storage = createSceneStorage(new Database(':memory:'));
    const wrapped = wrapWithChatId(storage);

    const userId = 100;
    const key = sceneKey(userId);

    // User opens timezone scene in private DM (chatId = userId = 100)
    runWithChatId(userId, () => wrapped.set(key, { step: 2, state: { pending: 'geo' } }));

    // User switches to a group chat (chatId = -200) and sends a message
    // Without the fix, the bot would read the DM session here
    const sessionInGroup = runWithChatId(-200, () => wrapped.get(key));
    expect(sessionInGroup).toBeUndefined(); // must not leak into group chat

    // Private DM session is still intact
    const dmSession = runWithChatId(userId, () => wrapped.get(key)) as { step: number } | undefined;
    expect(dmSession?.step).toBe(2);
  });
});
