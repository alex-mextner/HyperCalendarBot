import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createUserResolverComposer } from '../../../src/bot/middleware/user-resolver.ts';
import {
  type ConnectTelegramDeps,
  createConnectTelegramScene,
} from '../../../src/bot/scenes/connect-telegram.scene.ts';
import type { DatabaseService } from '../../../src/database/index.ts';
import type { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import type { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import type { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import type { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import type { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';

const mockDb = { users: { findOrCreate: () => ({ language: 'ru', timezone: 'UTC' }) } } as unknown as DatabaseService;
const mockComposer = createUserResolverComposer(mockDb);

type GramioFn = (ctx: MockCtx, next: () => Promise<void>) => Promise<void>;

function getStepFns(scene: ReturnType<typeof createConnectTelegramScene>): GramioFn[] {
  type DynamicShape = { [key: string]: unknown };
  const inner = (scene as unknown as DynamicShape)['~'] as DynamicShape;
  const composer = inner.composer as DynamicShape;
  const composerInner = composer['~'] as DynamicShape;
  const middlewares = composerInner.middlewares as DynamicShape[];
  return middlewares.slice(1).map((m) => m.fn as GramioFn);
}

interface SceneState {
  encryptedPhoneHex?: string;
  sessionPath?: string;
  codeAttempts?: number;
  passwordAttempts?: number;
}

type SendMock = ReturnType<typeof mock<(text: string, opts?: unknown) => Promise<{ id: number }>>>;
type UpdateMock = ReturnType<typeof mock<(patch: Partial<SceneState>, opts?: unknown) => Promise<void>>>;

interface MockCtx {
  send: SendMock;
  answer: ReturnType<typeof mock<() => Promise<void>>>;
  delete: ReturnType<typeof mock<() => Promise<true>>>;
  lang: 'en' | 'ru';
  text?: string;
  data?: string;
  contact?: unknown;
  from: { id: number };
  scene: {
    state: SceneState;
    params: { pendingEventId?: number; pendingInviteeIds?: number[] };
    step: { id: number; firstTime: boolean; next: () => Promise<void>; go: (n: number) => Promise<void> };
    update: UpdateMock;
    exit: ReturnType<typeof mock<() => Promise<void>>>;
  };
  is: (t: string | string[]) => boolean;
  _activeType: string;
}

function makeCtx(overrides: {
  activeType?: string;
  data?: string;
  text?: string;
  state?: SceneState;
  userId?: number;
  lang?: 'en' | 'ru';
  stepId?: number;
}): MockCtx {
  const activeType = overrides.activeType ?? 'callback_query';
  const state: SceneState = overrides.state ?? {};
  return {
    _activeType: activeType,
    send: mock(() => Promise.resolve({ id: 1 })),
    answer: mock(() => Promise.resolve()),
    delete: mock(() => Promise.resolve(true as const)),
    lang: overrides.lang ?? 'ru',
    text: overrides.text,
    data: overrides.data,
    from: { id: overrides.userId ?? 100 },
    scene: {
      state,
      params: {},
      step: {
        id: overrides.stepId ?? 2,
        firstTime: false,
        next: mock(() => Promise.resolve()),
        go: mock(() => Promise.resolve()),
      },
      update: mock((patch: Partial<SceneState>) => {
        Object.assign(state, patch);
        return Promise.resolve();
      }),
      exit: mock(() => Promise.resolve()),
    },
    is: (t) => (Array.isArray(t) ? t.includes(activeType) : t === activeType),
  };
}

const NOOP_NEXT = () => Promise.resolve();

function makeScene() {
  const sessionRepo = {
    findByUserId: () => null,
    findByPhoneHash: () => null,
    upsert: () => undefined,
  } as unknown as TelegramSessionRepository;
  const baseDeps: ConnectTelegramDeps = {
    eventRepo: { findById: () => null } as unknown as EventRepository,
    userRepo: { findByTelegramId: () => null } as unknown as UserRepository,
    contactRepo: { findByTelegramId: () => null } as unknown as ContactRepository,
    invitationService: { sendInvitation: () => ({ success: true }) } as unknown as InvitationService,
  };
  return createConnectTelegramScene(
    sessionRepo,
    { TELEGRAM_SESSION_MASTER_KEY: '0'.repeat(64) },
    mockComposer,
    baseDeps,
  );
}

describe('connect-telegram: Cancel authorization button', () => {
  let cleanupSpy: ReturnType<typeof mock<(p: string) => Promise<void>>>;
  let originalCleanup: typeof SessionBridge.cleanupTempFile;
  let killSpy: ReturnType<typeof mock<(userId: number) => void>>;
  let originalKill: typeof SessionBridge.removeLiveAuthHandle;

  beforeEach(() => {
    cleanupSpy = mock(() => Promise.resolve());
    originalCleanup = SessionBridge.cleanupTempFile;
    SessionBridge.cleanupTempFile = cleanupSpy as unknown as typeof SessionBridge.cleanupTempFile;
    killSpy = mock(() => undefined);
    originalKill = SessionBridge.removeLiveAuthHandle;
    SessionBridge.removeLiveAuthHandle = killSpy as unknown as typeof SessionBridge.removeLiveAuthHandle;
  });

  afterEach(() => {
    SessionBridge.cleanupTempFile = originalCleanup;
    SessionBridge.removeLiveAuthHandle = originalKill;
  });

  test('cancel at the code step ends the wizard with the fixed message and cleans up', async () => {
    const scene = makeScene();
    const otpStep = getStepFns(scene)[2]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:cancel_auth',
      userId: 123,
      state: { encryptedPhoneHex: 'abcd', sessionPath: '/tmp/fake.session' },
    });

    await otpStep(ctx, NOOP_NEXT);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(123);
    expect(cleanupSpy).toHaveBeenCalledWith('/tmp/fake.session');
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.send.mock.calls[0] as unknown as [
      string,
      { reply_markup?: { remove_keyboard?: boolean } }?,
    ];
    expect(text).toBe('Авторизация отменена.');
    expect(opts?.reply_markup).toEqual({ remove_keyboard: true });
  });

  test('does nothing for unknown callback_query data', async () => {
    const scene = makeScene();
    const otpStep = getStepFns(scene)[2]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:something_else',
      state: { encryptedPhoneHex: 'abcd', sessionPath: '/tmp/x.session' },
    });

    await otpStep(ctx, NOOP_NEXT);

    expect(ctx.answer).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.scene.exit).not.toHaveBeenCalled();
  });

  test.each([
    'what is on today?',
    '1 2 3 4',
    'Code: 12345',
  ])('code step: %p is not a code — invalidCode with the cancel button, and the message leaves the chat', async (typed) => {
    const scene = makeScene();
    const otpStep = getStepFns(scene)[2]!;

    const ctx = makeCtx({
      activeType: 'message',
      text: typed,
      state: { encryptedPhoneHex: 'abcd', sessionPath: '/tmp/fake.session' },
    });

    await otpStep(ctx, NOOP_NEXT);

    // Anything typed at this prompt may be the login code or the 2FA password.
    expect(ctx.delete).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.send.mock.calls[0] as unknown as [string, { reply_markup?: unknown }];
    expect(text).toBe('Неверный код. Введи 5 цифр через пробелы или дефисы (напр. 1 2 3 4 5 или 123-45).');
    expect(opts?.reply_markup).toBeDefined();
    expect(ctx.scene.exit).not.toHaveBeenCalled();
  });

  test('2FA step also handles Cancel authorization callback', async () => {
    const scene = makeScene();
    const twoFaStep = getStepFns(scene)[3]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:cancel_auth',
      userId: 321,
      stepId: 3,
      state: { encryptedPhoneHex: 'abcd', sessionPath: '/tmp/2fa.session' },
    });

    await twoFaStep(ctx, NOOP_NEXT);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(321);
    expect(cleanupSpy).toHaveBeenCalledWith('/tmp/2fa.session');
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    expect(ctx.send.mock.calls.map((call) => call[0])).toEqual(['Авторизация отменена.']);
  });

  test('invalid2fa is shown with cancel button for empty password', async () => {
    const scene = makeScene();
    const twoFaStep = getStepFns(scene)[3]!;

    const ctx = makeCtx({
      activeType: 'message',
      text: '',
      stepId: 3,
      state: {
        encryptedPhoneHex: 'abcd',
        sessionPath: '/tmp/2fa.session',
      },
    });

    await twoFaStep(ctx, NOOP_NEXT);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.send.mock.calls[0] as unknown as [string, { reply_markup?: unknown }];
    expect(text).toBe('Неверный пароль. Попробуй ещё раз.');
    expect(opts?.reply_markup).toBeDefined();
  });

  test('2FA step ignores unknown callback_query data', async () => {
    const scene = makeScene();
    const twoFaStep = getStepFns(scene)[3]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:something_else',
      stepId: 3,
      state: { encryptedPhoneHex: 'abcd', sessionPath: '/tmp/2fa.session' },
    });

    await twoFaStep(ctx, NOOP_NEXT);

    expect(ctx.answer).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
    expect(ctx.scene.exit).not.toHaveBeenCalled();
  });

  test('phone step also handles Cancel authorization callback', async () => {
    const scene = makeScene();
    const phoneStep = getStepFns(scene)[1]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:cancel_auth',
      userId: 555,
      stepId: 1,
      state: {},
    });

    await phoneStep(ctx, NOOP_NEXT);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(555);
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    expect(ctx.send.mock.calls.map((call) => call[0])).toEqual(['Авторизация отменена.']);
  });

  test.each([
    'что у меня по работе',
    '12345',
  ])('phone step: %p is not a phone number — invalidPhone with the cancel button, and the message leaves the chat', async (typed) => {
    const scene = makeScene();
    const phoneStep = getStepFns(scene)[1]!;

    const ctx = makeCtx({ activeType: 'message', text: typed, stepId: 1, state: {} });

    await phoneStep(ctx, NOOP_NEXT);

    expect(ctx.delete).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.send.mock.calls[0] as unknown as [string, { reply_markup?: unknown }];
    expect(text).toBe('Неверный формат. Используй международный формат: +79001234567');
    expect(opts?.reply_markup).toBeDefined();
    expect(ctx.scene.exit).not.toHaveBeenCalled();
  });
});
