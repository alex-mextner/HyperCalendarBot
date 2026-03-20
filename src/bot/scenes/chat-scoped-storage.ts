// src/bot/scenes/chat-scoped-storage.ts
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<number>();

/**
 * Wraps a storage so every key is scoped to the current chat.
 * The ALS must be populated via runWithChatId() before any storage access.
 * GramIO generates keys like `@gramio/scenes:${userId}`;
 * the wrapper stores them as `@gramio/scenes:${userId}:${chatId}`,
 * giving each chat its own independent scene state.
 */
export function wrapWithChatId(storage: {
  get(key: string): unknown;
  set(key: string, value: unknown): unknown;
  delete(key: string): unknown;
  has?(key: string): unknown;
}): typeof storage {
  const scoped = (key: string) => `${key}:${als.getStore() ?? 0}`;
  return {
    get: (key) => storage.get(scoped(key)),
    set: (key, value) => storage.set(scoped(key), value),
    delete: (key) => storage.delete(scoped(key)),
    ...(storage.has ? { has: (key: string) => storage.has!(scoped(key)) } : {}),
  };
}

export function runWithChatId<T>(chatId: number, fn: () => T): T {
  return als.run(chatId, fn);
}
