import { describe, expect, mock, test } from 'bun:test';
import { createCallbackFallback } from '../../../src/bot/middleware/callback-fallback.ts';

function createFakeContext(overrides: Record<string, unknown> = {}) {
  return {
    is: (type: string) => type === 'callback_query',
    from: { id: 123 },
    answer: mock(async () => {}),
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
    const answerMock = mock(async () => {});
    const ctx = createFakeContext({ answer: answerMock });
    await middleware(ctx, async () => {
      // downstream does NOT answer (scene step didn't handle callback_query)
    });
    expect(answerMock).toHaveBeenCalledTimes(1);
    const callArgs = answerMock.mock.calls[0]![0] as { text: string };
    expect(callArgs.text).toContain('progress');
  });

  test('answers with "expired" message when no scene active', async () => {
    const storage = {
      get: mock(async () => null),
      set: mock(async () => {}),
      delete: mock(async () => false),
      has: mock(async () => false),
    };
    const middleware = createCallbackFallback(storage);
    const answerMock = mock(async () => {});
    const ctx = createFakeContext({ answer: answerMock });
    await middleware(ctx, async () => {});
    expect(answerMock).toHaveBeenCalledTimes(1);
    const callArgs = answerMock.mock.calls[0]![0] as { text: string };
    expect(callArgs.text).toContain('expired');
  });

  test('uses Russian message for ru users in scene', async () => {
    const storage = {
      get: mock(async () => ({ name: 'add_event', step: 0 })),
      set: mock(async () => {}),
      delete: mock(async () => false),
      has: mock(async () => false),
    };
    const middleware = createCallbackFallback(storage);
    const answerMock = mock(async () => {});
    const ctx = createFakeContext({ answer: answerMock, dbUser: { language: 'ru' } });
    await middleware(ctx, async () => {});
    const callArgs = answerMock.mock.calls[0]![0] as { text: string };
    expect(callArgs.text).toContain('/cancel');
  });

  test('uses Russian message for ru users without scene', async () => {
    const storage = {
      get: mock(async () => null),
      set: mock(async () => {}),
      delete: mock(async () => false),
      has: mock(async () => false),
    };
    const middleware = createCallbackFallback(storage);
    const answerMock = mock(async () => {});
    const ctx = createFakeContext({ answer: answerMock, dbUser: { language: 'ru' } });
    await middleware(ctx, async () => {});
    const callArgs = answerMock.mock.calls[0]![0] as { text: string };
    expect(callArgs.text).toContain('устарело');
  });
});
