// Characterization of the `stg:*` callback routing: duration, Telegram account and the
// ordering-sensitive side effects that happen before a sub-action is recognised.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { handleSettingsCallback, pendingDurationInput } from '../../../src/bot/commands/settings.ts';
import type { NotificationPreferencesRow, User } from '../../../src/database/types.ts';
import { stub } from '../partial-stub.ts';
import { makeUserRow, sentMessage } from '../telegram-fixtures.ts';

type TelegramDeps = NonNullable<Parameters<typeof handleSettingsCallback>[7]>;

function makeUser(overrides: Partial<User> = {}): User {
  return makeUserRow({ timezone: 'Europe/Moscow', country_code: 'RU', ...overrides });
}

// Negative case: a legacy row whose duration column is NULL, which the typed User model no longer admits.
// JSON.parse is typed `any`, the same way a stored value reaches the code at runtime, so this deliberately
// bypasses the type that would otherwise forbid the case under test.
const LEGACY_NULL_DURATION: number = JSON.parse('null');

function makeCtx() {
  return {
    answer: mock(() => Promise.resolve(true as const)),
    editText: mock(() => Promise.resolve(sentMessage())),
  };
}

// The row `ensureDefaults` creates for a new user (column defaults of notification_preferences).
const preferencesRow: NotificationPreferencesRow = {
  user_id: 100,
  morning_agenda_enabled: 1,
  morning_agenda_time: '08:00',
  morning_agenda_format: 'text',
  default_reminder_intervals: '[30, 0]',
  evening_review_enabled: 0,
  evening_review_time: '21:00',
  evening_review_format: 'text',
  quiet_hours_enabled: 0,
  quiet_hours_start: null,
  quiet_hours_end: null,
  updated_at: '2026-01-01 00:00:00',
};

const prefsService = {
  getOrCreate: mock(() => preferencesRow),
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
      stub(ctx),
      makeUser({ default_event_duration_minutes: 90 }),
      'edit_duration',
      stub(prefsService),
    );

    expect(pendingDurationInput.get(100)).toBeGreaterThanOrEqual(before);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(editedText(ctx)).toContain('Current: 90 min');
  });

  test('falls back to 60 minutes when the user has no default', async () => {
    const ctx = makeCtx();

    await handleSettingsCallback(
      stub(ctx),
      makeUser({ default_event_duration_minutes: LEGACY_NULL_DURATION }),
      'edit_duration',
      stub(prefsService),
    );

    expect(editedText(ctx)).toContain('Current: 1h');
  });
});

describe('stg:set_duration', () => {
  function makeUserRepo(updatedMinutes: number) {
    return {
      update: mock(() => null),
      findByTelegramId: mock(() => makeUser({ default_event_duration_minutes: updatedMinutes })),
    };
  }

  test('stores a valid duration, clears the pending input and shows the stored value', async () => {
    const ctx = makeCtx();
    const userRepo = makeUserRepo(45);
    pendingDurationInput.set(100, 1);

    await handleSettingsCallback(
      stub(ctx),
      makeUser(),
      'set_duration:45',
      stub(prefsService),
      undefined,
      undefined,
      stub(userRepo),
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
      stub(ctx),
      makeUser(),
      `set_duration:${value}`,
      stub(prefsService),
      undefined,
      undefined,
      stub(userRepo),
    );

    expect(userRepo.update).not.toHaveBeenCalled();
    expect(pendingDurationInput.get(100)).toBe(1);
    expect(ctx.editText).toHaveBeenCalledTimes(1);
  });

  test('accepts the 1440 upper bound', async () => {
    const ctx = makeCtx();
    const userRepo = makeUserRepo(1440);

    await handleSettingsCallback(
      stub(ctx),
      makeUser(),
      'set_duration:1440',
      stub(prefsService),
      undefined,
      undefined,
      stub(userRepo),
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
      stub(ctx),
      makeUser({ language: 'en' }),
      'set_duration:30',
      stub(prefsService),
      undefined,
      undefined,
      stub(userRepo),
    );

    expect(editedText(ctx)).toContain('Текущая: 30 мин');
  });

  test('without a user repository it only answers', async () => {
    const ctx = makeCtx();

    await handleSettingsCallback(stub(ctx), makeUser(), 'set_duration:45', stub(prefsService));

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).not.toHaveBeenCalled();
  });
});

