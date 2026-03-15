// test/bot/commands/invite.test.ts
import { describe, expect, mock, test } from 'bun:test';

describe('handleInvite', () => {
  test('shows usage when no args', async () => {
    const { handleInvite } = await import('../../../src/bot/commands/invite.ts');
    const ctx = {
      args: null,
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    await handleInvite(
      ctx as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mock(() => Promise.resolve({ message_id: 1 })) as never,
    );
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('/invite');
  });

  test('shows usage when only user ID provided', async () => {
    const { handleInvite } = await import('../../../src/bot/commands/invite.ts');
    const ctx = {
      args: '200',
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    await handleInvite(
      ctx as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mock(() => Promise.resolve({ message_id: 1 })) as never,
    );
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('/invite');
  });

  test('shows usage when args are not numbers', async () => {
    const { handleInvite } = await import('../../../src/bot/commands/invite.ts');
    const ctx = {
      args: 'abc def',
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    await handleInvite(
      ctx as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mock(() => Promise.resolve({ message_id: 1 })) as never,
    );
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('/invite');
  });

  test('sends invitation and delivers message on valid args', async () => {
    const { handleInvite } = await import('../../../src/bot/commands/invite.ts');
    const sendMessage = mock(() => Promise.resolve({ message_id: 555 }));
    const ctx = {
      args: '200 5',
      dbUser: { telegram_id: 100, language: 'en', first_name: 'Alex' },
      send: mock(() => Promise.resolve()),
    };
    const invitationService = {
      sendInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'pending', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const eventService = {
      getEvent: mock(() => ({
        title: 'Party',
        start_at: '2026-03-15T18:00:00Z',
        timezone: 'UTC',
        location: null,
        description: null,
      })),
    };
    const invRepo = {
      setMessageInfo: mock(() => {}),
    };
    const deepLinkService = {
      createInvitationLink: mock(() => ({ code: 'i_abc123' })),
      generateUrl: mock(() => 'https://t.me/TestBot?start=i_abc123'),
    };
    await handleInvite(
      ctx as never,
      invitationService as never,
      eventService as never,
      invRepo as never,
      deepLinkService as never,
      sendMessage as never,
    );
    expect(invitationService.sendInvitation).toHaveBeenCalledWith(5, 100, 200);
    expect(eventService.getEvent).toHaveBeenCalledWith(5, 100);
    expect(sendMessage).toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalled();
    // Confirmation sent to inviter
    const inviterMsg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(inviterMsg).toContain('Party');
  });

  test('stores message info after successful delivery', async () => {
    const { handleInvite } = await import('../../../src/bot/commands/invite.ts');
    const sendMessage = mock(() => Promise.resolve({ message_id: 555 }));
    const ctx = {
      args: '200 5',
      dbUser: { telegram_id: 100, language: 'en', first_name: 'Alex' },
      send: mock(() => Promise.resolve()),
    };
    const invitationService = {
      sendInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'pending', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const eventService = {
      getEvent: mock(() => ({
        title: 'Party',
        start_at: '2026-03-15T18:00:00Z',
        timezone: 'UTC',
        location: null,
        description: null,
      })),
    };
    const invRepo = {
      setMessageInfo: mock(() => {}),
    };
    const deepLinkService = {
      createInvitationLink: mock(() => ({ code: 'i_abc123' })),
      generateUrl: mock(() => 'https://t.me/TestBot?start=i_abc123'),
    };
    await handleInvite(
      ctx as never,
      invitationService as never,
      eventService as never,
      invRepo as never,
      deepLinkService as never,
      sendMessage as never,
    );
    expect(invRepo.setMessageInfo).toHaveBeenCalledWith(1, 555, 200);
  });

  test('shows error when invitation fails', async () => {
    const { handleInvite } = await import('../../../src/bot/commands/invite.ts');
    const ctx = {
      args: '200 5',
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const invitationService = {
      sendInvitation: mock(() => ({
        success: false,
        error: 'Event not found',
      })),
    };
    await handleInvite(
      ctx as never,
      invitationService as never,
      {} as never,
      {} as never,
      {} as never,
      mock(() => Promise.resolve({ message_id: 1 })) as never,
    );
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Event not found');
  });

  test('falls back to deep link on 403 (user blocked bot)', async () => {
    const { handleInvite } = await import('../../../src/bot/commands/invite.ts');
    const forbidden = new Error('Forbidden: bot was blocked by the user');
    (forbidden as Record<string, unknown>).statusCode = 403;
    const sendMessage = mock(() => Promise.reject(forbidden));
    const ctx = {
      args: '200 5',
      dbUser: { telegram_id: 100, language: 'en', first_name: 'Alex' },
      send: mock(() => Promise.resolve()),
    };
    const invitationService = {
      sendInvitation: mock(() => ({
        success: true,
        invitation: { id: 1, status: 'pending', event_id: 5, inviter_id: 100, invitee_id: 200 },
      })),
    };
    const eventService = {
      getEvent: mock(() => ({
        title: 'Party',
        start_at: '2026-03-15T18:00:00Z',
        timezone: 'UTC',
        location: null,
        description: null,
      })),
    };
    const invRepo = {
      setMessageInfo: mock(() => {}),
    };
    const deepLinkService = {
      createInvitationLink: mock(() => ({ code: 'i_fallback' })),
      generateUrl: mock(() => 'https://t.me/TestBot?start=i_fallback'),
    };
    await handleInvite(
      ctx as never,
      invitationService as never,
      eventService as never,
      invRepo as never,
      deepLinkService as never,
      sendMessage as never,
    );
    expect(deepLinkService.createInvitationLink).toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalled();
    const inviterMsg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(inviterMsg).toContain('https://t.me/TestBot?start=i_fallback');
  });

  test('shows invitation_already_sent when duplicate', async () => {
    const { handleInvite } = await import('../../../src/bot/commands/invite.ts');
    const ctx = {
      args: '200 5',
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const invitationService = {
      sendInvitation: mock(() => ({
        success: false,
        error: 'Invitation already sent',
      })),
    };
    await handleInvite(
      ctx as never,
      invitationService as never,
      {} as never,
      {} as never,
      {} as never,
      mock(() => Promise.resolve({ message_id: 1 })) as never,
    );
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('already sent');
  });
});
