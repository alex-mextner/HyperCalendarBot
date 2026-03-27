import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock Anthropic SDK before importing scene — avoids real AI calls without replacing city-resolver module
const mockCreate = mock(async () => ({ content: [{ type: 'text', text: 'UNKNOWN' }] }));
mock.module('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

const { createOnboardingScene } = await import('../../../src/bot/scenes/onboarding.scene.ts');
const { CB } = await import('../../../src/config/constants.ts');
const { createUserResolverComposer } = await import('../../../src/bot/middleware/user-resolver.ts');

import type { DatabaseService } from '../../../src/database/index.ts';
import type { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import type { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';

// ---------------------------------------------------------------------------
// GramIO internal extraction helpers
// ---------------------------------------------------------------------------

type GramioFn = (ctx: MockCtx, next: () => Promise<void>) => Promise<void>;

function getStepFns(scene: ReturnType<typeof createOnboardingScene>): GramioFn[] {
  const inner = (scene as unknown as Record<string, unknown>)['~'] as Record<string, unknown>;
  const composer = inner.composer as Record<string, unknown>;
  const composerInner = composer['~'] as Record<string, unknown>;
  const middlewares = composerInner.middlewares as Array<Record<string, unknown>>;
  // slice(1) skips the user-resolver middleware injected by .extend(userComposer)
  return middlewares.slice(1).map((m) => m.fn as GramioFn);
}

function getEnterFn(scene: ReturnType<typeof createOnboardingScene>): GramioFn | undefined {
  const inner = (scene as unknown as Record<string, unknown>)['~'] as Record<string, unknown>;
  const enterFn = inner.enter;
  return typeof enterFn === 'function' ? (enterFn as GramioFn) : undefined;
}

// ---------------------------------------------------------------------------
// Mock context
// ---------------------------------------------------------------------------

type SendMock = ReturnType<typeof mock<() => Promise<{ id: number }>>>;
type UpdateMock = ReturnType<typeof mock<(patch: Record<string, unknown>, opts?: unknown) => Promise<void>>>;
type ExitMock = ReturnType<typeof mock<() => Promise<void>>>;
type AnswerMock = ReturnType<typeof mock<() => Promise<void>>>;
type EditTextMock = ReturnType<typeof mock<(text: string, opts?: unknown) => Promise<void>>>;

interface MockCtx {
  send: SendMock;
  answer: AnswerMock;
  editText: EditTextMock;
  text?: string;
  data?: string;
  eventLocation?: { latitude: number; longitude: number };
  scene: {
    state: Record<string, unknown>;
    step: { id: number; firstTime: boolean };
    update: UpdateMock;
    exit: ExitMock;
  };
  from: { id: number };
  is: (t: string | string[]) => boolean;
  _activeType: string;
}

function makeCtx(
  overrides: {
    activeType?: string;
    stepId?: number;
    firstTime?: boolean;
    text?: string;
    data?: string;
    state?: Record<string, unknown>;
    latitude?: number;
    longitude?: number;
  } = {},
): MockCtx {
  const state = overrides.state ?? {};
  const activeType = overrides.activeType ?? 'callback_query';
  const ctx: MockCtx = {
    _activeType: activeType,
    send: mock(() => Promise.resolve({ id: 99 })),
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    text: overrides.text,
    data: overrides.data,
    eventLocation:
      overrides.latitude !== undefined
        ? { latitude: overrides.latitude, longitude: overrides.longitude ?? 0 }
        : undefined,
    scene: {
      state,
      step: {
        id: overrides.stepId ?? 0,
        firstTime: overrides.firstTime ?? false,
      },
      update: mock((patch: Record<string, unknown>) => {
        Object.assign(state, patch);
        return Promise.resolve();
      }),
      exit: mock(() => Promise.resolve()),
    },
    from: { id: 1 },
    is: (t: string | string[]) => {
      if (Array.isArray(t)) return t.includes(activeType);
      return t === activeType;
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Service mocks
// ---------------------------------------------------------------------------

function makeDb(
  overrides: Partial<{
    findByTelegramId: unknown;
  }> = {},
): DatabaseService {
  return {
    users: {
      update: mock(() => null),
      findByTelegramId: mock(() => overrides.findByTelegramId ?? null),
      findOrCreate: mock(() => ({ language: 'en', timezone: 'UTC' })),
    },
    notificationPreferences: {
      update: mock(() => null),
    },
  } as unknown as DatabaseService;
}

const mockComposer = createUserResolverComposer(makeDb());

function makePrefsService(): NotificationPreferencesService {
  return {
    getOrCreate: mock(() => null),
    updateMorningTime: mock(() => null),
  } as unknown as NotificationPreferencesService;
}

function makeHolidayService(): HolidayService {
  return {
    subscribeUser: mock(() => null),
  } as unknown as HolidayService;
}

const NOOP_NEXT = () => Promise.resolve();

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

describe('createOnboardingScene', () => {
  test('creates scene with name "onboarding"', () => {
    const scene = createOnboardingScene(makeDb(), mockComposer);
    expect(scene.name).toBe('onboarding');
  });

  test('has 4 steps', () => {
    const scene = createOnboardingScene(makeDb(), mockComposer);
    expect(scene.stepsCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// onEnter — sends welcome with language keyboard
// ---------------------------------------------------------------------------

describe('onboarding onEnter', () => {
  test('sends welcome message', async () => {
    const scene = createOnboardingScene(makeDb(), mockComposer);
    const enterFn = getEnterFn(scene);
    if (!enterFn) return;
    const ctx = makeCtx();
    await enterFn(ctx, NOOP_NEXT);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [msg] = ctx.send.mock.calls[0] as unknown as [string];
    expect(msg).toMatch(/language|язык/i);
  });
});

// ---------------------------------------------------------------------------
// Step 0 — Language selection
// ---------------------------------------------------------------------------

describe('onboarding step 0: language selection', () => {
  let db: DatabaseService;
  let fns: GramioFn[];

  beforeEach(() => {
    db = makeDb();
    fns = getStepFns(createOnboardingScene(db, mockComposer));
  });

  test('unrelated callback data — does nothing', async () => {
    const ctx = makeCtx({ stepId: 0, data: 'something_else:en' });
    await fns[0]!(ctx, NOOP_NEXT);
    expect(db.users.update).not.toHaveBeenCalled();
  });

  test('no data — does nothing', async () => {
    const ctx = makeCtx({ stepId: 0 });
    await fns[0]!(ctx, NOOP_NEXT);
    expect(db.users.update).not.toHaveBeenCalled();
  });

  test('ONBOARD_LANG:en — saves language en and advances', async () => {
    const ctx = makeCtx({ stepId: 0, data: `${CB.ONBOARD_LANG}:en` });
    await fns[0]!(ctx, NOOP_NEXT);
    expect(db.users.update).toHaveBeenCalledWith(1, { language: 'en' });
    expect(ctx.editText).toHaveBeenCalledTimes(1);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    const [editMsg] = ctx.editText.mock.calls[0] as unknown as [string];
    expect(editMsg).toMatch(/english|EN/i);
    // state should have lang set
    expect(ctx.scene.state.lang).toBe('en');
  });

  test('ONBOARD_LANG:ru — saves language ru with Russian label', async () => {
    const ctx = makeCtx({ stepId: 0, data: `${CB.ONBOARD_LANG}:ru` });
    await fns[0]!(ctx, NOOP_NEXT);
    expect(db.users.update).toHaveBeenCalledWith(1, { language: 'ru' });
    const [editMsg] = ctx.editText.mock.calls[0] as unknown as [string];
    expect(editMsg).toMatch(/русский/i);
    expect(ctx.scene.state.lang).toBe('ru');
  });
});

// ---------------------------------------------------------------------------
// Step 1 — Timezone
// ---------------------------------------------------------------------------

describe('onboarding step 1: timezone', () => {
  let db: DatabaseService;
  let fns: GramioFn[];

  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'UNKNOWN' }] });
    db = makeDb();
    fns = getStepFns(createOnboardingScene(db, mockComposer));
  });

  test('firstTime — sends city prompt with keyboard', async () => {
    const ctx = makeCtx({ stepId: 1, firstTime: true, state: { lang: 'en' } });
    await fns[1]!(ctx, NOOP_NEXT);
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  // --- Message: city name ---

  describe('message: city name', () => {
    test('resolveCity returns timezone — sends confirm', async () => {
      // 'Berlin' resolves via city-timezones library without AI call
      const ctx = makeCtx({ activeType: 'message', stepId: 1, text: 'Berlin', state: { lang: 'en' } });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/✅/);
      expect(ctx.scene.update).toHaveBeenCalled();
    });

    test('resolveCity returns null — sends error with fallback hint', async () => {
      // 'xyzzy_no_such_city' — library misses, AI (mocked) returns UNKNOWN → null
      const ctx = makeCtx({
        activeType: 'message',
        stepId: 1,
        text: 'xyzzy_no_such_city',
        state: { lang: 'en' },
      });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/timezone|таймзону/i);
    });

    test('empty text — does nothing', async () => {
      const ctx = makeCtx({ activeType: 'message', stepId: 1, text: '', state: { lang: 'en' } });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.send).not.toHaveBeenCalled();
    });

    test('ru lang — error in Russian', async () => {
      // 'xyzzy' — library misses, AI (mocked) returns UNKNOWN → null
      const ctx = makeCtx({ activeType: 'message', stepId: 1, text: 'xyzzy', state: { lang: 'ru' } });
      await fns[1]!(ctx, NOOP_NEXT);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/таймзону/);
    });
  });

  // --- Location input ---

  describe('location input', () => {
    test('valid coordinates — resolves timezone, shows confirm', async () => {
      const ctx = makeCtx({
        activeType: 'location',
        stepId: 1,
        latitude: 51.5074, // London
        longitude: -0.1278,
        state: { lang: 'en' },
      });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/got it|ваш часовой/i);
      expect(ctx.scene.update).toHaveBeenCalled();
    });

    test('stores detectedTz in state', async () => {
      const ctx = makeCtx({
        activeType: 'location',
        stepId: 1,
        latitude: 51.5074,
        longitude: -0.1278,
        state: { lang: 'en' },
      });
      await fns[1]!(ctx, NOOP_NEXT);
      const allCalls = ctx.scene.update.mock.calls as [Record<string, unknown>, unknown][];
      const hasDetectedTz = allCalls.some(([patch]) => 'detectedTz' in patch);
      expect(hasDetectedTz).toBe(true);
    });
  });

  // --- ONBOARD_TZ:confirm callback ---

  describe('ONBOARD_TZ:confirm callback', () => {
    test('no detectedTz — does nothing', async () => {
      const ctx = makeCtx({
        stepId: 1,
        data: `${CB.ONBOARD_TZ}:confirm`,
        state: { lang: 'en' },
      });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(db.users.update).not.toHaveBeenCalled();
    });

    test('with detectedTz — saves to DB, advances', async () => {
      const state = { lang: 'en', detectedTz: 'Europe/Berlin' };
      const ctx = makeCtx({ stepId: 1, data: `${CB.ONBOARD_TZ}:confirm`, state });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(db.users.update).toHaveBeenCalledWith(1, expect.objectContaining({ timezone: 'Europe/Berlin' }));
      expect(ctx.send).toHaveBeenCalledTimes(1);
      expect(ctx.scene.update).toHaveBeenCalled();
      expect(ctx.answer).toHaveBeenCalledTimes(1);
    });
  });

  // --- ONBOARD_TZ_RETRY callback ---

  describe('ONBOARD_TZ_RETRY callback', () => {
    test('re-sends city prompt', async () => {
      const ctx = makeCtx({ stepId: 1, data: CB.ONBOARD_TZ_RETRY, state: { lang: 'en' } });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      expect(ctx.answer).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Step 2 — Country selection
// ---------------------------------------------------------------------------

describe('onboarding step 2: country selection', () => {
  let db: DatabaseService;
  let holidayService: HolidayService;
  let fns: GramioFn[];

  beforeEach(() => {
    db = makeDb();
    holidayService = makeHolidayService();
    fns = getStepFns(createOnboardingScene(db, mockComposer, false, undefined, holidayService));
  });

  test('firstTime — sends country prompt', async () => {
    const ctx = makeCtx({ activeType: 'callback_query', stepId: 2, firstTime: true, state: { lang: 'en' } });
    await fns[2]!(ctx, NOOP_NEXT);
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('unrelated callback data — does nothing', async () => {
    const ctx = makeCtx({ activeType: 'callback_query', stepId: 2, data: 'something:else' });
    await fns[2]!(ctx, NOOP_NEXT);
    expect(db.users.update).not.toHaveBeenCalled();
    expect(holidayService.subscribeUser).not.toHaveBeenCalled();
  });

  test('no data — does nothing', async () => {
    const ctx = makeCtx({ activeType: 'callback_query', stepId: 2 });
    await fns[2]!(ctx, NOOP_NEXT);
    expect(ctx.answer).not.toHaveBeenCalled();
  });

  test('ONBOARD_COUNTRY:RU — subscribes to RU holidays and advances', async () => {
    const ctx = makeCtx({
      activeType: 'callback_query',
      stepId: 2,
      data: `${CB.ONBOARD_COUNTRY}:RU`,
      state: { lang: 'en' },
    });
    await fns[2]!(ctx, NOOP_NEXT);
    expect(holidayService.subscribeUser).toHaveBeenCalledWith(1, 'RU', true);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.scene.state.country).toBe('RU');
  });

  test('ONBOARD_COUNTRY:skip — does not subscribe to holidays', async () => {
    const ctx = makeCtx({
      activeType: 'callback_query',
      stepId: 2,
      data: `${CB.ONBOARD_COUNTRY}:skip`,
      state: { lang: 'en' },
    });
    await fns[2]!(ctx, NOOP_NEXT);
    expect(holidayService.subscribeUser).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.scene.state.country).toBe('skip');
  });

  test('no holidayService — skip does not crash', async () => {
    const fnsNoHoliday = getStepFns(createOnboardingScene(db, mockComposer));
    const ctx = makeCtx({
      activeType: 'callback_query',
      stepId: 2,
      data: `${CB.ONBOARD_COUNTRY}:RU`,
      state: { lang: 'en' },
    });
    await fnsNoHoliday[2]!(ctx, NOOP_NEXT);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Step 3 — Morning agenda + complete onboarding
// ---------------------------------------------------------------------------

describe('onboarding step 3: morning agenda + completion', () => {
  let db: DatabaseService;
  let prefsService: NotificationPreferencesService;
  let fns: GramioFn[];

  beforeEach(() => {
    db = makeDb();
    prefsService = makePrefsService();
    fns = getStepFns(createOnboardingScene(db, mockComposer, false, prefsService));
  });

  test('firstTime — sends morning agenda prompt with time buttons', async () => {
    const ctx = makeCtx({ activeType: 'callback_query', stepId: 3, firstTime: true, state: { lang: 'en' } });
    await fns[3]!(ctx, NOOP_NEXT);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [msg] = ctx.send.mock.calls[0] as unknown as [string];
    expect(msg).toMatch(/morning|утро|summary/i);
  });

  test('unrelated callback data — does nothing', async () => {
    const ctx = makeCtx({ activeType: 'callback_query', stepId: 3, data: 'unrelated:data' });
    await fns[3]!(ctx, NOOP_NEXT);
    expect(db.users.update).not.toHaveBeenCalled();
  });

  test('no data — does nothing', async () => {
    const ctx = makeCtx({ activeType: 'callback_query', stepId: 3 });
    await fns[3]!(ctx, NOOP_NEXT);
    expect(db.users.update).not.toHaveBeenCalled();
  });

  test('ONBOARD_AGENDA:08:00 — saves morning time, marks onboarding complete', async () => {
    const state = { lang: 'en', timezone: 'Europe/Moscow' };
    const ctx = makeCtx({
      activeType: 'callback_query',
      stepId: 3,
      data: `${CB.ONBOARD_AGENDA}:08:00`,
      state,
    });
    await fns[3]!(ctx, NOOP_NEXT);
    expect(prefsService.getOrCreate).toHaveBeenCalledWith(1);
    expect(prefsService.updateMorningTime).toHaveBeenCalledWith(1, '08:00');
    expect(db.notificationPreferences.update).toHaveBeenCalledWith(1, { morning_agenda_enabled: 1 });
    expect(db.users.update).toHaveBeenCalledWith(1, { onboarding_completed: 1 });
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
  });

  test('ONBOARD_AGENDA:no — does not save morning time, still marks complete', async () => {
    const state = { lang: 'en', timezone: 'Europe/Moscow' };
    const ctx = makeCtx({
      activeType: 'callback_query',
      stepId: 3,
      data: `${CB.ONBOARD_AGENDA}:no`,
      state,
    });
    await fns[3]!(ctx, NOOP_NEXT);
    expect(prefsService.updateMorningTime).not.toHaveBeenCalled();
    expect(db.users.update).toHaveBeenCalledWith(1, { onboarding_completed: 1 });
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
  });

  test('completion — sends onboard_done message with feature tour button', async () => {
    const state = { lang: 'en', timezone: 'Europe/Moscow' };
    const ctx = makeCtx({
      activeType: 'callback_query',
      stepId: 3,
      data: `${CB.ONBOARD_AGENDA}:no`,
      state,
    });
    await fns[3]!(ctx, NOOP_NEXT);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [msg] = ctx.send.mock.calls[0] as unknown as [string];
    expect(msg).toMatch(/all set|готово/i);
  });

  test('gcalConfigured=true, user without Google token — sends gcal prompt', async () => {
    const localDb = makeDb({ findByTelegramId: { telegram_id: 1, google_refresh_token_enc: null } });
    const localFns = getStepFns(createOnboardingScene(localDb, mockComposer, true, prefsService));
    const state = { lang: 'en', timezone: 'Europe/Moscow' };
    const ctx = makeCtx({
      activeType: 'callback_query',
      stepId: 3,
      data: `${CB.ONBOARD_AGENDA}:no`,
      state,
    });
    await localFns[3]!(ctx, NOOP_NEXT);
    expect(ctx.send).toHaveBeenCalledTimes(2);
    const [, gcalMsg] = ctx.send.mock.calls as unknown as [string, string][];
    expect(gcalMsg![0]).toMatch(/google/i);
  });

  test('gcalConfigured=false — no gcal prompt', async () => {
    const state = { lang: 'en', timezone: 'Europe/Moscow' };
    const ctx = makeCtx({
      activeType: 'callback_query',
      stepId: 3,
      data: `${CB.ONBOARD_AGENDA}:no`,
      state,
    });
    await fns[3]!(ctx, NOOP_NEXT);
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('gcalConfigured=true, user already connected — no gcal prompt', async () => {
    const localDb = makeDb({ findByTelegramId: { telegram_id: 1, google_refresh_token_enc: 'token123' } });
    const localFns = getStepFns(createOnboardingScene(localDb, mockComposer, true, prefsService));
    const state = { lang: 'en', timezone: 'Europe/Moscow' };
    const ctx = makeCtx({
      activeType: 'callback_query',
      stepId: 3,
      data: `${CB.ONBOARD_AGENDA}:no`,
      state,
    });
    await localFns[3]!(ctx, NOOP_NEXT);
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('prefsService absent — morning time pick does not crash', async () => {
    const fnsNoPref = getStepFns(createOnboardingScene(db, mockComposer, false));
    const state = { lang: 'en', timezone: 'Europe/Moscow' };
    const ctx = makeCtx({
      activeType: 'callback_query',
      stepId: 3,
      data: `${CB.ONBOARD_AGENDA}:09:00`,
      state,
    });
    await fnsNoPref[3]!(ctx, NOOP_NEXT);
    expect(db.users.update).toHaveBeenCalledWith(1, { onboarding_completed: 1 });
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
  });
});

describe('onboarding CB constants', () => {
  test('ONBOARD_LANG is defined', () => {
    expect(CB.ONBOARD_LANG).toBeDefined();
    expect(typeof CB.ONBOARD_LANG).toBe('string');
  });

  test('ONBOARD_TZ is defined', () => {
    expect(CB.ONBOARD_TZ).toBeDefined();
    expect(typeof CB.ONBOARD_TZ).toBe('string');
  });

  test('ONBOARD_TZ_RETRY is defined', () => {
    expect(CB.ONBOARD_TZ_RETRY).toBeDefined();
    expect(typeof CB.ONBOARD_TZ_RETRY).toBe('string');
  });

  test('ONBOARD_COUNTRY is defined', () => {
    expect(CB.ONBOARD_COUNTRY).toBeDefined();
    expect(typeof CB.ONBOARD_COUNTRY).toBe('string');
  });

  test('ONBOARD_AGENDA is defined', () => {
    expect(CB.ONBOARD_AGENDA).toBeDefined();
    expect(typeof CB.ONBOARD_AGENDA).toBe('string');
  });

  test('all onboarding CB prefixes are distinct', () => {
    const prefixes = [CB.ONBOARD_LANG, CB.ONBOARD_TZ, CB.ONBOARD_TZ_RETRY, CB.ONBOARD_COUNTRY, CB.ONBOARD_AGENDA];
    const unique = new Set(prefixes);
    expect(unique.size).toBe(prefixes.length);
  });
});