describe('stg:set_lang / stg:set_country without a user repository', () => {
  test('re-renders the general view for the unchanged user', async () => {
    const ctx = makeCtx();

    await handleSettingsCallback(stub(ctx), makeUser({ language: 'en' }), 'set_lang:ru', stub(prefsService));

    expect(editedText(ctx)).toContain('General settings');
  });
});

describe('stg Telegram account', () => {
  function makeTelegramDeps(masterKey: Buffer | null = null) {
    const sessionRepo = {
      findByUserId: mock(() => null),
      getActive: mock(() => null),
      updateStatus: mock(() => {}),
    };
    const enterScene = mock(() => Promise.resolve());
    const deps: TelegramDeps = { sessionRepo: stub(sessionRepo), masterKey, enterScene };
    return { deps, sessionRepo, enterScene };
  }

  async function tap(subAction: string, telegramDeps?: TelegramDeps) {
    const ctx = makeCtx();
    await handleSettingsCallback(
      stub(ctx),
      makeUser(),
      subAction,
      stub(prefsService),
      undefined,
      undefined,
      undefined,
      telegramDeps,
    );
    return ctx;
  }

  test('stg:telegram shows the account view for the stored session', async () => {
    const telegram = makeTelegramDeps();
    const ctx = await tap('telegram', telegram.deps);

    expect(telegram.sessionRepo.findByUserId).toHaveBeenCalledWith(100);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(markupJson(ctx)).toContain('stg:tg_connect');
  });

  test('stg:tg_connect answers and enters the connect scene without editing', async () => {
    const telegram = makeTelegramDeps();
    const ctx = await tap('tg_connect', telegram.deps);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(telegram.enterScene).toHaveBeenCalledTimes(1);
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('stg:tg_disconnect_confirm without a master key revokes the session locally and offers reconnect', async () => {
    const telegram = makeTelegramDeps(null);
    const ctx = await tap('tg_disconnect_confirm', telegram.deps);

    expect(telegram.sessionRepo.getActive).toHaveBeenCalledWith(100);
    expect(telegram.sessionRepo.updateStatus).toHaveBeenCalledWith(100, 'revoked');
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
    const telegram = makeTelegramDeps();
    const ctx = await tap('nope', telegram.deps);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(telegram.enterScene).not.toHaveBeenCalled();
  });
});

describe('privacy defaults are ensured for every sub-action that reaches the privacy section', () => {
  function makeSharingRepo() {
    return {
      ensureDefaults: mock(() => {}),
      get: mock(() => null),
      update: mock(() => {}),
    };
  }

  test.each(['voice', 'unknown_action', 'edit_duration'])('stg:%s', async (subAction) => {
    const ctx = makeCtx();
    const sharing = makeSharingRepo();

    await handleSettingsCallback(stub(ctx), makeUser(), subAction, stub(prefsService), undefined, stub(sharing));

    expect(sharing.ensureDefaults).toHaveBeenCalledWith(100);
    expect(sharing.update).not.toHaveBeenCalled();
  });

  test('close and back return before the privacy section', async () => {
    const ctx = makeCtx();
    const sharing = makeSharingRepo();

    await handleSettingsCallback(stub(ctx), makeUser(), 'back', stub(prefsService), undefined, stub(sharing));

    expect(sharing.ensureDefaults).not.toHaveBeenCalled();
  });

  test('stg:privacy shows the privacy view with defaults when no row exists', async () => {
    const ctx = makeCtx();
    const sharing = makeSharingRepo();

    await handleSettingsCallback(stub(ctx), makeUser(), 'privacy', stub(prefsService), undefined, stub(sharing));

    expect(sharing.ensureDefaults).toHaveBeenCalledWith(100);
    expect(ctx.editText).toHaveBeenCalledTimes(1);
    expect(markupJson(ctx)).toContain('stg:cycle_visibility');
  });
});
