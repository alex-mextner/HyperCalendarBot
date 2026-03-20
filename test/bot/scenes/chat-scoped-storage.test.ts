import { describe, expect, test } from 'bun:test';
import { runWithChatId, wrapWithChatId } from '../../../src/bot/scenes/chat-scoped-storage.ts';

function makeStorage() {
  const m = new Map<string, unknown>();
  return {
    get: (key: string) => m.get(key) ?? null,
    set: (key: string, value: unknown) => {
      m.set(key, value);
    },
    delete: (key: string) => {
      m.delete(key);
    },
    has: (key: string) => m.has(key),
    keys: () => [...m.keys()],
  };
}

describe('wrapWithChatId', () => {
  test('scopes key with chatId from ALS', () => {
    const raw = makeStorage();
    const wrapped = wrapWithChatId(raw);

    runWithChatId(42, () => {
      wrapped.set('@gramio/scenes:1', { step: 0 });
    });

    expect(raw.keys()).toContain('@gramio/scenes:1:42');
    expect(raw.keys()).not.toContain('@gramio/scenes:1');
  });

  test('different chatIds produce different keys', () => {
    const raw = makeStorage();
    const wrapped = wrapWithChatId(raw);

    runWithChatId(10, () => {
      wrapped.set('key', 'chat10');
    });
    runWithChatId(20, () => {
      wrapped.set('key', 'chat20');
    });

    expect(raw.get('key:10')).toBe('chat10');
    expect(raw.get('key:20')).toBe('chat20');
  });

  test('get returns value for the current chatId', () => {
    const raw = makeStorage();
    const wrapped = wrapWithChatId(raw);

    runWithChatId(5, () => {
      wrapped.set('k', 'v5');
    });

    const result = runWithChatId(5, () => wrapped.get('k'));
    expect(result).toBe('v5');

    const otherResult = runWithChatId(6, () => wrapped.get('k'));
    expect(otherResult).toBeNull();
  });

  test('delete removes only the scoped key', () => {
    const raw = makeStorage();
    const wrapped = wrapWithChatId(raw);

    runWithChatId(1, () => {
      wrapped.set('x', 'a');
    });
    runWithChatId(2, () => {
      wrapped.set('x', 'b');
    });
    runWithChatId(1, () => {
      wrapped.delete('x');
    });

    expect(raw.get('x:1')).toBeNull();
    expect(raw.get('x:2')).toBe('b');
  });

  test('has returns true when key exists for current chatId', () => {
    const raw = makeStorage();
    const wrapped = wrapWithChatId(raw);

    runWithChatId(7, () => {
      wrapped.set('k', 1);
    });

    const hasIt = runWithChatId(7, () => (wrapped as { has?(k: string): unknown }).has?.('k'));
    const hasItOther = runWithChatId(8, () => (wrapped as { has?(k: string): unknown }).has?.('k'));
    expect(hasIt).toBe(true);
    expect(hasItOther).toBe(false);
  });

  test('falls back to chatId=0 when no ALS context', () => {
    const raw = makeStorage();
    const wrapped = wrapWithChatId(raw);

    // Outside any runWithChatId — ALS returns undefined, fallback to 0
    wrapped.set('key', 'val');
    expect(raw.keys()).toContain('key:0');
  });
});

describe('runWithChatId', () => {
  test('nested runWithChatId is correctly scoped', () => {
    const raw = makeStorage();
    const wrapped = wrapWithChatId(raw);

    runWithChatId(1, () => {
      wrapped.set('k', 'outer');
      runWithChatId(2, () => {
        wrapped.set('k', 'inner');
      });
      // After inner context, outer chatId is restored
      wrapped.set('k2', 'outer-after');
    });

    expect(raw.get('k:1')).toBe('outer');
    expect(raw.get('k:2')).toBe('inner');
    expect(raw.get('k2:1')).toBe('outer-after');
  });
});
