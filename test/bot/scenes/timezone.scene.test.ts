import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock Anthropic SDK before importing scene — avoids real AI calls without replacing city-resolver module
const mockCreate = mock(async () => ({ content: [{ type: 'text', text: 'UNKNOWN' }] }));
mock.module('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

const { createTimezoneScene } = await import('../../../src/bot/scenes/timezone.scene.ts');
const { CB } = await import('../../../src/config/constants.ts');
const { createUserResolverComposer } = await import('../../../src/bot/middleware/user-resolver.ts');

import type { DatabaseService } from '../../../src/database/index.ts';

// ---------------------------------------------------------------------------
// Helpers — GramIO internal extraction
// ---------------------------------------------------------------------------

type GramioFn = (ctx: MockCtx, next: () => Promise<void>) => Promise<void>;

function getStepFns(scene: ReturnType<typeof createTimezoneScene>): GramioFn[] {
  const inner = (scene as unknown as Record<string, unknown>)['~'] as Record<string, unknown>;
  const composer = inner.composer as Record<string, unknown>;
  const composerInner = composer['~'] as Record<string, unknown>;
  const middlewares = composerInner.middlewares as Array<Record<string, unknown>>;
  return middlewares.map((m) => m.fn as GramioFn);
}

function getEnterFn(scene: ReturnType<typeof createTimezoneScene>): GramioFn | undefined {
  const inner = (scene as unknown as Record<string, unknown>)['~'] as Record<string, unknown>;
  const enterFn = inner.enter;
  return typeof enterFn === 'function' ? (enterFn as GramioFn) : undefined;
}

type SendMock = ReturnType<typeof mock<() => Promise<{ id: number; delete?: () => Promise<void> }>>>;
type UpdateMock = ReturnType<typeof mock<(patch: Record<string, unknown>, opts?: unknown) => Promise<void>>>;
type ExitMock = ReturnType<typeof mock<() => Promise<void>>>;
type AnswerMock = ReturnType<typeof mock<() => Promise<void>>>;
type EditTextMock = ReturnType<typeof mock<(text: string, opts?: unknown) => Promise<void>>>;
type DeleteMessageMock = ReturnType<typeof mock<(p: { chat_id: number; message_id: number }) => Promise<void>>>;

interface MockCtx {
  send: SendMock;
  answer: AnswerMock;
  editText: EditTextMock;
  chatId: number;
  dbUser?: {
    telegram_id: number;
    language: 'en' | 'ru';
    timezone: string;
  };
  text?: string;
  data?: string;
  eventLocation?: { latitude: number; longitude: number };
  message?: { delete: ReturnType<typeof mock<() => Promise<void>>> };
  bot: {
    api: { deleteMessage: DeleteMessageMock; editMessageText: ReturnType<typeof mock> };
  };
  scene: {
    state: Record<string, unknown>;
    step: { id: number; firstTime: boolean };
    params: { settingsMsgId: number; settingsChatId: number };
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
    text?: string;
    data?: string;
    state?: Record<string, unknown>;
    lang?: 'en' | 'ru';
    timezone?: string;
    latitude?: number;
    longitude?: number;
    settingsMsgId?: number;
    settingsChatId?: number;
    chatId?: number;
  } = {},
): MockCtx {
  const state = overrides.state ?? {};
  const activeType = overrides.activeType ?? 'callback_query';
  // send returns an object with delete() so the "send then delete" pattern works
  const sendMock: SendMock = mock(() => Promise.resolve({ id: 99, delete: mock(() => Promise.resolve()) }));
  const ctx: MockCtx = {
    _activeType: activeType,
    send: sendMock,
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    chatId: overrides.chatId ?? 123,
    dbUser: {
      telegram_id: 1,
      language: overrides.lang ?? 'en',
      timezone: overrides.timezone ?? 'Europe/Moscow',
    },
    text: overrides.text,
    data: overrides.data,
    eventLocation:
      overrides.latitude !== undefined
        ? { latitude: overrides.latitude, longitude: overrides.longitude ?? 0 }
        : undefined,
    message: { delete: mock(() => Promise.resolve()) },
    bot: {
      api: {
        deleteMessage: mock(() => Promise.resolve()),
        editMessageText: mock(() => Promise.resolve()),
      },
    },
    scene: {
      state,
      step: { id: overrides.stepId ?? 0, firstTime: false },
      params: {
        settingsMsgId: overrides.settingsMsgId ?? 200,
        settingsChatId: overrides.settingsChatId ?? 123,
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

/** Minimal mock of DatabaseService with only the methods used by timezone scene + user resolver.
 *  DatabaseService has a private `db` field so structural mocking needs a boundary cast. */
function makeDb(updateResult?: unknown): DatabaseService {
  return {
    users: {
      update: mock(() => updateResult ?? { telegram_id: 1, language: 'en', timezone: 'Europe/London' }),
      findByTelegramId: mock(() => null),
      findOrCreate: () => ({ language: 'en', timezone: 'UTC' }),
    },
  } as unknown as DatabaseService;
}

const NOOP_NEXT = () => Promise.resolve();

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

describe('createTimezoneScene', () => {
  test('creates scene with name "timezone"', () => {
    const scene = createTimezoneScene(makeDb(), createUserResolverComposer(makeDb()));
    expect(scene.name).toBe('timezone');
  });

  test('has 1 step', () => {
    const scene = createTimezoneScene(makeDb(), createUserResolverComposer(makeDb()));
    expect(scene.stepsCount).toBe(1);
  });
});

describe('CB.TZ_ constants', () => {
  test('TZ_TYPE_CITY, TZ_GEO_PICK, TZ_CANCEL are all distinct', () => {
    const values = new Set([CB.TZ_TYPE_CITY, CB.TZ_GEO_PICK, CB.TZ_CANCEL]);
    expect(values.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// onEnter
// ---------------------------------------------------------------------------

describe('timezone scene onEnter', () => {
  test('calls editText with current timezone info', async () => {
    const scene = createTimezoneScene(makeDb(), createUserResolverComposer(makeDb()));
    const enterFn = getEnterFn(scene);
    if (!enterFn) return;
    const ctx = makeCtx({ timezone: 'Europe/London' });
    await enterFn(ctx, NOOP_NEXT);
    expect(ctx.editText).toHaveBeenCalledTimes(1);
    const [text] = ctx.editText.mock.calls[0] as unknown as [string];
    expect(text).toMatch(/current|текущий/i);
  });

  test('exits early if no user', async () => {
    const scene = createTimezoneScene(makeDb(), createUserResolverComposer(makeDb()));
    const enterFn = getEnterFn(scene);
    if (!enterFn) return;
    const ctx = makeCtx();
    ctx.dbUser = undefined;
    await enterFn(ctx, NOOP_NEXT);
    expect(ctx.editText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step handler
// ---------------------------------------------------------------------------

describe('timezone scene step handler', () => {
  let fns: GramioFn[];
  let db: DatabaseService;

  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'UNKNOWN' }] });
    db = makeDb();
    fns = getStepFns(createTimezoneScene(db, createUserResolverComposer(db)));
  });

  test('no user — exits scene immediately', async () => {
    const ctx = makeCtx({ activeType: 'callback_query', stepId: 0 });
    ctx.dbUser = undefined;
    await fns[0]!(ctx, NOOP_NEXT);
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
  });

  // --- TZ_TYPE_CITY ---

  describe('TZ_TYPE_CITY callback', () => {
    test('sets cityInputMode=true and edits settings message', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 0, data: CB.TZ_TYPE_CITY });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalled();
      const lastUpdateCall = ctx.scene.update.mock.calls.at(-1) as [Record<string, unknown>, unknown];
      expect(lastUpdateCall[0]).toMatchObject({ cityInputMode: true });
      expect(ctx.editText).toHaveBeenCalledTimes(1);
      expect(ctx.send).toHaveBeenCalledTimes(1);
    });

    test('calls answer()', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 0, data: CB.TZ_TYPE_CITY });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.answer).toHaveBeenCalledTimes(1);
    });
  });

  // --- TZ_GEO_PICK ---

  describe('TZ_GEO_PICK callback', () => {
    test('edits settings message and sends geo request prompt', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 0, data: CB.TZ_GEO_PICK });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.editText).toHaveBeenCalledTimes(1);
      expect(ctx.send).toHaveBeenCalledTimes(1);
    });

    test('stores geoMsgId in scene state', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 0, data: CB.TZ_GEO_PICK });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalled();
      const allCalls = ctx.scene.update.mock.calls as [Record<string, unknown>, unknown][];
      const hasGeoMsgId = allCalls.some(([patch]) => 'geoMsgId' in patch);
      expect(hasGeoMsgId).toBe(true);
    });

    test('calls answer()', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 0, data: CB.TZ_GEO_PICK });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.answer).toHaveBeenCalledTimes(1);
    });
  });

  // --- TZ_CANCEL ---

  describe('TZ_CANCEL callback', () => {
    test('exits scene', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 0, data: CB.TZ_CANCEL });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    });

    test('restores settings message via editText', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 0, data: CB.TZ_CANCEL });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.editText).toHaveBeenCalledTimes(1);
    });

    test('calls answer()', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 0, data: CB.TZ_CANCEL });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.answer).toHaveBeenCalledTimes(1);
    });

    test('with active geoMsgId — deletes geo request message', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 0,
        data: CB.TZ_CANCEL,
        state: { geoMsgId: 77 },
      });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.bot.api.deleteMessage).toHaveBeenCalledWith({ chat_id: 123, message_id: 77 });
    });
  });

  // --- ONBOARD_TZ confirm ---

  describe('ONBOARD_TZ:confirm callback', () => {
    test('no detectedTz — skips update, calls answer()', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 0, data: `${CB.ONBOARD_TZ}:confirm` });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(db.users.update).not.toHaveBeenCalled();
      expect(ctx.answer).toHaveBeenCalledTimes(1);
    });

    test('with detectedTz — saves timezone, exits, edits confirm message', async () => {
      const state = { detectedTz: 'Europe/Paris' };
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 0,
        data: `${CB.ONBOARD_TZ}:confirm`,
        state,
      });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(db.users.update).toHaveBeenCalledWith(1, { timezone: 'Europe/Paris' });
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(ctx.editText).toHaveBeenCalledTimes(1);
      const [confirmMsg] = ctx.editText.mock.calls[0] as unknown as [string];
      expect(confirmMsg).toMatch(/✅/);
    });

    test('with valid updatedUser + settingsMsgId — restores settings message', async () => {
      const updatedUser = { telegram_id: 1, language: 'en', timezone: 'Europe/Paris' };
      const localDb = { users: { update: mock(() => updatedUser) } } as unknown as DatabaseService;
      const localFns = getStepFns(createTimezoneScene(localDb, createUserResolverComposer(localDb)));
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 0,
        data: `${CB.ONBOARD_TZ}:confirm`,
        state: { detectedTz: 'Europe/Paris' },
        settingsMsgId: 555,
        settingsChatId: 999,
      });
      await localFns[0]!(ctx, NOOP_NEXT);
      expect(ctx.bot.api.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({ chat_id: 999, message_id: 555 }),
      );
    });
  });

  // --- ONBOARD_TZ_RETRY ---

  describe('ONBOARD_TZ_RETRY callback', () => {
    test('deletes confirm message and calls answer()', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 0, data: CB.ONBOARD_TZ_RETRY });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.message?.delete).toHaveBeenCalledTimes(1);
      expect(ctx.answer).toHaveBeenCalledTimes(1);
    });
  });

  // --- Location input ---

  describe('location input', () => {
    test('valid geo coordinates — resolves timezone and shows confirm', async () => {
      const ctx = makeCtx({
        activeType: 'location',
        stepId: 0,
        latitude: 51.5074, // London
        longitude: -0.1278,
        state: {},
      });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/✅/);
      expect(ctx.scene.update).toHaveBeenCalled();
    });

    test('with active geoMsgId — deletes geo request message', async () => {
      const ctx = makeCtx({
        activeType: 'location',
        stepId: 0,
        latitude: 51.5074,
        longitude: -0.1278,
        state: { geoMsgId: 88 },
      });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.bot.api.deleteMessage).toHaveBeenCalledWith({ chat_id: 123, message_id: 88 });
    });

    test('detectedTz stored in state after location', async () => {
      const ctx = makeCtx({
        activeType: 'location',
        stepId: 0,
        latitude: 51.5074,
        longitude: -0.1278,
        state: {},
      });
      await fns[0]!(ctx, NOOP_NEXT);
      const allCalls = ctx.scene.update.mock.calls as [Record<string, unknown>, unknown][];
      const hasDetectedTz = allCalls.some(([patch]) => 'detectedTz' in patch);
      expect(hasDetectedTz).toBe(true);
    });
  });

  // --- Message: city name input ---

  describe('message: city name input', () => {
    test('cityInputMode=false — ignores message silently', async () => {
      const ctx = makeCtx({ activeType: 'message', stepId: 0, text: 'London', state: { cityInputMode: false } });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.send).not.toHaveBeenCalled();
    });

    test('cityInputMode=true, no text — does nothing', async () => {
      const ctx = makeCtx({ activeType: 'message', stepId: 0, text: '', state: { cityInputMode: true } });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.send).not.toHaveBeenCalled();
    });

    test('cityInputMode=true, resolveCity returns timezone — shows confirm', async () => {
      // 'London' resolves via city-timezones library without AI call
      const ctx = makeCtx({ activeType: 'message', stepId: 0, text: 'London', state: { cityInputMode: true } });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/✅/);
      expect(ctx.scene.update).toHaveBeenCalled();
    });

    test('cityInputMode=true, resolveCity returns null — sends error with fallback hint', async () => {
      // 'xyzzy_not_a_city' — library misses, AI (mocked) returns UNKNOWN → null
      const ctx = makeCtx({
        activeType: 'message',
        stepId: 0,
        text: 'xyzzy_not_a_city',
        state: { cityInputMode: true },
      });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/timezone|таймзону/i);
      expect(ctx.scene.update).not.toHaveBeenCalled();
    });

    test('cityInputMode=true, ru lang — error message in Russian', async () => {
      // 'xyzzy' — library misses, AI (mocked) returns UNKNOWN → null
      const ctx = makeCtx({
        activeType: 'message',
        stepId: 0,
        text: 'xyzzy',
        state: { cityInputMode: true },
        lang: 'ru',
      });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/таймзону/);
    });
  });
});
