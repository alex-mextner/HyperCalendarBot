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
    chatId: 42,
    message: { id: 7 },
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    scene: {
      enter: mock(() => Promise.resolve()),
    },
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    user_id: 100,
    title: 'Standup',
    start_at: '2026-03-15T09:00:00Z',
    end_at: '2026-03-15T09:30:00Z',
    timezone: 'UTC',
    description: null,
    location: null,
    category: null,
    all_day: 0,
    recurrence_rule: null,
    recurrence_end_at: null,
    reminder_overrides: null,
    ...overrides,
  };
}

describe('handleEdit', () => {
  test('sends no_events when list is empty', async () => {
    const { handleEdit } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCommandCtx();
    const eventService = { getUpcoming: mock(() => []) };

    await handleEdit(ctx as never, eventService as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No events');
  });

  test('sends no_events in russian', async () => {
    const { handleEdit } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCommandCtx({ dbUser: userRu });
    const eventService = { getUpcoming: mock(() => []) };

    await handleEdit(ctx as never, eventService as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Нет событий');
  });

  test('sends event picker when events exist', async () => {
    const { handleEdit } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCommandCtx();
    const events = [makeEvent()];
    const eventService = { getUpcoming: mock(() => events) };

    await handleEdit(ctx as never, eventService as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const args = ctx.send.mock.calls[0] as unknown[];
    expect(args[0]).toContain('edit');
    expect(args[1]).toHaveProperty('reply_markup');
  });
});

describe('handleEditCallback', () => {
  test('answers with error when event not found', async () => {
    const { handleEditCallback } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCallbackCtx();
    const eventService = { getEvent: mock(() => null) };

    await handleEditCallback(ctx as never, eventService as never, user as never, 999);

    expect(ctx.answer).toHaveBeenCalledWith({ text: 'Event not found' });
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('shows event detail with edit keyboard for non-recurring event', async () => {
    const { handleEditCallback } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCallbackCtx();
    const event = makeEvent();
    const eventService = { getEvent: mock(() => event) };

    await handleEditCallback(ctx as never, eventService as never, user as never, 1);

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const args = ctx.editText.mock.calls[0] as unknown[];
    expect(args[1]).toHaveProperty('parse_mode', 'HTML');
    expect(args[1]).toHaveProperty('reply_markup');
  });

  test('shows recurring edit keyboard for recurring event with occurrenceDate', async () => {
    const { handleEditCallback } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCallbackCtx();
    const event = makeEvent({ recurrence_rule: 'FREQ=WEEKLY' });
    const eventService = { getEvent: mock(() => event) };

    await handleEditCallback(ctx as never, eventService as never, user as never, 1, '2026-03-15');

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('shows standard edit keyboard for recurring event without occurrenceDate', async () => {
    const { handleEditCallback } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCallbackCtx();
    const event = makeEvent({ recurrence_rule: 'FREQ=DAILY' });
    const eventService = { getEvent: mock(() => event) };

    await handleEditCallback(ctx as never, eventService as never, user as never, 1);

    expect(ctx.editText).toHaveBeenCalled();
    const args = ctx.editText.mock.calls[0] as unknown[];
    expect(args[1]).toHaveProperty('reply_markup');
  });
});

describe('handleEditFieldCallback', () => {
  test('cancels when field is "cancel"', async () => {
    const { handleEditFieldCallback } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCallbackCtx();

    await handleEditFieldCallback(ctx as never, user as never, 1, 'cancel', {} as never);

    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toBe('Cancelled.');
  });

  test('cancels in russian', async () => {
    const { handleEditFieldCallback } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCallbackCtx();

    await handleEditFieldCallback(ctx as never, userRu as never, 1, 'cancel', {} as never);

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toBe('Отменено.');
  });

  test('enters edit_value scene for valid field', async () => {
    const { handleEditFieldCallback } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCallbackCtx();
    const editValueScene = { name: 'edit_value' };

    await handleEditFieldCallback(ctx as never, user as never, 5, 'title', editValueScene as never);

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.scene.enter).toHaveBeenCalledWith(editValueScene, {
      eventId: 5,
      field: 'title',
      chatId: 42,
      messageId: 7,
    });
  });

  test('uses messageId 0 when message is undefined', async () => {
    const { handleEditFieldCallback } = await import('../../../src/bot/commands/edit.ts');
    const ctx = makeCallbackCtx({ message: undefined });
    const editValueScene = { name: 'edit_value' };

    await handleEditFieldCallback(ctx as never, user as never, 3, 'time', editValueScene as never);

    expect(ctx.scene.enter).toHaveBeenCalledWith(editValueScene, {
      eventId: 3,
      field: 'time',
      chatId: 42,
      messageId: 0,
    });
  });
});
