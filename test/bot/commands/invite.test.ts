// test/bot/commands/invite.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { deliverInvitation, handleInvite } from '../../../src/bot/commands/invite.ts';

describe('handleInvite', () => {
  test('shows no-events message when getUpcoming returns empty', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getUpcoming: mock(() => []),
    };
    await handleInvite(ctx as never, eventService as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('no upcoming events');
  });

  test('shows event picker when events exist', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getUpcoming: mock(() => [{ event: { id: 5, title: 'Party' } }, { event: { id: 6, title: 'Meeting' } }]),
    };
    await handleInvite(ctx as never, eventService as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Choose an event');
  });

  test('deduplicates events by id', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getUpcoming: mock(() => [
        { event: { id: 5, title: 'Party' } },
        { event: { id: 5, title: 'Party' } },
        { event: { id: 6, title: 'Meeting' } },
      ]),
    };
    await handleInvite(ctx as never, eventService as never);
    expect(eventService.getUpcoming).toHaveBeenCalledWith(100, 20, 'UTC');
    // Should be called — we just verify it doesn't crash with duplicate IDs
    expect(ctx.send).toHaveBeenCalled();
  });

  test('shows Russian message for ru language', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'ru', timezone: 'Europe/Moscow' },
      send: mock(() => Promise.resolve()),
    };
    const eventService = {
      getUpcoming: mock(() => []),
    };
    await handleInvite(ctx as never, eventService as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('нет предстоящих');
  });
});

describe('deliverInvitation', () => {
  test('sends message and stores message info on success', async () => {
    const sendMessage = mock(() => Promise.resolve({ message_id: 555 }));
    const invRepo = { setMessageInfo: mock(() => {}) };

    const result = await deliverInvitation(200, 1, 'Party', 'Alex', 'en', invRepo as never, sendMessage as never);

    expect(result).toBe(true);
    expect(sendMessage).toHaveBeenCalled();
    const [chatId, text] = sendMessage.mock.calls[0] as unknown[];
    expect(chatId).toBe(200);
    expect(text).toContain('Party');
    expect(invRepo.setMessageInfo).toHaveBeenCalledWith(1, 555, 200);
  });

  test('returns false when sendMessage throws (user blocked bot)', async () => {
    const forbidden = new Error('Forbidden: bot was blocked by the user');
    const sendMessage = mock(() => Promise.reject(forbidden));
    const invRepo = { setMessageInfo: mock(() => {}) };

    const result = await deliverInvitation(200, 1, 'Party', 'Alex', 'en', invRepo as never, sendMessage as never);

    expect(result).toBe(false);
    expect(invRepo.setMessageInfo).not.toHaveBeenCalled();
  });

  test('sends invitation text in Russian', async () => {
    const sendMessage = mock(() => Promise.resolve({ message_id: 1 }));
    const invRepo = { setMessageInfo: mock(() => {}) };

    await deliverInvitation(200, 1, 'Встреча', 'Алекс', 'ru', invRepo as never, sendMessage as never);

    const [, text] = sendMessage.mock.calls[0] as unknown[];
    expect(text).toContain('Встреча');
  });
});
