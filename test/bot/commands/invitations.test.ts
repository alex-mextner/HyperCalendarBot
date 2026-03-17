// test/bot/commands/invitations.test.ts
import { describe, expect, mock, test } from 'bun:test';

describe('handleInvitations', () => {
  test('shows empty message when no invitations', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
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
      dbUser: { telegram_id: 100, language: 'ru', timezone: 'Europe/Kyiv' },
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

  test('lists received invitations with event title, date and inviter name', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 200, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => [
        { id: 1, event_id: 5, inviter_id: 100, invitee_id: 200, status: 'pending', created_at: '2026-03-15T10:00:00Z' },
      ]),
      getByInviter: mock(() => []),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Party', start_at: '2026-03-15T18:00:00Z', all_day: 0 })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ first_name: 'Alex', telegram_id: 100 })),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never, userRepo as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Party');
    expect(msg).toContain('⏳');
    expect(msg).toContain('18:00');
    expect(msg).toContain('from Alex');
  });

  test('lists sent invitations with event title, date and invitee name', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => []),
      getByInviter: mock(() => [
        { id: 1, event_id: 5, inviter_id: 100, invitee_id: 200, status: 'pending', created_at: '2026-03-15T10:00:00Z' },
      ]),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Meeting', start_at: '2026-03-15T10:00:00Z', all_day: 0 })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ first_name: 'Maria', telegram_id: 200 })),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never, userRepo as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Meeting');
    expect(msg).toContain('10:00');
    expect(msg).toContain('to Maria');
  });

  test('shows both received and sent sections', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
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
        if (id === 5) return { title: 'Received Event', start_at: '2026-03-15T18:00:00Z', all_day: 0 };
        if (id === 6) return { title: 'Sent Event', start_at: '2026-03-16T10:00:00Z', all_day: 0 };
        return null;
      }),
    };
    const userRepo = {
      findByTelegramId: mock((telegramId: number) => {
        if (telegramId === 200) return { first_name: 'Bob', telegram_id: 200 };
        if (telegramId === 300) return { first_name: 'Eve', telegram_id: 300 };
        return null;
      }),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never, userRepo as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Received Event');
    expect(msg).toContain('Sent Event');
    expect(msg).toContain('✅');
    expect(msg).toContain('❌');
    expect(msg).toContain('from Bob');
    expect(msg).toContain('to Eve');
  });

  test('skips invitations where event is not found', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
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
  });

  test('status emojis are correct for all statuses', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
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
      findById: mock(() => ({ title: 'Event', start_at: '2026-03-15T18:00:00Z', all_day: 0 })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ first_name: 'Test', telegram_id: 200 })),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never, userRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    for (const emoji of expectedEmojis) {
      expect(msg).toContain(emoji);
    }
  });

  test('works without userRepo (backward compatible)', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 200, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => [
        { id: 1, event_id: 5, inviter_id: 100, invitee_id: 200, status: 'pending', created_at: '2026-03-15T10:00:00Z' },
      ]),
      getByInviter: mock(() => []),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Party', start_at: '2026-03-15T18:00:00Z', all_day: 0 })),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Party');
    expect(msg).toContain('from #100');
  });

  test('shows all-day event without time', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 200, language: 'en', timezone: 'UTC' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => [
        { id: 1, event_id: 5, inviter_id: 100, invitee_id: 200, status: 'pending', created_at: '2026-03-15T10:00:00Z' },
      ]),
      getByInviter: mock(() => []),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Birthday', start_at: '2026-03-15T00:00:00Z', all_day: 1 })),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Birthday');
    // All-day event should not show "00:00" time
    expect(msg).not.toContain('00:00');
  });

  test('Russian locale shows correct labels', async () => {
    const { handleInvitations } = await import('../../../src/bot/commands/invitations.ts');
    const ctx = {
      dbUser: { telegram_id: 200, language: 'ru', timezone: 'Europe/Kyiv' },
      send: mock(() => Promise.resolve()),
    };
    const invRepo = {
      getByInvitee: mock(() => [
        { id: 1, event_id: 5, inviter_id: 100, invitee_id: 200, status: 'pending', created_at: '2026-03-15T10:00:00Z' },
      ]),
      getByInviter: mock(() => []),
    };
    const eventRepo = {
      findById: mock(() => ({ title: 'Вечеринка', start_at: '2026-03-15T18:00:00Z', all_day: 0 })),
    };
    const userRepo = {
      findByTelegramId: mock(() => ({ first_name: 'Алекс', telegram_id: 100 })),
    };
    await handleInvitations(ctx as never, invRepo as never, eventRepo as never, userRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Полученные');
    expect(msg).toContain('от Алекс');
    expect(msg).toContain('Вечеринка');
  });
});
