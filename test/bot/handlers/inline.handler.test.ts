import { describe, expect, mock, test } from 'bun:test';

describe('createInlineHandler', () => {
  test('returns empty results for user without settings', async () => {
    const { createInlineHandler } = await import('../../../src/bot/handlers/inline.handler');

    const inlineService = {
      parseQuery: mock(() => ({ type: 'agenda_today' as const })),
      buildResults: mock(() => []),
    };
    const userRepo = {
      findByTelegramId: mock(() => null),
    };
    const settingsRepo = {
      get: mock(() => null),
    };

    const handler = createInlineHandler(inlineService as never, userRepo as never, settingsRepo as never);

    const ctx = {
      from: { id: 100 },
      query: '',
      answerInlineQuery: mock(() => Promise.resolve(true as const)),
    };

    await handler(ctx);
    expect(ctx.answerInlineQuery).toHaveBeenCalled();
    const args = ctx.answerInlineQuery.mock.calls[0] as unknown[];
    const results = args[0] as unknown[];
    expect(results).toHaveLength(0);
  });

  test('builds results from InlineService', async () => {
    const { createInlineHandler } = await import('../../../src/bot/handlers/inline.handler');

    const inlineService = {
      parseQuery: mock(() => ({ type: 'agenda_today' as const })),
      buildResults: mock(() => [
        {
          id: 'evt_1',
          type: 'article' as const,
          title: '10:00 Meeting',
          description: 'Meeting',
          messageText: '📅 Meeting — 10:00',
        },
      ]),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, timezone: 'UTC', language: 'en' })),
    };
    const settingsRepo = {
      get: mock(() => ({ inline_mode_enabled: 1 })),
    };

    const handler = createInlineHandler(inlineService as never, userRepo as never, settingsRepo as never);

    const ctx = {
      from: { id: 100 },
      query: '',
      answerInlineQuery: mock(() => Promise.resolve(true as const)),
    };

    await handler(ctx);
    expect(ctx.answerInlineQuery).toHaveBeenCalled();
    const args = ctx.answerInlineQuery.mock.calls[0] as unknown[];
    const results = args[0] as unknown[];
    expect(results).toHaveLength(1);
  });

  test('converts results to Telegram InlineQueryResult format', async () => {
    const { createInlineHandler } = await import('../../../src/bot/handlers/inline.handler');

    const inlineService = {
      parseQuery: mock(() => ({ type: 'agenda_today' as const })),
      buildResults: mock(() => [
        {
          id: 'evt_1',
          type: 'article' as const,
          title: '10:00 Meeting',
          description: 'Meeting',
          messageText: '📅 Meeting — 10:00',
        },
      ]),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, timezone: 'UTC', language: 'en' })),
    };
    const settingsRepo = {
      get: mock(() => ({ inline_mode_enabled: 1 })),
    };

    const handler = createInlineHandler(inlineService as never, userRepo as never, settingsRepo as never);

    const ctx = {
      from: { id: 100 },
      query: '',
      answerInlineQuery: mock(() => Promise.resolve(true as const)),
    };

    await handler(ctx);
    const args = ctx.answerInlineQuery.mock.calls[0] as unknown[];
    const results = args[0] as Array<Record<string, unknown>>;
    const result = results[0]!;
    expect(result.type).toBe('article');
    expect(result.id).toBe('evt_1');
    expect(result.title).toBe('10:00 Meeting');
    expect(result.input_message_content).toEqual({
      message_text: '📅 Meeting — 10:00',
      parse_mode: 'HTML',
    });
  });

  test('respects inline_mode_enabled setting', async () => {
    const { createInlineHandler } = await import('../../../src/bot/handlers/inline.handler');

    const inlineService = {
      parseQuery: mock(() => ({ type: 'agenda_today' as const })),
      buildResults: mock(() => []),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, timezone: 'UTC' })),
    };
    const settingsRepo = {
      get: mock(() => ({ inline_mode_enabled: 0 })),
    };

    const handler = createInlineHandler(inlineService as never, userRepo as never, settingsRepo as never);

    const ctx = {
      from: { id: 100 },
      query: 'today',
      answerInlineQuery: mock(() => Promise.resolve(true as const)),
    };

    await handler(ctx);
    // Should return empty results when inline mode disabled
    const args = ctx.answerInlineQuery.mock.calls[0] as unknown[];
    const results = args[0] as unknown[];
    expect(results).toHaveLength(0);
  });

  test('returns empty results when from is missing', async () => {
    const { createInlineHandler } = await import('../../../src/bot/handlers/inline.handler');

    const inlineService = {
      parseQuery: mock(() => ({ type: 'agenda_today' as const })),
      buildResults: mock(() => []),
    };
    const userRepo = {
      findByTelegramId: mock(() => null),
    };
    const settingsRepo = {
      get: mock(() => null),
    };

    const handler = createInlineHandler(inlineService as never, userRepo as never, settingsRepo as never);

    const ctx = {
      from: undefined,
      query: '',
      answerInlineQuery: mock(() => Promise.resolve(true as const)),
    };

    await handler(ctx);
    expect(ctx.answerInlineQuery).toHaveBeenCalled();
    const args = ctx.answerInlineQuery.mock.calls[0] as unknown[];
    const results = args[0] as unknown[];
    expect(results).toHaveLength(0);
  });

  test('catches errors and returns empty results', async () => {
    const { createInlineHandler } = await import('../../../src/bot/handlers/inline.handler');

    const inlineService = {
      parseQuery: mock(() => {
        throw new Error('parse failed');
      }),
      buildResults: mock(() => []),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, timezone: 'UTC', language: 'en' })),
    };
    const settingsRepo = {
      get: mock(() => ({ inline_mode_enabled: 1 })),
    };

    const handler = createInlineHandler(inlineService as never, userRepo as never, settingsRepo as never);

    const ctx = {
      from: { id: 100 },
      query: 'broken',
      answerInlineQuery: mock(() => Promise.resolve(true as const)),
    };

    await handler(ctx);
    expect(ctx.answerInlineQuery).toHaveBeenCalled();
    const args = ctx.answerInlineQuery.mock.calls[0] as unknown[];
    const results = args[0] as unknown[];
    expect(results).toHaveLength(0);
  });

  test('passes cache_time option to answerInlineQuery', async () => {
    const { createInlineHandler } = await import('../../../src/bot/handlers/inline.handler');

    const inlineService = {
      parseQuery: mock(() => ({ type: 'agenda_today' as const })),
      buildResults: mock(() => []),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ telegram_id: 100, timezone: 'UTC', language: 'en' })),
    };
    const settingsRepo = {
      get: mock(() => ({ inline_mode_enabled: 1 })),
    };

    const handler = createInlineHandler(inlineService as never, userRepo as never, settingsRepo as never);

    const ctx = {
      from: { id: 100 },
      query: '',
      answerInlineQuery: mock(() => Promise.resolve(true as const)),
    };

    await handler(ctx);
    const args = ctx.answerInlineQuery.mock.calls[0] as unknown[];
    const options = args[1] as Record<string, unknown>;
    expect(options.cache_time).toBe(30);
  });
});
