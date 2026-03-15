import { describe, expect, mock, test } from 'bun:test';

const user = { telegram_id: 100, language: 'en' as const, timezone: 'UTC' };
const userRu = { telegram_id: 100, language: 'ru' as const, timezone: 'UTC' };

function makeCommandCtx(overrides = {}) {
  return {
    dbUser: user,
    send: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makeCallbackCtx(overrides = {}) {
  return {
    dbUser: user,
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    user_id: 100,
    title: 'Meeting',
    start_at: '2026-03-15T10:00:00Z',
    end_at: null,
    timezone: 'UTC',
    recurrence_rule: null,
    ...overrides,
  };
}

describe('handleDelete', () => {
  test('sends no_events when list is empty', async () => {
    const { handleDelete } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCommandCtx();
    const eventService = { getUpcoming: mock(() => []) };

    await handleDelete(ctx as never, eventService as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No events');
  });

  test('sends no_events in russian', async () => {
    const { handleDelete } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCommandCtx({ dbUser: userRu });
    const eventService = { getUpcoming: mock(() => []) };

    await handleDelete(ctx as never, eventService as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Нет событий');
  });

  test('sends picker keyboard when events exist', async () => {
    const { handleDelete } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCommandCtx();
    const events = [makeEvent()];
    const eventService = { getUpcoming: mock(() => events) };

    await handleDelete(ctx as never, eventService as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const args = ctx.send.mock.calls[0] as unknown[];
    expect(args[0]).toContain('Which event to delete');
    expect(args[1]).toHaveProperty('reply_markup');
  });
});

describe('handleDeleteCallback', () => {
  test('cancels when eventId is 0', async () => {
    const { handleDeleteCallback } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCallbackCtx();

    await handleDeleteCallback(ctx as never, {} as never, user as never, 0);

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toBe('Cancelled.');
  });

  test('cancels in russian when eventId is 0', async () => {
    const { handleDeleteCallback } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCallbackCtx();

    await handleDeleteCallback(ctx as never, {} as never, userRu as never, 0);

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toBe('Отменено.');
  });

  test('answers with error when event not found', async () => {
    const { handleDeleteCallback } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCallbackCtx();
    const eventService = { getEvent: mock(() => null) };

    await handleDeleteCallback(ctx as never, eventService as never, user as never, 999);

    expect(ctx.answer).toHaveBeenCalledWith({ text: 'Event not found' });
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('shows confirm keyboard for non-recurring event', async () => {
    const { handleDeleteCallback } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCallbackCtx();
    const event = makeEvent();
    const eventService = { getEvent: mock(() => event) };

    await handleDeleteCallback(ctx as never, eventService as never, user as never, 1);

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Meeting');
  });

  test('shows recurrence scope keyboard for recurring event with occurrenceDate', async () => {
    const { handleDeleteCallback } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCallbackCtx();
    const event = makeEvent({ recurrence_rule: 'FREQ=WEEKLY' });
    const eventService = { getEvent: mock(() => event) };

    await handleDeleteCallback(ctx as never, eventService as never, user as never, 1, '2026-03-15');

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Meeting');
  });

  test('shows standard confirm for recurring event without occurrenceDate', async () => {
    const { handleDeleteCallback } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCallbackCtx();
    const event = makeEvent({ recurrence_rule: 'FREQ=DAILY' });
    const eventService = { getEvent: mock(() => event) };

    await handleDeleteCallback(ctx as never, eventService as never, user as never, 1);

    expect(ctx.editText).toHaveBeenCalled();
    const args = ctx.editText.mock.calls[0] as unknown[];
    const msg = args[0] as string;
    expect(msg).toContain('Meeting');
  });
});

describe('handleDeleteConfirmCallback', () => {
  test('deletes event and shows success', async () => {
    const { handleDeleteConfirmCallback } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCallbackCtx();
    const event = makeEvent();
    const eventService = {
      getEvent: mock(() => event),
      deleteEvent: mock(() => true),
    };

    await handleDeleteConfirmCallback(ctx as never, eventService as never, user as never, 1);

    expect(eventService.deleteEvent).toHaveBeenCalledWith(1, 100);
    expect(ctx.answer).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Meeting');
  });

  test('shows something_wrong when delete fails', async () => {
    const { handleDeleteConfirmCallback } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCallbackCtx();
    const eventService = {
      getEvent: mock(() => null),
      deleteEvent: mock(() => false),
    };

    await handleDeleteConfirmCallback(ctx as never, eventService as never, user as never, 1);

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Something went wrong');
  });

  test('uses ? as title when event not found', async () => {
    const { handleDeleteConfirmCallback } = await import('../../../src/bot/commands/delete.ts');
    const ctx = makeCallbackCtx();
    const eventService = {
      getEvent: mock(() => null),
      deleteEvent: mock(() => true),
    };

    await handleDeleteConfirmCallback(ctx as never, eventService as never, user as never, 99);

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('?');
  });
});
