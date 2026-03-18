// test/bot/commands/invite.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { handleInvite } from '../../../src/bot/commands/invite.ts';

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
    expect(getUpcoming).toHaveBeenCalledWith(42, 10);
  });
});
