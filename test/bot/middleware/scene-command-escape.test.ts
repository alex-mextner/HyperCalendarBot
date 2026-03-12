import { describe, expect, mock, test } from 'bun:test';
import { createSceneCommandEscape } from '../../../src/bot/middleware/scene-command-escape.ts';

function createMockStorage(data: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(data));
  return {
    get: mock(async (key: string) => store.get(key) ?? null),
    delete: mock(async (key: string) => {
      store.delete(key);
    }),
  };
}

function createMockContext(overrides: Record<string, unknown> = {}) {
  return {
    is: mock((type: string) => type === 'message'),
    from: { id: 123 },
    dbUser: { language: 'ru' },
    send: mock(async () => {}),
    text: undefined,
    ...overrides,
  };
}

describe('createSceneCommandEscape', () => {
  test('passes non-message updates through', async () => {
    const storage = createMockStorage({ '@gramio/scenes:123': { name: 'add_event' } });
    const middleware = createSceneCommandEscape(storage);
    const ctx = createMockContext({ is: () => false });
    const next = mock(async () => {});

    await middleware(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
  });

  test('passes non-command messages through', async () => {
    const storage = createMockStorage({ '@gramio/scenes:123': { name: 'add_event' } });
    const middleware = createSceneCommandEscape(storage);
    const ctx = createMockContext({ text: 'hello world' });
    const next = mock(async () => {});

    await middleware(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
  });

  test('passes commands through when no active scene', async () => {
    const storage = createMockStorage();
    const middleware = createSceneCommandEscape(storage);
    const ctx = createMockContext({ text: '/add' });
    const next = mock(async () => {});

    await middleware(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('cancels active scene and propagates command', async () => {
    const storage = createMockStorage({ '@gramio/scenes:123': { name: 'add_event' } });
    const middleware = createSceneCommandEscape(storage);
    const ctx = createMockContext({ text: '/today' });
    const next = mock(async () => {});

    await middleware(ctx, next);

    expect(storage.delete).toHaveBeenCalledWith('@gramio/scenes:123');
    expect(ctx.send).toHaveBeenCalledWith('Добавление события отменено.', {
      reply_markup: { remove_keyboard: true },
    });
    expect(next).toHaveBeenCalled();
  });

  test('cancels active scene on /cancel without propagating', async () => {
    const storage = createMockStorage({ '@gramio/scenes:123': { name: 'add_event' } });
    const middleware = createSceneCommandEscape(storage);
    const ctx = createMockContext({ text: '/cancel' });
    const next = mock(async () => {});

    await middleware(ctx, next);

    expect(storage.delete).toHaveBeenCalledWith('@gramio/scenes:123');
    expect(ctx.send).toHaveBeenCalledWith('Добавление события отменено.', {
      reply_markup: { remove_keyboard: true },
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('handles /cancel@BotName', async () => {
    const storage = createMockStorage({ '@gramio/scenes:123': { name: 'edit_value' } });
    const middleware = createSceneCommandEscape(storage);
    const ctx = createMockContext({ text: '/cancel@HyperCalendarBot' });
    const next = mock(async () => {});

    await middleware(ctx, next);

    expect(storage.delete).toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledWith('Редактирование отменено.', {
      reply_markup: { remove_keyboard: true },
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('uses English for en-language users', async () => {
    const storage = createMockStorage({ '@gramio/scenes:456': { name: 'import' } });
    const middleware = createSceneCommandEscape(storage);
    const ctx = createMockContext({
      text: '/help',
      from: { id: 456 },
      dbUser: { language: 'en' },
    });
    const next = mock(async () => {});

    await middleware(ctx, next);

    expect(ctx.send).toHaveBeenCalledWith('Import cancelled.', {
      reply_markup: { remove_keyboard: true },
    });
    expect(next).toHaveBeenCalled();
  });

  test('shows correct message for each scene', async () => {
    const scenes = [
      { name: 'add_event', ru: 'Добавление события отменено.', en: 'Event creation cancelled.' },
      { name: 'edit_value', ru: 'Редактирование отменено.', en: 'Editing cancelled.' },
      { name: 'import', ru: 'Импорт отменён.', en: 'Import cancelled.' },
      { name: 'timezone', ru: 'Настройка часового пояса отменена.', en: 'Timezone setup cancelled.' },
      { name: 'onboarding', ru: 'Настройка отменена.', en: 'Setup cancelled.' },
    ];

    for (const { name, ru, en } of scenes) {
      // Russian
      const storageRu = createMockStorage({ '@gramio/scenes:1': { name } });
      const mwRu = createSceneCommandEscape(storageRu);
      const ctxRu = createMockContext({ text: '/cancel', from: { id: 1 }, dbUser: { language: 'ru' } });
      await mwRu(ctxRu, async () => {});
      expect(ctxRu.send).toHaveBeenCalledWith(ru, { reply_markup: { remove_keyboard: true } });

      // English
      const storageEn = createMockStorage({ '@gramio/scenes:2': { name } });
      const mwEn = createSceneCommandEscape(storageEn);
      const ctxEn = createMockContext({ text: '/cancel', from: { id: 2 }, dbUser: { language: 'en' } });
      await mwEn(ctxEn, async () => {});
      expect(ctxEn.send).toHaveBeenCalledWith(en, { reply_markup: { remove_keyboard: true } });
    }
  });

  test('falls back to generic message for unknown scene', async () => {
    const storage = createMockStorage({ '@gramio/scenes:123': { name: 'unknown_scene' } });
    const middleware = createSceneCommandEscape(storage);
    const ctx = createMockContext({ text: '/help' });
    const next = mock(async () => {});

    await middleware(ctx, next);

    expect(ctx.send).toHaveBeenCalledWith('Отменено.', { reply_markup: { remove_keyboard: true } });
  });
});
