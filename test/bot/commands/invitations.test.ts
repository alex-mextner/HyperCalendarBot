// test/bot/commands/invitations.test.ts
import { describe, expect, mock, test } from 'bun:test';

describe('handleInvitations', () => {
  test('shows empty message when no invitations', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => []),
      getByInviter: mock(() => []),
    };
    const eventRepo = {
      findById: mock(() => null),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No invitations');
  });

  test('shows empty message in Russian', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'ru' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => []),
      getByInviter: mock(() => []),
    };
    const eventRepo = {
      findById: mock(() => null),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Нет приглашений');
  });

  test('lists received invitations with event title', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 200, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => [
        { id: 1, event_id: 5, inviter_id: 100, invitee_id: 200, status: 'pending', created_at: '2026-03-15T10:00:00Z' },
      ]),
      getByInviter: mock(() => []),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Party', start_at: '2026-03-15T18:00:00Z' })),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Party');
    expect(msg).toContain('⏳');
  });

  test('lists sent invitations with event title', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => []),
      getByInviter: mock(() => [
        { id: 1, event_id: 5, inviter_id: 100, invitee_id: 200, status: 'pending', created_at: '2026-03-15T10:00:00Z' },
      ]),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Meeting', start_at: '2026-03-15T10:00:00Z' })),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Meeting');
  });

  test('shows both received and sent sections', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => [
        {
          id: 1,
          event_id: 5,
          inviter_id: 200,
          invitee_id: 100,
          status: 'accepted',
          created_at: '2026-03-15T10:00:00Z',
        },
      ]),
      getByInviter: mock(() => [
        {
          id: 2,
          event_id: 6,
          inviter_id: 100,
          invitee_id: 300,
          status: 'declined',
          created_at: '2026-03-15T10:00:00Z',
        },
      ]),
    };
    const eventRepo = {
      findById: mock((id: number) => {
        if (id === 5) return { title: 'Received Event', start_at: '2026-03-15T18:00:00Z' };
        if (id === 6) return { title: 'Sent Event', start_at: '2026-03-16T10:00:00Z' };
        return null;
      }),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Received Event');
    expect(msg).toContain('Sent Event');
    expect(msg).toContain('✅');
    expect(msg).toContain('❌');
  });

  test('skips invitations where event is not found', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => [
        {
          id: 1,
          event_id: 999,
          inviter_id: 200,
          invitee_id: 100,
          status: 'pending',
          created_at: '2026-03-15T10:00:00Z',
        },
      ]),
      getByInviter: mock(() => []),
    };
    const eventRepo = {
      findById: mock(() => null),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    // Should still show something (either empty or the header without items)
  });

  test('status emojis are correct for all statuses', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const statuses = ['pending', 'accepted', 'declined', 'maybe', 'cancelled', 'expired'] as const;
    const expectedEmojis = ['⏳', '✅', '❌', '🤔', '🚫', '⌛'];
    const invitations = statuses.map((status, i) => ({
      id: i + 1,
      event_id: 10 + i,
      inviter_id: 200,
      invitee_id: 100,
      status,
      created_at: '2026-03-15T10:00:00Z',
    }));
    const invRepo = {
      getByInvitee: mock(() => invitations),
      getByInviter: mock(() => []),
    };
    const eventRepo = {
      findById: mock((_id: number) => ({ title: `Event`, start_at: '2026-03-15T18:00:00Z' })),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    for (const emoji of expectedEmojis) {
      expect(msg).toContain(emoji);
    }
  });
});
