import { describe, expect, mock, test } from 'bun:test';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import type { SharingSettings } from '../../../src/database/types.ts';

function makeSettings(overrides: Partial<SharingSettings> = {}): SharingSettings {
  return {
    user_id: 100,
    default_visibility: 'private',
    inline_mode_enabled: 1,
    allow_invitations: 1,
    share_location: 0,
    share_description: 0,
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<Pick<BotCommandContext, 'args'>> = {}) {
  return {
    args: null,
    dbUser: { telegram_id: 100, language: 'en' as const },
    send: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makeRepo(settings: SharingSettings = makeSettings()) {
  return {
    ensureDefaults: mock(() => {}),
    get: mock(() => settings),
    update: mock(() => {}),
  } as unknown as SharingSettingsRepository;
}

describe('handlePrivacy', () => {
  test('shows current settings when no args', async () => {
    const { handlePrivacy } = await import('../../../src/bot/commands/privacy.ts');
    const ctx = makeCtx();
    const repo = makeRepo();

    await handlePrivacy(ctx as never, repo);

    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('private');
  });

  test('shows current settings when args is empty string', async () => {
    const { handlePrivacy } = await import('../../../src/bot/commands/privacy.ts');
    const ctx = makeCtx({ args: '  ' });
    const repo = makeRepo();

    await handlePrivacy(ctx as never, repo);

    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('private');
  });

  test('updates default visibility', async () => {
    const { handlePrivacy } = await import('../../../src/bot/commands/privacy.ts');
    const ctx = makeCtx({ args: 'default full' });
    const repo = makeRepo();

    await handlePrivacy(ctx as never, repo);

    expect(repo.update as ReturnType<typeof mock>).toHaveBeenCalledWith(100, { default_visibility: 'full' });
  });

  test('accepts free_busy visibility', async () => {
    const { handlePrivacy } = await import('../../../src/bot/commands/privacy.ts');
    const ctx = makeCtx({ args: 'default free_busy' });
    const repo = makeRepo();

    await handlePrivacy(ctx as never, repo);

    expect(repo.update as ReturnType<typeof mock>).toHaveBeenCalledWith(100, { default_visibility: 'free_busy' });
  });

  test('rejects invalid visibility level', async () => {
    const { handlePrivacy } = await import('../../../src/bot/commands/privacy.ts');
    const ctx = makeCtx({ args: 'default invalid' });
    const repo = makeRepo();

    await handlePrivacy(ctx as never, repo);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('private');
    expect(msg).toContain('free_busy');
    expect(msg).toContain('full');
    expect(repo.update as ReturnType<typeof mock>).not.toHaveBeenCalled();
  });

  test('shows usage hint for unknown subcommand', async () => {
    const { handlePrivacy } = await import('../../../src/bot/commands/privacy.ts');
    const ctx = makeCtx({ args: 'unknown' });
    const repo = makeRepo();

    await handlePrivacy(ctx as never, repo);

    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('/privacy default');
  });

  test('sends confirmation after successful update', async () => {
    const { handlePrivacy } = await import('../../../src/bot/commands/privacy.ts');
    const ctx = makeCtx({ args: 'default full' });
    const repo = makeRepo();

    await handlePrivacy(ctx as never, repo);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('full');
  });

  test('uses russian translation when language is ru', async () => {
    const { handlePrivacy } = await import('../../../src/bot/commands/privacy.ts');
    const ctx = {
      args: null,
      dbUser: { telegram_id: 100, language: 'ru' as const },
      send: mock(() => Promise.resolve()),
    };
    const repo = makeRepo();

    await handlePrivacy(ctx as never, repo);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Текущая видимость');
  });
});
