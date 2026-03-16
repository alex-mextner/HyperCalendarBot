import { describe, expect, mock, test } from 'bun:test';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';

function makeCtx(data: string, overrides: Record<string, unknown> = {}) {
  return {
    data,
    dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC' },
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    message: { chat: { id: 100 }, send: mock(() => Promise.resolve()) },
    chat: { id: 100 },
    ...overrides,
  };
}

function makeHandler(overrides: Record<string, unknown> = {}) {
  const eventService = {
    getEvent: mock(() => ({
      id: 1,
      title: 'Test',
      start_at: '2026-03-17T10:00:00Z',
      end_at: null,
      all_day: 0,
      description: null,
      location: null,
      category: null,
      recurrence_rule: null,
    })),
    getEventsForDay: mock(() => [
      {
        event: { id: 1, title: 'Test', start_at: '2026-03-17T10:00:00Z', recurrence_rule: null },
        occurrence_start: '2026-03-17T10:00:00Z',
        occurrence_end: '2026-03-17T11:00:00Z',
      },
    ]),
    getEventsForWeek: mock(() => []),
    ...overrides,
  };
  return createCallbackHandler(
    eventService as never,
    {} as never, // editValueScene
    {} as never, // holidayService
    {} as never, // prefsService
    undefined, // calendarRepo
    undefined, // disconnectDeps
    undefined, // onCalendarsDone
    undefined, // renderService
    undefined, // invitationService
    undefined, // groupChatRepo
    undefined, // eventRepo
    undefined, // chatHistoryRepo
  );
}

describe('createCallbackHandler', () => {
  test('handles event view callback', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('ev:1');
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('handles event view cancel', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('ev:cancel');
    await handler(ctx as never);
    expect(ctx.editText).toHaveBeenCalled();
    const text = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(text).toBe('OK');
  });

  test('handles unknown action gracefully', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('unknown_action:123');
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('handles empty data', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('', { data: undefined });
    await handler(ctx as never);
    // Should return without error
  });

  test('ai_btn saves to chat history and triggers callback', async () => {
    const chatHistoryRepo = { save: mock(() => {}) };
    const onAiButtonClick = mock(() => Promise.resolve());
    const handler = createCallbackHandler(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      chatHistoryRepo as never,
      onAiButtonClick,
    );
    const ctx = makeCtx('ai_btn:Да');
    await handler(ctx as never);
    expect(ctx.editText).toHaveBeenCalledWith('✅ Да');
    expect(chatHistoryRepo.save).toHaveBeenCalledWith(100, 'user', 'Да');
    expect(onAiButtonClick).toHaveBeenCalledWith(100, 100, 'Да');
  });

  test('share_evt:today shows events for today', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('share_evt:today');
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('share_evt:evt shows event detail', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('share_evt:evt:1');
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });
});
