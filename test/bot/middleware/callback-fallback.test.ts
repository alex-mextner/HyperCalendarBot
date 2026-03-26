import { describe, expect, mock, test } from 'bun:test';
import { createCallbackFallback } from '../../../src/bot/middleware/callback-fallback.ts';
import type { User } from '../../../src/database/types.ts';

/** Shape matching the CallbackCtx interface inside callback-fallback.ts */
interface FakeCallbackCtx {
  is: (type: string) => boolean;
  from: { id: number };
  answer: (...args: unknown[]) => Promise<unknown>;
  dbUser: Partial<User>;
}

function createFakeContext(overrides: Partial<FakeCallbackCtx> = {}): FakeCallbackCtx {
  return {
    is: (type: string) => type === 'callback_query',
    from: { id: 123 },
    answer: mock(async (): Promise<true> => true),
    dbUser: { language: 'en' },
    ...overrides,
  };
}

describe('callbackFallback', () => {
  test('passes through non-callback events', async () => {
    const storage = {
      get: mock(async () => null),
      set: mock(async () => {}),
      delete: mock(async () => false),
      has: mock(async () => false),
    };
    const middleware = createCallbackFallback(storage);
    const ctx = createFakeContext({ is: () => false });
    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(ctx.answer).not.toHaveBeenCalled();
  });

  test('does not answer if downstream already answered', async () => {
    const storage = {
      get: mock(async () => null),
      set: mock(async () => {}),
      delete: mock(async () => false),
      has: mock(async () => false),
    };
    const middleware = createCallbackFallback(storage);
    let answerCount = 0;
    const ctx = createFakeContext({
      answer: async () => {
        answerCount++;
      },
    });
    await middleware(ctx, async () => {
      await ctx.answer();
    });
    // answer was called exactly once (by downstream), not by fallback
    expect(answerCount).toBe(1);
  });

  test('answers with "in scene" message when user is in active scene', async () => {
    const storage = {
      get: mock(async () => ({ name: 'add_event', step: 0 })),
      set: mock(async () => {}),
      delete: mock(async () => false),
      has: mock(async () => false),
    };
    const middleware = createCallbackFallback(storage);
    const answerMock = mock(async (..._args: unknown[]) => {});
    const ctx = createFakeContext({ answer: answerMock });
    await middleware(ctx, async () => {
      // downstream does NOT answer (scene step didn't handle callback_query)
    });
    expect(answerMock).toHaveBeenCalledTimes(1);
    expect((answerMock.mock.calls[0]![0] as { text: string }).text).toContain('progress');
  });

  test('answers with "expired" message when no scene active', async () => {
    const storage = {
      get: mock(async () => null),
      set: mock(async () => {}),
      delete: mock(async () => false),
      has: mock(async () => false),
    };
    const middleware = createCallbackFallback(storage);
    const answerMock = mock(async (..._args: unknown[]) => {});
    const ctx = createFakeContext({ answer: answerMock });
    await middleware(ctx, async () => {});
    expect(answerMock).toHaveBeenCalledTimes(1);
    expect((answerMock.mock.calls[0]![0] as { text: string }).text).toContain('expired');
  });

  test('uses Russian message for ru users in scene', async () => {
    const storage = {
      get: mock(async () => ({ name: 'add_event', step: 0 })),
      set: mock(async () => {}),
      delete: mock(async () => false),
      has: mock(async () => false),
    };
    const middleware = createCallbackFallback(storage);
    const answerMock = mock(async (..._args: unknown[]) => {});
    const ctx = createFakeContext({ answer: answerMock, dbUser: { language: 'ru' } });
    await middleware(ctx, async () => {});
    expect((answerMock.mock.calls[0]![0] as { text: string }).text).toContain('/cancel');
  });

  test('uses Russian message for ru users without scene', async () => {
    const storage = {
      get: mock(async () => null),
      set: mock(async () => {}),
      delete: mock(async () => false),
      has: mock(async () => false),
    };
    const middleware = createCallbackFallback(storage);
    const answerMock = mock(async (..._args: unknown[]) => {});
    const ctx = createFakeContext({ answer: answerMock, dbUser: { language: 'ru' } });
    await middleware(ctx, async () => {});
    expect((answerMock.mock.calls[0]![0] as { text: string }).text).toContain('устарело');
  });
});
