import { describe, expect, mock, test } from 'bun:test';
import { createInlineHandler, InlineDebouncer } from '../../../src/bot/handlers/inline.handler';

describe('InlineDebouncer', () => {
  test('first call for user is not debounced', () => {
    const debouncer = new InlineDebouncer(300);
    expect(debouncer.shouldProcess(100)).toBe(true);
  });

  test('rapid second call within window is debounced', () => {
    const debouncer = new InlineDebouncer(300);
    debouncer.shouldProcess(100);
    expect(debouncer.shouldProcess(100)).toBe(false);
  });

  test('call after window passes is not debounced', async () => {
    const debouncer = new InlineDebouncer(50); // 50ms for fast test
    debouncer.shouldProcess(100);
    await new Promise((r) => setTimeout(r, 60));
    expect(debouncer.shouldProcess(100)).toBe(true);
  });

  test('different users are independent', () => {
    const debouncer = new InlineDebouncer(300);
    expect(debouncer.shouldProcess(100)).toBe(true);
    expect(debouncer.shouldProcess(200)).toBe(true);
  });
});

describe('createInlineHandler location auto-update', () => {
  test('updates timezone when inline query has location', async () => {
    const updateMock = mock(() => null);
    const userRepo = {
      findByTelegramId: () => ({ telegram_id: 100, timezone: 'UTC' }),
      update: updateMock,
    };
    const settingsRepo = { get: () => ({ inline_mode_enabled: 1 }) };
    const inlineService = {
      parseQuery: () => ({ type: 'agenda_today' }),
      buildResults: () => [],
      buildPhotoResult: () => Promise.resolve(null),
    };
    const handler = createInlineHandler(inlineService as never, userRepo as never, settingsRepo as never);

    await handler({
      from: { id: 100 },
      query: '',
      location: { latitude: 44.8, longitude: 20.5 }, // Belgrade
      answerInlineQuery: mock(() => Promise.resolve()),
    });

    expect(updateMock).toHaveBeenCalled();
    const call = updateMock.mock.calls[0] as unknown as [number, { timezone: string }];
    expect(call[0]).toBe(100);
    expect(call[1].timezone).toContain('Europe/Belgrade');
  });

  test('does not update timezone when no location', async () => {
    const updateMock = mock(() => null);
    const userRepo = {
      findByTelegramId: () => ({ telegram_id: 100, timezone: 'UTC' }),
      update: updateMock,
    };
    const settingsRepo = { get: () => ({ inline_mode_enabled: 1 }) };
    const inlineService = {
      parseQuery: () => ({ type: 'agenda_today' }),
      buildResults: () => [],
      buildPhotoResult: () => Promise.resolve(null),
    };
    const handler = createInlineHandler(inlineService as never, userRepo as never, settingsRepo as never);

    await handler({
      from: { id: 100 },
      query: '',
      answerInlineQuery: mock(() => Promise.resolve()),
    });

    expect(updateMock).not.toHaveBeenCalled();
  });
});
