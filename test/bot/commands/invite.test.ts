// test/bot/commands/invite.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { handleInvite } from '../../../src/bot/commands/invite.ts';
import { EVENT_PICKER_PAGE_SIZE } from '../../../src/bot/keyboards.ts';

const makeEvent = (id: number) => ({
  id,
  user_id: 100,
  title: `Event ${id}`,
  start_at: '2026-03-20T10:00:00Z',
  end_at: '2026-03-20T11:00:00Z',
  all_day: 0,
  timezone: 'UTC',
  description: null,
  category: null,
  location: null,
  recurrence_rule: null,
  recurrence_end_at: null,
  parent_event_id: null,
  original_start_at: null,
  is_cancelled: 0,
  is_deleted: 0,
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
});

describe('handleInvite', () => {
  test('shows no-events message in ru when no upcoming events', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {},
      eventService: { getUpcoming: mock(() => []) },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('нет предстоящих'));
  });

  test('shows no-events message in en when no upcoming events', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {},
      eventService: { getUpcoming: mock(() => []) },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('no upcoming events'));
  });

  test('shows event picker in ru when events exist', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {},
      eventService: { getUpcoming: mock(() => [makeEvent(1), makeEvent(2)]) },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);
    expect(ctx.send).toHaveBeenCalledWith(
      expect.stringContaining('Выберите событие'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  test('shows event picker in en when events exist', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {},
      eventService: { getUpcoming: mock(() => [makeEvent(5)]) },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);
    expect(ctx.send).toHaveBeenCalledWith(
      expect.stringContaining('Select an event'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  test('calls getUpcoming with user telegram_id and limit 10', async () => {
    const ctx = {
      dbUser: { telegram_id: 42, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const getUpcoming = mock(() => []);
    const deps = {
      invitationService: {},
      eventService: { getUpcoming },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);
    expect(getUpcoming).toHaveBeenCalledWith(42, EVENT_PICKER_PAGE_SIZE + 1);
  });

  test('in group shows group events picker using getUpcomingForGroup', async () => {
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const getUpcomingForGroup = mock(() => [
      {
        event: makeEvent(5),
        occurrence_start: makeEvent(5).start_at,
        occurrence_end: makeEvent(5).end_at,
        is_exception: false,
      },
    ]);
    const getUpcoming = mock(() => []);
    const deps = {
      invitationService: {},
      eventService: { getUpcoming, getUpcomingForGroup },
      invRepo: {},
      deepLinkService: {},
      groupRepo: { getTimezone: mock(() => 'Europe/Moscow') },
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };
    await handleInvite(ctx as never, deps as never);
    expect(getUpcomingForGroup).toHaveBeenCalledWith(-100, EVENT_PICKER_PAGE_SIZE + 1);
    expect(getUpcoming).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledWith(
      expect.stringContaining('Выберите событие'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  test('in group with no events shows empty message', async () => {
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: { telegram_id: 1, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {},
      eventService: { getUpcoming: mock(() => []), getUpcomingForGroup: mock(() => []) },
      invRepo: {},
      deepLinkService: {},
      groupRepo: { getTimezone: mock(() => null) },
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };
    await handleInvite(ctx as never, deps as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No group events');
  });

  test('exactly 10 events: no forward pagination button', async () => {
    const events = Array.from({ length: 10 }, (_, i) => makeEvent(i + 1));
    const ctx = {
      dbUser: { telegram_id: 42, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {},
      eventService: { getUpcoming: mock(() => events) },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);

    const opts = (ctx.send.mock.calls[0] as unknown[])[1] as { reply_markup?: unknown };
    const kb = JSON.stringify(opts.reply_markup);
    expect(kb).not.toContain('▶️');
  });

  test('exactly 11 events (one over the page): shows forward pagination button', async () => {
    const events = Array.from({ length: 11 }, (_, i) => makeEvent(i + 1));
    const ctx = {
      dbUser: { telegram_id: 42, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {},
      eventService: { getUpcoming: mock(() => events) },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);

    const opts = (ctx.send.mock.calls[0] as unknown[])[1] as { reply_markup?: unknown };
    const kb = JSON.stringify(opts.reply_markup);
    expect(kb).toContain('▶️');
    expect((kb.match(/"invp:\d+"/g) ?? []).length).toBe(10);
  });

  test('25 events: over-fetch respects the requested limit and renders only the first page', async () => {
    const events = Array.from({ length: 25 }, (_, i) => makeEvent(i + 1));
    const getUpcoming = mock((_id: number, limit: number) => events.slice(0, limit));
    const ctx = {
      dbUser: { telegram_id: 42, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {},
      eventService: { getUpcoming },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);

    expect(getUpcoming).toHaveBeenCalledWith(42, EVENT_PICKER_PAGE_SIZE + 1);
    const opts = (ctx.send.mock.calls[0] as unknown[])[1] as { reply_markup?: unknown };
    const kb = JSON.stringify(opts.reply_markup);
    expect(kb).toContain('▶️');
    expect(kb).not.toContain('◀️');
  });
});
