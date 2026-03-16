// test/bot/commands/call-settings.test.ts
import { describe, expect, mock, test } from 'bun:test';

describe('handleCallSettings', () => {
  test('shows current settings', async () => {
    const { handleCallSettings } = await import('../../../src/bot/commands/call-settings');
    const ctx = {
      args: null,
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const settingsRepo = {
      ensureDefaults: mock(() => {}),
      get: mock(() => ({
        enabled: 0,
        max_daily_calls: 5,
        language: 'en',
        quiet_hours_start: null,
        quiet_hours_end: null,
        important_only: 0,
      })),
    };
    await handleCallSettings(ctx as never, settingsRepo as never);
    expect(ctx.send).toHaveBeenCalled();
  });

  test('enables voice calls', async () => {
    const { handleCallSettings } = await import('../../../src/bot/commands/call-settings');
    const ctx = {
      args: 'on',
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const settingsRepo = {
      ensureDefaults: mock(() => {}),
      setEnabled: mock(() => {}),
      get: mock(() => ({ enabled: 1 })),
    };
    await handleCallSettings(ctx as never, settingsRepo as never);
    expect(settingsRepo.setEnabled).toHaveBeenCalledWith(100, true);
  });

  test('disables voice calls', async () => {
    const { handleCallSettings } = await import('../../../src/bot/commands/call-settings');
    const ctx = {
      args: 'off',
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const settingsRepo = {
      ensureDefaults: mock(() => {}),
      setEnabled: mock(() => {}),
      get: mock(() => ({ enabled: 0 })),
    };
    await handleCallSettings(ctx as never, settingsRepo as never);
    expect(settingsRepo.setEnabled).toHaveBeenCalledWith(100, false);
  });
});
