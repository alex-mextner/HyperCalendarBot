import { describe, expect, mock, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { encrypt } from '../../../src/utils/crypto.ts';

const user = {
  telegram_id: 100,
  language: 'en' as const,
  timezone: 'UTC',
  google_refresh_token_enc: null as string | null,
};

function makeCommandCtx(overrides = {}) {
  return {
    dbUser: { ...user },
    send: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('handleDisconnectGoogle', () => {
  test('sends not_configured when no google token', async () => {
    const { handleDisconnectGoogle } = await import('../../../src/bot/commands/disconnect-google.ts');
    const ctx = makeCommandCtx();

    await handleDisconnectGoogle(ctx as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('not configured');
  });

  test('sends not_configured in russian', async () => {
    const { handleDisconnectGoogle } = await import('../../../src/bot/commands/disconnect-google.ts');
    const ctx = makeCommandCtx({
      dbUser: { ...user, language: 'ru' },
    });

    await handleDisconnectGoogle(ctx as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('не настроена');
  });

  test('sends confirm prompt with keyboard when token exists', async () => {
    const { handleDisconnectGoogle } = await import('../../../src/bot/commands/disconnect-google.ts');
    const ctx = makeCommandCtx({
      dbUser: { ...user, google_refresh_token_enc: 'encrypted_token' },
    });

    await handleDisconnectGoogle(ctx as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const args = ctx.send.mock.calls[0] as unknown[];
    const msg = args[0] as string;
    expect(msg).toContain('Disconnect Google Calendar');
    expect(args[1]).toHaveProperty('reply_markup');
  });

  test('sends confirm prompt in russian', async () => {
    const { handleDisconnectGoogle } = await import('../../../src/bot/commands/disconnect-google.ts');
    const ctx = makeCommandCtx({
      dbUser: { ...user, language: 'ru', google_refresh_token_enc: 'enc' },
    });

    await handleDisconnectGoogle(ctx as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Отключить Google Calendar');
  });
});

describe('executeDisconnect', () => {
  test('calls all cleanup steps', async () => {
    const { executeDisconnect } = await import('../../../src/bot/commands/disconnect-google.ts');
    const deps = {
      config: { ENCRYPTION_KEY: 'test_key_32_chars_long_enough!!' },
      oauthService: { revokeToken: mock(() => Promise.resolve()) },
      userRepo: {
        findByTelegramId: mock(() => ({
          ...user,
          google_refresh_token_enc: null,
        })),
        clearGoogleToken: mock(() => {}),
      },
      eventRepo: { clearGoogleSync: mock(() => {}) },
      syncRepo: { deleteSyncState: mock(() => {}) },
      calendarRepo: {
        deleteWatchChannelsForUser: mock(() => {}),
        deleteUserCalendars: mock(() => {}),
      },
    };

    await executeDisconnect(100, deps as never);

    expect(deps.calendarRepo.deleteWatchChannelsForUser).toHaveBeenCalledWith(100);
    expect(deps.calendarRepo.deleteUserCalendars).toHaveBeenCalledWith(100);
    expect(deps.syncRepo.deleteSyncState).toHaveBeenCalledWith(100);
    expect(deps.userRepo.clearGoogleToken).toHaveBeenCalledWith(100);
    expect(deps.eventRepo.clearGoogleSync).toHaveBeenCalledWith(100);
  });

  test('calls stopWatchChannels when provided', async () => {
    const { executeDisconnect } = await import('../../../src/bot/commands/disconnect-google.ts');
    const stopWatchChannels = mock(() => Promise.resolve());
    const deps = {
      config: {},
      oauthService: { revokeToken: mock(() => Promise.resolve()) },
      userRepo: {
        findByTelegramId: mock(() => null),
        clearGoogleToken: mock(() => {}),
      },
      eventRepo: { clearGoogleSync: mock(() => {}) },
      syncRepo: { deleteSyncState: mock(() => {}) },
      calendarRepo: {
        deleteWatchChannelsForUser: mock(() => {}),
        deleteUserCalendars: mock(() => {}),
      },
      stopWatchChannels,
    };

    await executeDisconnect(100, deps as never);

    expect(stopWatchChannels).toHaveBeenCalledWith(100);
  });

  test('skips stopWatchChannels when not provided', async () => {
    const { executeDisconnect } = await import('../../../src/bot/commands/disconnect-google.ts');
    const deps = {
      config: {},
      oauthService: { revokeToken: mock(() => Promise.resolve()) },
      userRepo: {
        findByTelegramId: mock(() => null),
        clearGoogleToken: mock(() => {}),
      },
      eventRepo: { clearGoogleSync: mock(() => {}) },
      syncRepo: { deleteSyncState: mock(() => {}) },
      calendarRepo: {
        deleteWatchChannelsForUser: mock(() => {}),
        deleteUserCalendars: mock(() => {}),
      },
    };

    await executeDisconnect(100, deps as never);

    expect(deps.userRepo.clearGoogleToken).toHaveBeenCalledWith(100);
  });

  test('skips token revocation when user not found', async () => {
    const { executeDisconnect } = await import('../../../src/bot/commands/disconnect-google.ts');
    const deps = {
      config: { ENCRYPTION_KEY: 'key' },
      oauthService: { revokeToken: mock(() => Promise.resolve()) },
      userRepo: {
        findByTelegramId: mock(() => null),
        clearGoogleToken: mock(() => {}),
      },
      eventRepo: { clearGoogleSync: mock(() => {}) },
      syncRepo: { deleteSyncState: mock(() => {}) },
      calendarRepo: {
        deleteWatchChannelsForUser: mock(() => {}),
        deleteUserCalendars: mock(() => {}),
      },
    };

    await executeDisconnect(100, deps as never);

    expect(deps.oauthService.revokeToken).not.toHaveBeenCalled();
  });

  test('revokes token when user has encrypted token and ENCRYPTION_KEY is set', async () => {
    const { executeDisconnect } = await import('../../../src/bot/commands/disconnect-google.ts');
    const hexKey = randomBytes(32).toString('hex');
    const encryptedToken = encrypt('my-refresh-token', hexKey);
    const deps = {
      config: { ENCRYPTION_KEY: hexKey },
      oauthService: { revokeToken: mock(() => Promise.resolve()) },
      userRepo: {
        findByTelegramId: mock(() => ({
          ...user,
          google_refresh_token_enc: encryptedToken,
        })),
        clearGoogleToken: mock(() => {}),
      },
      eventRepo: { clearGoogleSync: mock(() => {}) },
      syncRepo: { deleteSyncState: mock(() => {}) },
      calendarRepo: {
        deleteWatchChannelsForUser: mock(() => {}),
        deleteUserCalendars: mock(() => {}),
      },
    };

    await executeDisconnect(100, deps as never);

    expect(deps.oauthService.revokeToken).toHaveBeenCalledWith('my-refresh-token');
  });

  test('skips token revocation when no ENCRYPTION_KEY', async () => {
    const { executeDisconnect } = await import('../../../src/bot/commands/disconnect-google.ts');
    const deps = {
      config: {},
      oauthService: { revokeToken: mock(() => Promise.resolve()) },
      userRepo: {
        findByTelegramId: mock(() => ({
          ...user,
          google_refresh_token_enc: 'encrypted',
        })),
        clearGoogleToken: mock(() => {}),
      },
      eventRepo: { clearGoogleSync: mock(() => {}) },
      syncRepo: { deleteSyncState: mock(() => {}) },
      calendarRepo: {
        deleteWatchChannelsForUser: mock(() => {}),
        deleteUserCalendars: mock(() => {}),
      },
    };

    await executeDisconnect(100, deps as never);

    expect(deps.oauthService.revokeToken).not.toHaveBeenCalled();
  });
});
