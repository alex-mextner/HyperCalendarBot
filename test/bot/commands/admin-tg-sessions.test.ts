// test/bot/commands/admin-tg-sessions.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { handleAdminTgSessions } from '../../../src/bot/commands/admin-tg-sessions.ts';

const ADMIN_ID = 42;

function makeCtx(overrides: { telegram_id?: number } = {}) {
  return {
    dbUser: { telegram_id: overrides.telegram_id ?? ADMIN_ID, language: 'en' as const },
    send: mock(() => Promise.resolve()),
  };
}

function makeSessionRepo(counts = { active: 3, expired: 1, revoked: 0 }) {
  return { countByStatus: () => counts };
}

function makeNotifRepo(
  deliveries: {
    id: number;
    user_id: number;
    type: string;
    status: string;
    created_at: string;
    sent_at: string | null;
    error: string | null;
  }[] = [],
) {
  return { recentByChannel: (_channel: string, _limit: number) => deliveries };
}

describe('handleAdminTgSessions', () => {
  test('rejects non-admin user', async () => {
    const ctx = makeCtx({ telegram_id: 999 });
    await handleAdminTgSessions(ctx as never, makeSessionRepo() as never, makeNotifRepo() as never, ADMIN_ID);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toBe('Admin only.');
  });

  test('rejects when no adminId configured', async () => {
    const ctx = makeCtx();
    await handleAdminTgSessions(ctx as never, makeSessionRepo() as never, makeNotifRepo() as never, undefined);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toBe('Admin only.');
  });

  test('shows session counts for admin', async () => {
    const ctx = makeCtx();
    await handleAdminTgSessions(
      ctx as never,
      makeSessionRepo({ active: 5, expired: 2, revoked: 1 }) as never,
      makeNotifRepo() as never,
      ADMIN_ID,
    );
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Total: 8');
    expect(msg).toContain('Active: 5');
    expect(msg).toContain('Expired: 2');
    expect(msg).toContain('Revoked: 1');
  });

  test('shows recent deliveries when present', async () => {
    const ctx = makeCtx();
    const deliveries = [
      {
        id: 1,
        user_id: 100,
        type: 'invitation',
        status: 'sent',
        created_at: '2026-04-10 12:00',
        sent_at: '2026-04-10 12:01',
        error: null,
      },
      {
        id: 2,
        user_id: 200,
        type: 'invitation',
        status: 'failed',
        created_at: '2026-04-10 11:00',
        sent_at: null,
        error: 'timeout',
      },
    ];
    await handleAdminTgSessions(ctx as never, makeSessionRepo() as never, makeNotifRepo(deliveries) as never, ADMIN_ID);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('mtproto_user deliveries');
    expect(msg).toContain('user:100');
    expect(msg).toContain('user:200');
    expect(msg).toContain('timeout');
  });

  test('shows no deliveries message when empty', async () => {
    const ctx = makeCtx();
    await handleAdminTgSessions(ctx as never, makeSessionRepo() as never, makeNotifRepo() as never, ADMIN_ID);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No mtproto_user deliveries yet');
  });

  test('returns early when dbUser is null', async () => {
    const ctx = { dbUser: undefined, send: mock(() => Promise.resolve()) };
    await handleAdminTgSessions(ctx as never, makeSessionRepo() as never, makeNotifRepo() as never, ADMIN_ID);
    expect(ctx.send).not.toHaveBeenCalled();
  });
});
