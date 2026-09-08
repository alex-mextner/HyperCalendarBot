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
  pendingForwardText?: string;
}

type SendMock = ReturnType<typeof mock<(text: string, opts?: unknown) => Promise<{ id: number }>>>;
type UpdateMock = ReturnType<typeof mock<(patch: Partial<SceneState>, opts?: unknown) => Promise<void>>>;

interface MockCtx {
  send: SendMock;
  answer: ReturnType<typeof mock<() => Promise<void>>>;
  lang: 'en' | 'ru';
  text?: string;
  data?: string;
  chatId?: number;
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
  chatId?: number;
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
    lang: overrides.lang ?? 'ru',
    text: overrides.text,
    data: overrides.data,
    chatId: overrides.chatId ?? 42,
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

function makeScene(deps?: Partial<ConnectTelegramDeps>) {
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
    ...deps,
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

  test('exits and forwards pending text to AI when non-OTP text was entered', async () => {
    const forwardToAi = mock(() => Promise.resolve());
    const scene = makeScene({ forwardToAi });
    const otpStep = getStepFns(scene)[2]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:cancel_auth',
      chatId: 555,
      userId: 123,
      state: {
        encryptedPhoneHex: 'abcd',
        sessionPath: '/tmp/fake.session',
        pendingForwardText: 'покажи мои события',
      },
    });

    await otpStep(ctx, NOOP_NEXT);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(123);
    expect(cleanupSpy).toHaveBeenCalledWith('/tmp/fake.session');
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    // send called once with the "Answering..." variant before exit
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const sendArgs = ctx.send.mock.calls[0] as unknown as [string, { reply_markup?: { remove_keyboard?: boolean } }?];
    expect(sendArgs[0]).toContain('Авторизация отменена');
    expect(sendArgs[0]).toContain('Отвечаю');
    expect(sendArgs[1]?.reply_markup).toEqual({ remove_keyboard: true });
    // AI handoff fires with original text
    // Wait a microtask so the fire-and-forget promise resolves
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(forwardToAi).toHaveBeenCalledTimes(1);
    const fwdArgs = forwardToAi.mock.calls[0] as unknown as [number, number, string];
    expect(fwdArgs[0]).toBe(123);
    expect(fwdArgs[1]).toBe(555);
    expect(fwdArgs[2]).toBe('покажи мои события');
  });

  test('exits with plain "cancelled" message when the user only typed digits', async () => {
    const forwardToAi = mock(() => Promise.resolve());
    const scene = makeScene({ forwardToAi });
    const otpStep = getStepFns(scene)[2]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:cancel_auth',
      state: {
        encryptedPhoneHex: 'abcd',
        sessionPath: '/tmp/fake.session',
        pendingForwardText: undefined,
      },
    });

    await otpStep(ctx, NOOP_NEXT);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.send.mock.calls[0] as unknown as [
      string,
      { reply_markup?: { remove_keyboard?: boolean } }?,
    ];
    expect(text).toBe('Авторизация отменена.');
    expect(opts?.reply_markup).toEqual({ remove_keyboard: true });
    expect(forwardToAi).not.toHaveBeenCalled();
  });

  test('does nothing for unknown callback_query data', async () => {
    const forwardToAi = mock(() => Promise.resolve());
    const scene = makeScene({ forwardToAi });
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
    expect(forwardToAi).not.toHaveBeenCalled();
  });

  test('invalidCode shown for non-OTP text stores pendingForwardText', async () => {
    const scene = makeScene();
    const otpStep = getStepFns(scene)[2]!;

    const ctx = makeCtx({
      activeType: 'message',
      text: 'what is on today?',
      state: {
        encryptedPhoneHex: 'abcd',
        sessionPath: '/tmp/fake.session',
      },
    });

    await otpStep(ctx, NOOP_NEXT);

    // State was updated with the pending forward text
    expect(ctx.scene.state.pendingForwardText).toBe('what is on today?');
    // invalidCode was sent with the cancel button keyboard
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.send.mock.calls[0] as unknown as [string, { reply_markup?: unknown }];
    expect(text).toBe('Неверный код. Введи 5 цифр через пробелы или дефисы (напр. 1 2 3 4 5 или 123-45).');
    expect(opts?.reply_markup).toBeDefined();
  });

  test('invalidCode shown for digits-only clears pendingForwardText', async () => {
    const scene = makeScene();
    const otpStep = getStepFns(scene)[2]!;

    const ctx = makeCtx({
      activeType: 'message',
      text: '1 2 3 4',
      state: {
        encryptedPhoneHex: 'abcd',
        sessionPath: '/tmp/fake.session',
        pendingForwardText: 'stale text',
      },
    });

    await otpStep(ctx, NOOP_NEXT);

    expect(ctx.scene.state.pendingForwardText).toBeUndefined();
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('invalidCode shown for text embedding a code-shaped digit run does not stash it for forwarding', async () => {
    // Regression test: "Code: 12345" is not pure-digit-shaped, but it embeds enough
    // digits to be (or contain) the real authentication code. Cancelling here must
    // never hand this text to the AI.
    const forwardToAi = mock(() => Promise.resolve());
    const scene = makeScene({ forwardToAi });
    const otpStep = getStepFns(scene)[2]!;

    const rejectCtx = makeCtx({
      activeType: 'message',
      text: 'Code: 12345',
      state: {
        encryptedPhoneHex: 'abcd',
        sessionPath: '/tmp/fake.session',
      },
    });

    await otpStep(rejectCtx, NOOP_NEXT);

    expect(rejectCtx.scene.state.pendingForwardText).toBeUndefined();

    // Cancelling right after must fall back to the plain message, never forwarding —
    // reuse the same (now-updated) scene state the reject step left behind.
    const cancelCtx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:cancel_auth',
      state: rejectCtx.scene.state,
    });

    await otpStep(cancelCtx, NOOP_NEXT);

    expect(forwardToAi).not.toHaveBeenCalled();
    expect(cancelCtx.send.mock.calls[0]![0]).toBe('Авторизация отменена.');
  });

  test('2FA step also handles Cancel authorization callback', async () => {
    const forwardToAi = mock(() => Promise.resolve());
    const scene = makeScene({ forwardToAi });
    const twoFaStep = getStepFns(scene)[3]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:cancel_auth',
      chatId: 777,
      userId: 321,
      stepId: 3,
      state: {
        encryptedPhoneHex: 'abcd',
        sessionPath: '/tmp/2fa.session',
        pendingForwardText: 'какая у меня встреча завтра',
      },
    });

    await twoFaStep(ctx, NOOP_NEXT);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith('/tmp/2fa.session');
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    const text = ctx.send.mock.calls[0]![0] as string;
    expect(text).toContain('Авторизация отменена');
    expect(text).toContain('Отвечаю');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(forwardToAi).toHaveBeenCalledTimes(1);
    const fwdArgs = forwardToAi.mock.calls[0] as unknown as [number, number, string];
    expect(fwdArgs[2]).toBe('какая у меня встреча завтра');
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
    const forwardToAi = mock(() => Promise.resolve());
    const scene = makeScene({ forwardToAi });
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
    expect(forwardToAi).not.toHaveBeenCalled();
  });

  test('cancel falls back to plain "cancelled" when forwardToAi dep is missing', async () => {
    // No forwardToAi dep provided — even with pending text, we can't forward.
    const scene = makeScene();
    const otpStep = getStepFns(scene)[2]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:cancel_auth',
      state: {
        encryptedPhoneHex: 'abcd',
        sessionPath: '/tmp/fake.session',
        pendingForwardText: 'кое-что для ИИ',
      },
    });

    await otpStep(ctx, NOOP_NEXT);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    // Plain variant, not "Отвечаю…"
    expect(ctx.send.mock.calls[0]![0]).toBe('Авторизация отменена.');
  });

  test('forwardToAi rejection is swallowed — user-facing flow still completes', async () => {
    const forwardToAi = mock(() => Promise.reject(new Error('AI pipeline broke')));
    const scene = makeScene({ forwardToAi });
    const otpStep = getStepFns(scene)[2]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:cancel_auth',
      state: {
        encryptedPhoneHex: 'abcd',
        sessionPath: '/tmp/fake.session',
        pendingForwardText: 'покажи события',
      },
    });

    // Handler awaits forwardToAi only inside its own .catch() — the handler itself
    // resolves cleanly regardless of AI-side failure.
    await otpStep(ctx, NOOP_NEXT);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.send.mock.calls[0]![0]).toContain('Авторизация отменена');
    expect(forwardToAi).toHaveBeenCalledTimes(1);
    // Give the fire-and-forget promise a tick to settle its rejection.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  });

  test('phone step also handles Cancel authorization callback', async () => {
    const forwardToAi = mock(() => Promise.resolve());
    const scene = makeScene({ forwardToAi });
    const phoneStep = getStepFns(scene)[1]!;

    const ctx = makeCtx({
      activeType: 'callback_query',
      data: 'ct:cancel_auth',
      chatId: 888,
      userId: 555,
      stepId: 1,
      state: { pendingForwardText: 'какой сегодня день' },
    });

    await phoneStep(ctx, NOOP_NEXT);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    const text = ctx.send.mock.calls[0]![0] as string;
    expect(text).toContain('Авторизация отменена');
    expect(text).toContain('Отвечаю');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(forwardToAi).toHaveBeenCalledTimes(1);
    const fwdArgs = forwardToAi.mock.calls[0] as unknown as [number, number, string];
    expect(fwdArgs[2]).toBe('какой сегодня день');
  });

  test('invalidPhone attaches cancel button and stashes non-phone text', async () => {
    const scene = makeScene();
    const phoneStep = getStepFns(scene)[1]!;

    const ctx = makeCtx({
      activeType: 'message',
      text: 'что у меня по работе',
      stepId: 1,
      state: {},
    });

    await phoneStep(ctx, NOOP_NEXT);

    expect(ctx.scene.state.pendingForwardText).toBe('что у меня по работе');
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx.send.mock.calls[0] as unknown as [string, { reply_markup?: unknown }];
    expect(text).toBe('Неверный формат. Используй международный формат: +79001234567');
    expect(opts?.reply_markup).toBeDefined();
  });

  test('invalidPhone does NOT stash digit-only input (phone-shaped, not natural language)', async () => {
    const scene = makeScene();
    const phoneStep = getStepFns(scene)[1]!;

    const ctx = makeCtx({
      activeType: 'message',
      // Phone-shaped but too short — rejected by PHONE_REGEX after normalization
      text: '12345',
      stepId: 1,
      state: { pendingForwardText: 'stale' },
    });

    await phoneStep(ctx, NOOP_NEXT);

    // Digit-only input is phone-shaped; nothing worth forwarding to AI.
    expect(ctx.scene.state.pendingForwardText).toBeUndefined();
  });

  test('valid phone acceptance clears stale pendingForwardText from an earlier invalid attempt', async () => {
    const originalReserve = SessionBridge.reserveEmptySessionPath;
    const originalSpawn = SessionBridge.spawnSendAndSign;
    SessionBridge.reserveEmptySessionPath = mock(
      () => '/tmp/new.session',
    ) as unknown as typeof SessionBridge.reserveEmptySessionPath;
    SessionBridge.spawnSendAndSign = mock(() =>
      Promise.resolve({ success: true, data: { phone_code_hash: 'hash123' } }),
    ) as unknown as typeof SessionBridge.spawnSendAndSign;

    try {
      const scene = makeScene();
      const phoneStep = getStepFns(scene)[1]!;

      const ctx = makeCtx({
        activeType: 'message',
        text: '+79001234567',
        stepId: 1,
        state: { pendingForwardText: 'stale text from an earlier invalid attempt' },
      });

      await phoneStep(ctx, NOOP_NEXT);

      // A phone number successfully accepted must not carry a stale conversational
      // message forward — otherwise a cancel click at the next (OTP) step would
      // forward it, even though the user has moved past that earlier attempt.
      expect(ctx.scene.state.pendingForwardText).toBeUndefined();
    } finally {
      SessionBridge.reserveEmptySessionPath = originalReserve;
      SessionBridge.spawnSendAndSign = originalSpawn;
    }
  });
});
