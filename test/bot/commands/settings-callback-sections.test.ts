// Characterization of the `stg:*` callback routing: duration, Telegram account and the
// ordering-sensitive side effects that happen before a sub-action is recognised.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { handleSettingsCallback, pendingDurationInput } from '../../../src/bot/commands/settings.ts';
import type { User } from '../../../src/database/types.ts';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    telegram_id: 100,
    username: null,
    first_name: null,
    language: 'en',
    timezone: 'Europe/Moscow',
    country_code: 'RU',
    google_refresh_token_enc: null,
    google_calendar_id: null,
    onboarding_completed: 1,
    timezone_updated_at: null,
    voice_response_enabled: null,
    default_event_duration_minutes: 60,
    city: null,
    connect_telegram_dismissed_at: null,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

function makeCtx() {
  return {
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
  };
}

const prefsService = {
  getOrCreate: mock(() => ({})),
  toggleMorningAgenda: mock(() => {}),
  toggleEveningReview: mock(() => {}),
  toggleQuietHours: mock(() => {}),
  updateDefaultIntervals: mock(() => {}),
};

function editedText(ctx: ReturnType<typeof makeCtx>): string {
  return String((ctx.editText.mock.calls[0] as unknown[])[0]);
}

function markupJson(ctx: ReturnType<typeof makeCtx>): string {
  return JSON.stringify((ctx.editText.mock.calls[0] as unknown[])[1]);
}

beforeEach(() => {
  pendingDurationInput.clear();
});

describe('stg:edit_duration', () => {
  test('remembers that a duration is awaited and shows the current duration', async () => {
    const ctx = makeCtx();
    const before = Date.now();

    await handleSettingsCallback(
      ctx as never,
      makeUser({ default_event_duration_minutes: 90 }),
      'edit_duration',
      prefsService as never,
    );

    expect(pendingDurationInput.get(100)).toBeGreaterThanOrEqual(before);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(editedText(ctx)).toContain('Current: 90 min');
  });

  test('falls back to 60 minutes when the user has no default', async () => {
    const ctx = makeCtx();

    await handleSettingsCallback(
      ctx as never,
      makeUser({ default_event_duration_minutes: null as never }),
      'edit_duration',
      prefsService as never,
    );

    expect(editedText(ctx)).toContain('Current: 1h');
  });
});

describe('stg:set_duration', () => {
  function makeUserRepo(updatedMinutes: number | null) {
    return {
      update: mock(() => null),
      findByTelegramId: mock(() => makeUser({ default_event_duration_minutes: updatedMinutes as never })),
    };
  }

  test('stores a valid duration, clears the pending input and shows the stored value', async () => {
    const ctx = makeCtx();
    const userRepo = makeUserRepo(45);
    pendingDurationInput.set(100, 1);

    await handleSettingsCallback(
      ctx as never,
      makeUser(),
      'set_duration:45',
      prefsService as never,
      undefined,
      undefined,
      userRepo as never,
    );

    expect(userRepo.update).toHaveBeenCalledWith(100, { default_event_duration_minutes: 45 });
    expect(pendingDurationInput.has(100)).toBe(false);
    expect(editedText(ctx)).toContain('Current: 45 min');
  });

  test.each(['0', '1441', '-5', 'abc'])('rejects %s without touching the user or the pending input', async (value) => {
    const ctx = makeCtx();
    const userRepo = makeUserRepo(60);
    pendingDurationInput.set(100, 1);

    await handleSettingsCallback(
      ctx as never,
      makeUser(),
      `set_duration:${value}`,
      prefsService as never,
      undefined,
      undefined,
      userRepo as never,
    );

    expect(userRepo.update).not.toHaveBeenCalled();
    expect(pendingDurationInput.get(100)).toBe(1);
    expect(ctx.editText).toHaveBeenCalledTimes(1);
  });

  test('accepts the 1440 upper bound', async () => {
    const ctx = makeCtx();
    const userRepo = makeUserRepo(1440);

    await handleSettingsCallback(
      ctx as never,
      makeUser(),
      'set_duration:1440',
      prefsService as never,
      undefined,
      undefined,
      userRepo as never,
    );

    expect(userRepo.update).toHaveBeenCalledWith(100, { default_event_duration_minutes: 1440 });
  });

  test('uses the language of the re-read user for the view', async () => {
    const ctx = makeCtx();
    const userRepo = {
      update: mock(() => null),
      findByTelegramId: mock(() => makeUser({ language: 'ru', default_event_duration_minutes: 30 })),
    };

    await handleSettingsCallback(
      ctx as never,
      makeUser({ language: 'en' }),
      'set_duration:30',
      prefsService as never,
      undefined,
      undefined,
      userRepo as never,
    );

    expect(editedText(ctx)).toContain('Текущая: 30 мин');
  });

  test('without a user repository it only answers', async () => {
    const ctx = makeCtx();

    await handleSettingsCallback(ctx as never, makeUser(), 'set_duration:45', prefsService as never);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).not.toHaveBeenCalled();
  });
});

