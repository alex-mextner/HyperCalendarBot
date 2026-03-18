// test/bot/commands/invite.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { handleInvite } from '../../../src/bot/commands/invite.ts';

describe('handleInvite', () => {
  test('shows usage when args are missing', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      args: '',
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {},
      eventService: {},
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);
    expect(ctx.send).toHaveBeenCalled();
  });

  test('shows usage when args are invalid', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      args: 'abc xyz',
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {},
      eventService: {},
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);
    expect(ctx.send).toHaveBeenCalled();
  });

  test('shows error when sendInvitation fails', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', first_name: 'Alex' },
      args: '200 1',
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {
        sendInvitation: mock(() => ({ success: false, error: 'Already invited' })),
      },
      eventService: {},
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Already invited');
  });

  test('sends invitation and delivers message on success', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', first_name: 'Alex', username: 'alex' },
      args: '200 5',
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: {
        sendInvitation: mock(() => ({ success: true, invitation: { id: 42 } })),
      },
      eventService: {
        getEvent: mock(() => ({ id: 5, title: 'Party' })),
      },
      invRepo: {
        setMessageInfo: mock(() => {}),
      },
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 555 })),
    };

    await handleInvite(ctx as never, deps as never);
    expect(deps.sendMessage).toHaveBeenCalled();
    const [chatId] = deps.sendMessage.mock.calls[0] as unknown[];
    expect(chatId).toBe(200);
    expect(deps.invRepo.setMessageInfo).toHaveBeenCalledWith(42, 555, 200);
    // Should confirm delivery to the sender
    expect(ctx.send).toHaveBeenCalled();
  });

  test('sends deep link when user blocked bot (403)', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', first_name: 'Alex' },
      args: '200 5',
      send: mock(() => Promise.resolve()),
    };
    const forbidden = Object.assign(new Error('Forbidden'), { statusCode: 403 });
    const deps = {
      invitationService: {
        sendInvitation: mock(() => ({ success: true, invitation: { id: 42 } })),
      },
      eventService: {
        getEvent: mock(() => ({ id: 5, title: 'Party' })),
      },
      invRepo: {},
      deepLinkService: {
        createInvitationLink: mock(() => ({ code: 'abc123' })),
        generateUrl: mock(() => 'https://t.me/bot?start=abc123'),
      },
      sendMessage: mock(() => Promise.reject(forbidden)),
    };

    await handleInvite(ctx as never, deps as never);
    expect(deps.deepLinkService.createInvitationLink).toHaveBeenCalledWith(42, 5, 100);
    expect(ctx.send).toHaveBeenCalled();
  });

  test('re-throws non-403 errors', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', first_name: 'Alex' },
      args: '200 5',
      send: mock(() => Promise.resolve()),
    };
    const serverError = Object.assign(new Error('Server Error'), { statusCode: 500 });
    const deps = {
      invitationService: {
        sendInvitation: mock(() => ({ success: true, invitation: { id: 42 } })),
      },
      eventService: {
        getEvent: mock(() => ({ id: 5, title: 'Party' })),
      },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.reject(serverError)),
    };

    await expect(handleInvite(ctx as never, deps as never)).rejects.toThrow('Server Error');
  });
});
