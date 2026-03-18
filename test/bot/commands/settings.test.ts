import { describe, expect, mock, test } from 'bun:test';
import type { BotCallbackContext, BotCommandContext } from '../../../src/bot/types.ts';

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    telegram_id: 100,
    language: 'ru',
    timezone: 'Europe/Moscow',
    country_code: 'RU',
    ...overrides,
  };
}

function makeCommandCtx(user = makeUser()) {
  return {
    dbUser: user,
    send: mock(() => Promise.resolve()),
  } as unknown as BotCommandContext;
}

function makeCallbackCtx() {
  return {
    dbUser: makeUser(),
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
  } as unknown as BotCallbackContext;
}

function makePrefsService(overrides: Record<string, unknown> = {}) {
  return {
    getOrCreate: mock(() => ({
      user_id: 100,
      morning_agenda_enabled: 1,
      morning_agenda_time: '08:00',
      default_reminder_intervals: '[15]',
      evening_review_enabled: 0,
      evening_review_time: '21:00',
      quiet_hours_enabled: 0,
      quiet_hours_start: '23:00',
      quiet_hours_end: '07:00',
      ...overrides,
    })),
    toggleMorningAgenda: mock(() => {}),
    toggleEveningReview: mock(() => {}),
    toggleQuietHours: mock(() => {}),
  };
}

describe('handleSettings', () => {
  test('sends category picker keyboard', async () => {
    const { handleSettings } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCommandCtx();

    await handleSettings(ctx);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.send.mock.calls[0] as [string, { reply_markup: unknown }];
    expect(text).toContain('Настройки');
    expect(opts?.reply_markup).toBeDefined();
  });
});

describe('settingsCategoryKeyboard', () => {
  test('returns InlineKeyboard instance', async () => {
    const { settingsCategoryKeyboard } = await import('../../../src/bot/commands/settings.ts');
    const kb = settingsCategoryKeyboard();
    expect(kb).toBeDefined();
    // InlineKeyboard serialises to { inline_keyboard: [...] }
    const serialized = kb.toJSON?.() ?? (kb as unknown as { inline_keyboard: unknown[][] }).inline_keyboard;
    expect(serialized).toBeDefined();
  });
});

