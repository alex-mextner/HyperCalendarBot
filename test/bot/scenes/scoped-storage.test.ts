/**
 * Unit tests for `createScopedSceneStorage` — the public factory that bundles
 * `createSceneStorage` + `wrapWithChatId`. Exposing this as a standalone export
 * lets bot/index.ts wire the storage into msgDeps BEFORE scenes are built, which
 * in turn allows the scene plugin to receive a real (not late-bound) forwardToAi
 * closure. The factory is tiny, but its existence is load-bearing, so a smoke
 * test guarantees the two pieces stay composed correctly.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { runWithChatId } from '../../../src/bot/scenes/chat-scoped-storage.ts';
import { createScopedSceneStorage } from '../../../src/bot/scenes/index.ts';
import type { DatabaseService } from '../../../src/database/index.ts';

function makeDbService(): DatabaseService {
  return { db: new Database(':memory:') } as unknown as DatabaseService;
}

describe('createScopedSceneStorage', () => {
  test('returns a storage object with get/set/delete', () => {
    const storage = createScopedSceneStorage(makeDbService());
    expect(typeof storage.get).toBe('function');
    expect(typeof storage.set).toBe('function');
    expect(typeof storage.delete).toBe('function');
  });

  test('values are scoped by chatId — same key in different chats is independent', () => {
    const storage = createScopedSceneStorage(makeDbService());
    const key = '@gramio/scenes:42';

    runWithChatId(111, () => storage.set(key, { step: 5, state: {} }));
    runWithChatId(222, () => storage.set(key, { step: 0, state: {} }));

    const inChat111 = runWithChatId(111, () => storage.get(key)) as { step: number } | undefined;
    const inChat222 = runWithChatId(222, () => storage.get(key)) as { step: number } | undefined;

    expect(inChat111?.step).toBe(5);
    expect(inChat222?.step).toBe(0);
  });

  test('delete is scoped by chatId — removing in one chat leaves the other intact', () => {
    const storage = createScopedSceneStorage(makeDbService());
    const key = '@gramio/scenes:42';

    runWithChatId(111, () => storage.set(key, { step: 1, state: {} }));
    runWithChatId(222, () => storage.set(key, { step: 2, state: {} }));

    runWithChatId(111, () => storage.delete(key));

    expect(runWithChatId(111, () => storage.get(key))).toBeUndefined();
    expect(runWithChatId(222, () => storage.get(key))).toBeDefined();
  });

  test('returns undefined for an unknown key', () => {
    const storage = createScopedSceneStorage(makeDbService());
    expect(runWithChatId(111, () => storage.get('@gramio/scenes:999'))).toBeUndefined();
  });
});
