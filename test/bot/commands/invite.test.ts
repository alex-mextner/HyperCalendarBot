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
      eventService: {
        getEvent: mock(() => ({ id: 1, title: 'Test', start_at: null, end_at: null })),
      },
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

  test('shows conflict UI when invitee has schedule conflict', async () => {
    const photo = mock(() => Promise.resolve());
    const ctx = {
      dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC', first_name: 'Alex', username: 'alex' },
      args: '200 5',
      send: mock(() => Promise.resolve()),
      sendPhoto: photo,
    };
    const conflictService = {
      checkConflicts: mock(() => [
        {
          userId: 200,
          username: 'bob',
          hasConflict: true,
          conflictingEvents: [{ title: null, startAt: '2026-03-20T09:30:00.000Z', endAt: '2026-03-20T10:30:00.000Z' }],
        },
      ]),
    };
    const renderService = {
      renderDirect: mock(() => Promise.resolve(Buffer.from('png'))),
    };
    const deps = {
      invitationService: { sendInvitation: mock(() => ({ success: true, invitation: { id: 42 } })) },
      eventService: {
        getEvent: mock(() => ({
          id: 5,
          title: 'Party',
          start_at: '2026-03-20T10:00:00.000Z',
          end_at: '2026-03-20T11:00:00.000Z',
        })),
        getEventsInRange: mock(() => []),
      },
      invRepo: { setMessageInfo: mock(() => {}) },
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      conflictService,
      renderService,
    };

    await handleInvite(ctx as never, deps as never);
    expect(photo).toHaveBeenCalled();
    // sendInvitation should NOT be called — waiting for user action
    expect(deps.invitationService.sendInvitation).not.toHaveBeenCalled();
  });

  test('skips conflict check when no conflictService provided', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', first_name: 'Alex', username: 'alex' },
      args: '200 5',
      send: mock(() => Promise.resolve()),
    };
    const deps = {
      invitationService: { sendInvitation: mock(() => ({ success: true, invitation: { id: 42 } })) },
      eventService: {
        getEvent: mock(() => ({
          id: 5,
          title: 'Party',
          start_at: '2026-03-20T10:00:00.000Z',
          end_at: '2026-03-20T11:00:00.000Z',
        })),
      },
      invRepo: { setMessageInfo: mock(() => {}) },
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    };

    await handleInvite(ctx as never, deps as never);
    expect(deps.invitationService.sendInvitation).toHaveBeenCalled();
  });

  test('proceeds without conflict image when render fails', async () => {
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', first_name: 'Alex' },
      args: '200 5',
      send: mock(() => Promise.resolve()),
      sendPhoto: mock(() => Promise.reject(new Error('render fail'))),
    };
    const conflictService = {
      checkConflicts: mock(() => [
        {
          userId: 200,
          username: 'bob',
          hasConflict: true,
          conflictingEvents: [{ title: null, startAt: '2026-03-20T09:30:00.000Z', endAt: '2026-03-20T10:30:00.000Z' }],
        },
      ]),
    };
    const renderService = {
      renderDirect: mock(() => Promise.reject(new Error('render fail'))),
    };
    const deps = {
      invitationService: { sendInvitation: mock(() => ({ success: true, invitation: { id: 42 } })) },
      eventService: {
        getEvent: mock(() => ({
          id: 5,
          title: 'Party',
          start_at: '2026-03-20T10:00:00.000Z',
          end_at: '2026-03-20T11:00:00.000Z',
        })),
        getEventsInRange: mock(() => []),
      },
      invRepo: {},
      deepLinkService: {},
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      conflictService,
      renderService,
    };

    await handleInvite(ctx as never, deps as never);
    // Falls back to text send with keyboard
    expect(ctx.send).toHaveBeenCalled();
    expect(deps.invitationService.sendInvitation).not.toHaveBeenCalled();
  });
});