describe('handleSettingsCallback', () => {
  test('stg:back shows category picker', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'back', prefsService as never);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).toHaveBeenCalledTimes(1);
    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Настройки');
  });

  test('stg:general shows timezone and language', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'general', prefsService as never);

    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Europe/Moscow');
    expect(text).toContain('Русский');
    expect(text).toContain('RU');
  });

  test('stg:notifications shows prefs state', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'notifications', prefsService as never);

    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('08:00');
    expect(text).toContain('15');
  });

  test('stg:notifications shows enabled morning and disabled evening', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService({ morning_agenda_enabled: 1, evening_review_enabled: 0 });

    await handleSettingsCallback(ctx, makeUser() as never, 'notifications', prefsService as never);

    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('✅');
    expect(text).toContain('❌');
  });

  test('stg:calls without repo shows defaults', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'calls', prefsService as never);

    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Голосовые звонки');
    expect(text).toContain('❌');
  });

  test('stg:calls with repo shows enabled state', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();
    const callSettingsRepo = {
      ensureDefaults: mock(() => {}),
      get: mock(() => ({ enabled: 1, language: 'ru' })),
    };

    await handleSettingsCallback(ctx, makeUser() as never, 'calls', prefsService as never, callSettingsRepo as never);

    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('✅');
    expect(text).toContain('Голосовые звонки');
  });

  test('stg:privacy without repo shows defaults', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'privacy', prefsService as never);

    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Приватность');
    expect(text).toContain('Приватно');
  });

  test('stg:privacy with repo shows actual values', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();
    const sharingSettingsRepo = {
      ensureDefaults: mock(() => {}),
      get: mock(() => ({
        default_visibility: 'full',
        inline_mode_enabled: 1,
        allow_invitations: 0,
      })),
    };

    await handleSettingsCallback(
      ctx,
      makeUser() as never,
      'privacy',
      prefsService as never,
      undefined,
      sharingSettingsRepo as never,
    );

    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Полный доступ');
    expect(text).toContain('✅'); // inline_mode_enabled
    expect(text).toContain('❌'); // allow_invitations false
  });

  test('stg:voice shows voice settings placeholder', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'voice', prefsService as never);

    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Голосовые ответы');
    expect(text).toContain('❌');
  });

  test('stg:toggle_morning calls toggleMorningAgenda and re-renders', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'toggle_morning', prefsService as never);

    expect(prefsService.toggleMorningAgenda).toHaveBeenCalledWith(100);
    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Уведомления');
  });

  test('stg:toggle_evening calls toggleEveningReview and re-renders', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'toggle_evening', prefsService as never);

    expect(prefsService.toggleEveningReview).toHaveBeenCalledWith(100);
    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Уведомления');
  });

  test('stg:toggle_quiet calls toggleQuietHours and re-renders', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'toggle_quiet', prefsService as never);

    expect(prefsService.toggleQuietHours).toHaveBeenCalledWith(100);
    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Уведомления');
  });

  test('stg:toggle_calls flips enabled and re-renders', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();
    const callSettingsRepo = {
      ensureDefaults: mock(() => {}),
      get: mock(() => ({ enabled: 0 })),
      setEnabled: mock(() => {}),
    };

    await handleSettingsCallback(
      ctx,
      makeUser() as never,
      'toggle_calls',
      prefsService as never,
      callSettingsRepo as never,
    );

    expect(callSettingsRepo.ensureDefaults).toHaveBeenCalledTimes(1);
    expect(callSettingsRepo.setEnabled).toHaveBeenCalledWith(100, true);
    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Голосовые звонки');
  });

  test('stg:cycle_visibility advances to next visibility', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();
    const sharingSettingsRepo = {
      ensureDefaults: mock(() => {}),
      get: mock(() => ({ default_visibility: 'private', inline_mode_enabled: 0, allow_invitations: 1 })),
      update: mock(() => {}),
    };

    await handleSettingsCallback(
      ctx,
      makeUser() as never,
      'cycle_visibility',
      prefsService as never,
      undefined,
      sharingSettingsRepo as never,
    );

    expect(sharingSettingsRepo.update).toHaveBeenCalledWith(100, { default_visibility: 'free_busy' });
    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Приватность');
  });

  test('stg:toggle_inline flips inline_mode_enabled', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();
    const sharingSettingsRepo = {
      ensureDefaults: mock(() => {}),
      get: mock(() => ({ default_visibility: 'private', inline_mode_enabled: 1, allow_invitations: 1 })),
      update: mock(() => {}),
    };

    await handleSettingsCallback(
      ctx,
      makeUser() as never,
      'toggle_inline',
      prefsService as never,
      undefined,
      sharingSettingsRepo as never,
    );

    expect(sharingSettingsRepo.update).toHaveBeenCalledWith(100, { inline_mode_enabled: 0 });
  });

  test('stg:toggle_invitations flips allow_invitations', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();
    const sharingSettingsRepo = {
      ensureDefaults: mock(() => {}),
      get: mock(() => ({ default_visibility: 'private', inline_mode_enabled: 0, allow_invitations: 1 })),
      update: mock(() => {}),
    };

    await handleSettingsCallback(
      ctx,
      makeUser() as never,
      'toggle_invitations',
      prefsService as never,
      undefined,
      sharingSettingsRepo as never,
    );

    expect(sharingSettingsRepo.update).toHaveBeenCalledWith(100, { allow_invitations: 0 });
  });

  test('stg:toggle_voice flips voice_response_enabled', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();
    const userRepo = {
      update: mock(() => {}),
      findByTelegramId: mock(() => ({ ...makeUser(), voice_response_enabled: 0 })),
    };

    await handleSettingsCallback(
      ctx,
      makeUser({ voice_response_enabled: 1 }) as never,
      'toggle_voice',
      prefsService as never,
      undefined,
      undefined,
      userRepo as never,
    );

    expect(userRepo.update).toHaveBeenCalledWith(100, { voice_response_enabled: 0 });
    const [text] = ctx.editText.mock.calls[0] as [string];
    expect(text).toContain('Голосовые ответы');
  });

  test('unknown subaction just answers', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefsService = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'unknown_action', prefsService as never);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).not.toHaveBeenCalled();
  });
});

describe('stg:general with buttons', () => {
  test('renders timezone, language, country without /timezone text', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefs = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'general', prefs as never);

    const [text] = ctx.editText.mock.calls[0] as [string, unknown];
    expect(text).not.toContain('/timezone');
    expect(text).toContain('Часовой пояс');
    expect(text).toContain('Язык');
    expect(text).toContain('Страна');
  });
});

describe('stg:set_lang', () => {
  test('updates language and re-renders general view', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefs = makePrefsService();
    const userRepo = {
      update: mock(() => ({ ...makeUser(), language: 'en' })),
      findByTelegramId: mock(() => makeUser()),
    };

    await handleSettingsCallback(
      ctx,
      makeUser() as never,
      'set_lang:en',
      prefs as never,
      undefined,
      undefined,
      userRepo as never,
    );

    expect(userRepo.update).toHaveBeenCalledWith(100, { language: 'en' });
    expect(ctx.editText).toHaveBeenCalled();
  });
});

describe('stg:set_country', () => {
  test('updates country_code and re-renders general view', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const ctx = makeCallbackCtx();
    const prefs = makePrefsService();
    const userRepo = {
      update: mock(() => ({ ...makeUser(), country_code: 'DE' })),
      findByTelegramId: mock(() => makeUser()),
    };

    await handleSettingsCallback(
      ctx,
      makeUser() as never,
      'set_country:DE',
      prefs as never,
      undefined,
      undefined,
      userRepo as never,
    );

    expect(userRepo.update).toHaveBeenCalledWith(100, { country_code: 'DE' });
    expect(ctx.editText).toHaveBeenCalled();
  });
});

describe('stg:close', () => {
  test('deletes the message', async () => {
    const { handleSettingsCallback } = await import('../../../src/bot/commands/settings.ts');
    const deleteFn = mock(() => Promise.resolve());
    const ctx = {
      ...makeCallbackCtx(),
      message: { delete: deleteFn },
    } as unknown as BotCallbackContext;
    const prefs = makePrefsService();

    await handleSettingsCallback(ctx, makeUser() as never, 'close', prefs as never);

    expect(deleteFn).toHaveBeenCalled();
  });
});