describe('stg:set_lang / stg:set_country without a user repository', () => {
  test('re-renders the general view for the unchanged user', async () => {
    const ctx = makeCtx();

    await handleSettingsCallback(ctx as never, makeUser({ language: 'en' }), 'set_lang:ru', prefsService as never);

    expect(editedText(ctx)).toContain('General settings');
  });
});

describe('stg Telegram account', () => {
  function makeTelegramDeps(masterKey: Buffer | null = null) {
    return {
      sessionRepo: {
        findByUserId: mock(() => null),
        getActive: mock(() => null),
        updateStatus: mock(() => {}),
      },
      masterKey,
      enterScene: mock(() => Promise.resolve()),
    };
  }

  async function tap(subAction: string, telegramDeps?: ReturnType<typeof makeTelegramDeps>) {
    const ctx = makeCtx();
    await handleSettingsCallback(
      ctx as never,
      makeUser(),
      subAction,
      prefsService as never,
      undefined,
      undefined,
      undefined,
      telegramDeps as never,
    );
    return ctx;
  }

  test('stg:telegram shows the account view for the stored session', async () => {
    const deps = makeTelegramDeps();
    const ctx = await tap('telegram', deps);

    expect(deps.sessionRepo.findByUserId).toHaveBeenCalledWith(100);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(markupJson(ctx)).toContain('stg:tg_connect');
  });

  test('stg:tg_connect answers and enters the connect scene without editing', async () => {
    const deps = makeTelegramDeps();
    const ctx = await tap('tg_connect', deps);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(deps.enterScene).toHaveBeenCalledTimes(1);
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('stg:tg_disconnect_confirm without a master key revokes the session locally and offers reconnect', async () => {
    const deps = makeTelegramDeps(null);
    const ctx = await tap('tg_disconnect_confirm', deps);

    expect(deps.sessionRepo.getActive).toHaveBeenCalledWith(100);
    expect(deps.sessionRepo.updateStatus).toHaveBeenCalledWith(100, 'revoked');
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(markupJson(ctx)).toContain('stg:tg_connect');
    expect(markupJson(ctx)).toContain('stg:back');
  });

  test.each([
    'telegram',
    'tg_connect',
    'tg_disconnect_confirm',
  ])('stg:%s without Telegram support just answers', async (subAction) => {
    const ctx = await tap(subAction);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('an unknown stg sub-action with Telegram support just answers', async () => {
    const deps = makeTelegramDeps();
    const ctx = await tap('nope', deps);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(deps.enterScene).not.toHaveBeenCalled();
  });
});

describe('privacy defaults are ensured for every sub-action that reaches the privacy section', () => {
  function makeSharingRepo() {
    return {
      ensureDefaults: mock(() => {}),
      get: mock(() => undefined),
      update: mock(() => {}),
    };
  }

  test.each(['voice', 'unknown_action', 'edit_duration'])('stg:%s', async (subAction) => {
    const ctx = makeCtx();
    const sharing = makeSharingRepo();

    await handleSettingsCallback(
      ctx as never,
      makeUser(),
      subAction,
      prefsService as never,
      undefined,
      sharing as never,
    );

    expect(sharing.ensureDefaults).toHaveBeenCalledWith(100);
    expect(sharing.update).not.toHaveBeenCalled();
  });

  test('close and back return before the privacy section', async () => {
    const ctx = makeCtx();
    const sharing = makeSharingRepo();

    await handleSettingsCallback(ctx as never, makeUser(), 'back', prefsService as never, undefined, sharing as never);

    expect(sharing.ensureDefaults).not.toHaveBeenCalled();
  });

  test('stg:privacy shows the privacy view with defaults when no row exists', async () => {
    const ctx = makeCtx();
    const sharing = makeSharingRepo();

    await handleSettingsCallback(
      ctx as never,
      makeUser(),
      'privacy',
      prefsService as never,
      undefined,
      sharing as never,
    );

    expect(sharing.ensureDefaults).toHaveBeenCalledWith(100);
    expect(ctx.editText).toHaveBeenCalledTimes(1);
    expect(markupJson(ctx)).toContain('stg:cycle_visibility');
  });
});
