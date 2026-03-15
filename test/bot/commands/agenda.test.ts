import { describe, expect, mock, test } from 'bun:test';
import { handleGroupAgenda, handleGroupAgendaCallback } from '../../../src/bot/commands/agenda';

function makeCommandCtx(language = 'en', chatType = 'group', chatId = -999) {
  return {
    dbUser: { telegram_id: 100, language, timezone: 'UTC' },
    chat: chatType ? { type: chatType, id: chatId } : undefined,
    send: mock(() => Promise.resolve()),
  };
}

function makeCallbackCtx(language = 'en', chatType = 'group', chatId = -999) {
  return {
    dbUser: { telegram_id: 100, language, timezone: 'UTC' },
    chat: chatType ? { type: chatType, id: chatId } : undefined,
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
  };
}

function makeGroupRepo(items: Array<{ event_id: number; shared_by: number }> = [], total = 0) {
  return {
    getSharedEventsPaginated: mock(() => ({ items, total: total || items.length })),
  };
}

function makeEventRepo(events: Record<number, { id: number; title: string; start_at: string } | null> = {}) {
  return {
    findById: mock((id: number) => events[id] ?? null),
  };
}

// ── handleGroupAgenda (command) ──

describe('handleGroupAgenda', () => {
  test('rejects private chat', async () => {
    const ctx = makeCommandCtx('en', 'private', 100);
    await handleGroupAgenda(ctx as never, {} as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('only in groups');
  });

  test('rejects private chat in Russian', async () => {
    const ctx = makeCommandCtx('ru', 'private', 100);
    await handleGroupAgenda(ctx as never, {} as never, {} as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('только в группах');
  });

  test('rejects when no chat', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      chat: undefined,
      send: mock(() => Promise.resolve()),
    };
    await handleGroupAgenda(ctx as never, {} as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('only in groups');
  });

  test('no events shows empty message', async () => {
    const groupRepo = makeGroupRepo([], 0);
    const eventRepo = makeEventRepo();
    const ctx = makeCommandCtx();
    await handleGroupAgenda(ctx as never, groupRepo as never, eventRepo as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No events');
  });

  test('no events in Russian', async () => {
    const groupRepo = makeGroupRepo([], 0);
    const eventRepo = makeEventRepo();
    const ctx = makeCommandCtx('ru');
    await handleGroupAgenda(ctx as never, groupRepo as never, eventRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Нет событий');
  });

  test('shows events list', async () => {
    const groupRepo = makeGroupRepo([{ event_id: 1, shared_by: 100 }], 1);
    const eventRepo = makeEventRepo({
      1: { id: 1, title: 'Team Standup', start_at: '2026-03-15T10:00:00Z' },
    });
    const ctx = makeCommandCtx();
    await handleGroupAgenda(ctx as never, groupRepo as never, eventRepo as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Team Standup');
    expect(msg).toContain('Group events');
  });

  test('shows header without pagination for single page', async () => {
    const groupRepo = makeGroupRepo([{ event_id: 1, shared_by: 100 }], 1);
    const eventRepo = makeEventRepo({
      1: { id: 1, title: 'Meeting', start_at: '2026-03-15T10:00:00Z' },
    });
    const ctx = makeCommandCtx();
    await handleGroupAgenda(ctx as never, groupRepo as never, eventRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).not.toContain('/');
  });

  test('shows pagination header and buttons for multiple pages', async () => {
    const groupRepo = makeGroupRepo([{ event_id: 1, shared_by: 100 }], 25);
    const eventRepo = makeEventRepo({
      1: { id: 1, title: 'Meeting', start_at: '2026-03-15T10:00:00Z' },
    });
    const ctx = makeCommandCtx();
    await handleGroupAgenda(ctx as never, groupRepo as never, eventRepo as never, 0);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('1/3');
    // reply_markup should be present
    const opts = (ctx.send.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts?.reply_markup).toBeDefined();
  });

  test('all events deleted shows deleted message', async () => {
    const groupRepo = makeGroupRepo([{ event_id: 1, shared_by: 100 }], 1);
    const eventRepo = makeEventRepo(); // findById returns null
    const ctx = makeCommandCtx();
    await handleGroupAgenda(ctx as never, groupRepo as never, eventRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('deleted');
  });

  test('works in supergroup chat type', async () => {
    const groupRepo = makeGroupRepo([{ event_id: 1, shared_by: 100 }], 1);
    const eventRepo = makeEventRepo({
      1: { id: 1, title: 'Event', start_at: '2026-03-15T10:00:00Z' },
    });
    const ctx = makeCommandCtx('en', 'supergroup');
    await handleGroupAgenda(ctx as never, groupRepo as never, eventRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Event');
  });
});

// ── handleGroupAgendaCallback ──

describe('handleGroupAgendaCallback', () => {
  test('no chat answers and returns', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      chat: undefined,
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };
    await handleGroupAgendaCallback(ctx as never, {} as never, {} as never, 0);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('no events edits text with empty message', async () => {
    const groupRepo = makeGroupRepo([], 0);
    const ctx = makeCallbackCtx();
    await handleGroupAgendaCallback(ctx as never, groupRepo as never, {} as never, 0);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No events');
  });

  test('all events deleted shows deleted message', async () => {
    const groupRepo = makeGroupRepo([{ event_id: 1, shared_by: 100 }], 1);
    const eventRepo = makeEventRepo(); // all return null
    const ctx = makeCallbackCtx();
    await handleGroupAgendaCallback(ctx as never, groupRepo as never, eventRepo as never, 0);
    expect(ctx.answer).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('deleted');
  });

  test('shows events and pagination for page 0', async () => {
    const groupRepo = makeGroupRepo([{ event_id: 1, shared_by: 100 }], 25);
    const eventRepo = makeEventRepo({
      1: { id: 1, title: 'Standup', start_at: '2026-03-15T10:00:00Z' },
    });
    const ctx = makeCallbackCtx();
    await handleGroupAgendaCallback(ctx as never, groupRepo as never, eventRepo as never, 0);
    expect(ctx.answer).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Standup');
    expect(msg).toContain('1/3');
    const opts = (ctx.editText.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(opts?.reply_markup).toBeDefined();
  });

  test('middle page shows prev and next buttons', async () => {
    const groupRepo = makeGroupRepo([{ event_id: 2, shared_by: 100 }], 25);
    const eventRepo = makeEventRepo({
      2: { id: 2, title: 'Review', start_at: '2026-03-15T14:00:00Z' },
    });
    const ctx = makeCallbackCtx();
    await handleGroupAgendaCallback(ctx as never, groupRepo as never, eventRepo as never, 1);
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('2/3');
  });

  test('Russian language uses Russian texts', async () => {
    const groupRepo = makeGroupRepo([], 0);
    const ctx = makeCallbackCtx('ru');
    await handleGroupAgendaCallback(ctx as never, groupRepo as never, {} as never, 0);
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Нет событий');
  });

  test('single page does not include pagination in options', async () => {
    const groupRepo = makeGroupRepo([{ event_id: 1, shared_by: 100 }], 1);
    const eventRepo = makeEventRepo({
      1: { id: 1, title: 'Solo', start_at: '2026-03-15T10:00:00Z' },
    });
    const ctx = makeCallbackCtx();
    await handleGroupAgendaCallback(ctx as never, groupRepo as never, eventRepo as never, 0);
    const opts = (ctx.editText.mock.calls[0] as unknown[])[1];
    expect(opts).toBeUndefined();
  });
});
