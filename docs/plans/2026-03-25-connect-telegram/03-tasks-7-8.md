> Part 3 of 5 of [Connect Telegram Account — Implementation Plan](../2026-03-25-connect-telegram.md) — previous: [02-tasks-4-6.md](02-tasks-4-6.md) · next: [04-tasks-9-11.md](04-tasks-9-11.md)

## Task 7: First-Person Invitation Text (spec §11)

**Files:**
- Create: `src/services/telegram-session/invitation-text.ts`
- Create: `test/services/telegram-session/invitation-text.test.ts`

Per spec §11, messages sent from the user's Telegram account must feel personal:
- First person ("Приглашаю тебя на …" / "Inviting you to …")
- No greeting ("Привет!"), no bot signature
- Date line, optional location line, optional truncated description line
- Deep-link to accept / decline via the bot

- [ ] **Step 1: Write test**

```ts
// test/services/telegram-session/invitation-text.test.ts
import { describe, test, expect } from 'bun:test';
import { buildUserSessionInvitationText } from '../../../src/services/telegram-session/invitation-text.ts';
import type { Event } from '../../../src/database/types.ts';

const baseEvent: Pick<Event, 'title' | 'start_utc' | 'location' | 'description'> = {
  title: 'Обед с Леной',
  start_utc: '2026-04-20T10:00:00Z',
  location: 'Кофемания',
  description: 'Обсудим новый проект',
};

describe('buildUserSessionInvitationText', () => {
  test('RU format: first person, date, location, description, deep link', () => {
    const text = buildUserSessionInvitationText({
      event: baseEvent,
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    expect(text).toContain('Приглашаю тебя на «Обед с Леной»');
    expect(text).toContain('📅');
    expect(text).toContain('📍 Кофемания');
    expect(text).toContain('Обсудим новый проект');
    expect(text).toContain('https://t.me/hypercal_bot?start=invite_123');
    expect(text).not.toMatch(/^Привет/i);
  });

  test('EN format', () => {
    const text = buildUserSessionInvitationText({
      event: baseEvent,
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'en',
    });
    expect(text).toContain('Inviting you to "Обед с Леной"');
  });

  test('omits location line when location is empty', () => {
    const text = buildUserSessionInvitationText({
      event: { ...baseEvent, location: null },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    expect(text).not.toContain('📍');
  });

  test('truncates description to 100 chars', () => {
    const longDesc = 'x'.repeat(200);
    const text = buildUserSessionInvitationText({
      event: { ...baseEvent, description: longDesc },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    // Description line should cap at ~100 chars (plus ellipsis)
    const descMatch = text.match(/x+…?/);
    expect(descMatch).not.toBeNull();
    expect(descMatch![0].length).toBeLessThanOrEqual(101);
  });

  test('omits description line when empty', () => {
    const text = buildUserSessionInvitationText({
      event: { ...baseEvent, description: null },
      inviterTimezone: 'Europe/Moscow',
      deepLink: 'https://t.me/hypercal_bot?start=invite_123',
      lang: 'ru',
    });
    // After date line and before deep link — no stray newlines
    expect(text).toMatch(/📅[^\n]+\n\nПодробнее/);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/services/telegram-session/invitation-text.ts
import type { Event } from '../../database/types.ts';
import { t } from '../../config/constants.ts';
import { formatDateShort, formatTime } from '../../utils/date.ts';

const DESC_MAX = 100;

interface Input {
  event: Pick<Event, 'title' | 'start_utc' | 'location' | 'description'>;
  inviterTimezone: string;
  deepLink: string;
  lang: 'en' | 'ru';
}

export function buildUserSessionInvitationText(input: Input): string {
  const { event, inviterTimezone, deepLink, lang } = input;
  const dateLine = `${formatDateShort(event.start_utc, inviterTimezone, lang)}, ${formatTime(event.start_utc, inviterTimezone)}`;
  const locationLine = event.location ? `\n📍 ${event.location}` : '';
  const descriptionLine = event.description
    ? `\n${truncate(event.description, DESC_MAX)}`
    : '';

  return t(lang).aiTools.sharing.userSessionInvitation({
    title: event.title,
    dateLine,
    locationLine,
    descriptionLine,
    deepLink,
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
```

Uses `formatDateShort` (e.g. "пн 20") + `formatTime` (e.g. "13:00") from `src/utils/date.ts`.

- [ ] **Step 3: Run test, commit**

```bash
bun test test/services/telegram-session/invitation-text.test.ts
git add src/services/telegram-session/invitation-text.ts \
  test/services/telegram-session/invitation-text.test.ts
git commit -m "feat(connect-telegram): first-person invitation text formatter (spec §11)"
```

---

## Task 8: GramIO Scene

**Files:**
- Create: `src/bot/scenes/connect-telegram.scene.ts`
- Modify: `src/bot/scenes/index.ts`
- Create: `test/bot/scenes/connect-telegram.scene.test.ts`

**Scene API reference (verified against `@gramio/scenes` ^0.5.1):**
- `new Scene(name).state<State>().extend(userComposer).onEnter(handler).step(filters, handler)` — matches `timezone.scene.ts` / `onboarding.scene.ts`
- `context.scene.step.firstTime` — boolean, true on first hit of a step
- `context.scene.step.next()` — advance to next step
- `context.scene.update(state, { step })` — update state, optionally change current step
- `context.scene.exit()` — leave scene
- `context.data` — callback_query data (typed when `context.is('callback_query')`)
- `.extend(userComposer)` propagates `dbUser`, `lang`, `userTimezone` into `context` without casts

- [ ] **Step 1: Write scene helper test**

```ts
// test/bot/scenes/connect-telegram.scene.test.ts
import { describe, test, expect } from 'bun:test';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';
import { PHONE_REGEX, CODE_REGEX, isConnectCooldownActive, registerConnectAttempt } from '../../../src/bot/scenes/connect-telegram.scene.ts';

describe('connect-telegram scene helpers', () => {
  test('PHONE_REGEX accepts valid international numbers', () => {
    expect(PHONE_REGEX.test('+79001234567')).toBe(true);
    expect(PHONE_REGEX.test('+1234567890')).toBe(true);
    expect(PHONE_REGEX.test('+380501234567')).toBe(true);
  });

  test('PHONE_REGEX rejects invalid formats', () => {
    expect(PHONE_REGEX.test('79001234567')).toBe(false);
    expect(PHONE_REGEX.test('+123')).toBe(false);
    expect(PHONE_REGEX.test('+1234567890123456')).toBe(false);
    expect(PHONE_REGEX.test('+7900abc1234')).toBe(false);
    expect(PHONE_REGEX.test('')).toBe(false);
  });

  test('CODE_REGEX accepts 5-digit codes only', () => {
    expect(CODE_REGEX.test('12345')).toBe(true);
    expect(CODE_REGEX.test('00000')).toBe(true);
    expect(CODE_REGEX.test('1234')).toBe(false);
    expect(CODE_REGEX.test('123456')).toBe(false);
    expect(CODE_REGEX.test('abcde')).toBe(false);
  });

  test('phoneHash is deterministic', () => {
    const phone = '+79001234567';
    expect(SessionBridge.phoneHash(phone)).toBe(SessionBridge.phoneHash(phone));
  });

  test('cooldown: second entry within window returns true', () => {
    const userId = 999001;
    registerConnectAttempt(userId);
    expect(isConnectCooldownActive(userId)).toBe(true);
  });

  test('cooldown: unknown user returns false', () => {
    expect(isConnectCooldownActive(999002)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement scene**

```ts
// src/bot/scenes/connect-telegram.scene.ts
import { Scene } from '@gramio/scenes';
import { InlineKeyboard } from 'gramio';
import { t, maskPhone } from '../../config/constants.ts';
import type { EnvConfig } from '../../config/env.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import { encryptBlob, encryptString, decryptString } from '../../services/crypto/session-crypto.ts';
import { SessionBridge } from '../../services/telegram-session/session-bridge.ts';
import { logger } from '../../utils/logger.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';

export const PHONE_REGEX = /^\+\d{7,15}$/;
export const CODE_REGEX = /^\d{5}$/;
const MAX_ATTEMPTS = 3;
const CONNECT_COOLDOWN_MS = 60_000;
const connectAttempts = new Map<number, number>();

export function registerConnectAttempt(userId: number): void {
  connectAttempts.set(userId, Date.now());
}

export function isConnectCooldownActive(userId: number): boolean {
  const last = connectAttempts.get(userId);
  if (last === undefined) return false;
  return Date.now() - last < CONNECT_COOLDOWN_MS;
}

export interface ConnectTelegramState {
  phone?: string;
  phoneCodeHash?: string;
  sessionPath?: string;
  codeAttempts?: number;
  passwordAttempts?: number;
}

const sceneLogger = logger.child({ module: 'connect-telegram-scene' });

export function createConnectTelegramScene(
  sessionRepo: TelegramSessionRepository,
  config: EnvConfig,
  userComposer: UserResolverComposer,
) {
  return new Scene('connect-telegram')
    .state<ConnectTelegramState>()
    // extend() AFTER state() so dbUser / lang / userTimezone flow into all step handlers
    .extend(userComposer)

    // Step 0: Consent — accepts message (command entry) and callback_query (button click)
    .step(['message', 'callback_query'], async (context) => {
      const lang = context.lang ?? 'en';
      const s = t(lang).connectTelegram;

      if (context.scene.step.firstTime) {
        if (!config.TELEGRAM_SESSION_MASTER_KEY) {
          await context.send(s.featureUnavailable);
          return context.scene.exit();
        }
        if (isConnectCooldownActive(context.from.id)) {
          await context.send(s.cooldown(Math.ceil(CONNECT_COOLDOWN_MS / 1000)));
          return context.scene.exit();
        }

        const existing = sessionRepo.getActive(context.from.id);
        if (existing) {
          // Already connected — decrypt phone for display
          const masterKey = Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY, 'hex');
          let masked = '+••• ••••';
          try {
            masked = maskPhone(decryptString(Buffer.from(existing.encrypted_phone), masterKey));
          } catch (err) {
            sceneLogger.warn({ err, userId: context.from.id }, 'Failed to decrypt phone for display');
          }
          const kb = new InlineKeyboard()
            .text(s.btnReconnect, 'ct:reconnect')
            .text(s.btnCancel, 'ct:cancel');
          await context.send(s.alreadyConnected(masked), { reply_markup: kb });
          return;
        }

        const kb = new InlineKeyboard()
          .text(s.btnConnect, 'ct:connect')
          .text(s.btnCancel, 'ct:cancel');
        await context.send(s.consent, { reply_markup: kb });
        return;
      }

      if (!context.is('callback_query')) return;
      const data = context.data;
      if (data === 'ct:cancel') {
        await context.answer();
        await context.send(s.cancelled);
        return context.scene.exit();
      }
      if (data === 'ct:connect' || data === 'ct:reconnect') {
        await context.answer();
        registerConnectAttempt(context.from.id);
        await context.send(s.enterPhone);
        return context.scene.step.next();
      }
    })

    // Step 1: Phone
    .step('message', async (context) => {
      const lang = context.lang ?? 'en';
      const s = t(lang).connectTelegram;
      const text = context.text?.trim();

      if (!text || !PHONE_REGEX.test(text)) {
        await context.send(s.invalidPhone);
        return;
      }
      const phone = text;
      const phoneHash = SessionBridge.phoneHash(phone);
      const existing = sessionRepo.findByPhoneHash(phoneHash);
      if (existing && existing.user_id !== context.from.id) {
        await context.send(s.phoneAlreadyUsed);
        return context.scene.exit();
      }

      const sessionPath = await SessionBridge.reserveEmptySessionPath(context.from.id);
      const result = await SessionBridge.sendCode(phone, sessionPath);
      if (!result.success) {
        await SessionBridge.cleanupTempFile(sessionPath);
        if (result.error === 'PHONE_INVALID') {
          await context.send(s.invalidPhone);
          return;
        }
        if (result.error === 'FLOOD_WAIT' && result.retryAfter) {
          await context.send(s.floodWait(Math.ceil(result.retryAfter / 60)));
          return context.scene.exit();
        }
        sceneLogger.error({ err: new Error(result.message) }, 'sendCode failed');
        await context.send(s.featureUnavailable);
        return context.scene.exit();
      }

      const phoneCodeHash = 'phone_code_hash' in result.data ? result.data.phone_code_hash : '';
      await context.scene.update({
        phone,
        phoneCodeHash,
        sessionPath,
        codeAttempts: 0,
      });
      await context.send(s.codeSent);
      return context.scene.step.next();
    })

    // Step 2: OTP
    .step('message', async (context) => {
      const lang = context.lang ?? 'en';
      const s = t(lang).connectTelegram;
      const state = context.scene.state;
      const text = context.text?.trim();

      if (!text || !CODE_REGEX.test(text)) {
        await context.send(s.invalidCode);
        return;
      }

      const result = await SessionBridge.signIn(
        state.phone!,
        text,
        state.phoneCodeHash!,
        state.sessionPath!,
      );

      if (!result.success) {
        const attempts = (state.codeAttempts ?? 0) + 1;
        await context.scene.update({ codeAttempts: attempts });
        if (result.error === 'CODE_EXPIRED') {
          await SessionBridge.cleanupTempFile(state.sessionPath!);
          await context.send(s.codeExpired);
          return context.scene.exit();
        }
        if (attempts >= MAX_ATTEMPTS) {
          await SessionBridge.cleanupTempFile(state.sessionPath!);
          await context.send(s.tooManyAttempts);
          return context.scene.exit();
        }
        await context.send(s.invalidCode);
        return;
      }

      if ('status' in result.data && result.data.status === '2fa_required') {
        await context.scene.update({ passwordAttempts: 0 });
        await context.send(s.enter2fa);
        return context.scene.step.next();
      }

      await finalizeSession(context, state, sessionRepo, config);
    })

    // Step 3: 2FA
    .step('message', async (context) => {
      const lang = context.lang ?? 'en';
      const s = t(lang).connectTelegram;
      const state = context.scene.state;
      const password = context.text;
      if (!password) {
        await context.send(s.invalid2fa);
        return;
      }

      const result = await SessionBridge.checkPassword(password, state.sessionPath!);

      if (!result.success) {
        const attempts = (state.passwordAttempts ?? 0) + 1;
        await context.scene.update({ passwordAttempts: attempts });
        if (attempts >= MAX_ATTEMPTS) {
          await SessionBridge.cleanupTempFile(state.sessionPath!);
          await context.send(s.tooManyAttempts);
          return context.scene.exit();
        }
        await context.send(s.invalid2fa);
        return;
      }
      await finalizeSession(context, state, sessionRepo, config);
    });
}

// Shape captured from the scene step handler signature — avoids inline object types.
type SceneStepContext = Parameters<
  Parameters<ReturnType<typeof createConnectTelegramScene>['step']>[1]
>[0];

async function finalizeSession(
  context: SceneStepContext,
  state: ConnectTelegramState,
  sessionRepo: TelegramSessionRepository,
  config: EnvConfig,
): Promise<void> {
  const lang = context.lang ?? 'en';
  const s = t(lang).connectTelegram;
  const userId = context.from.id;

  try {
    const sessionFile = Bun.file(state.sessionPath!);
    const sessionData = Buffer.from(await sessionFile.arrayBuffer());
    const masterKey = Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY!, 'hex');

    const encryptedSession = encryptBlob(sessionData, masterKey);
    const encryptedPhone = encryptString(state.phone!, masterKey);
    const phoneHash = SessionBridge.phoneHash(state.phone!);

    sessionRepo.upsert(userId, encryptedSession, encryptedPhone, phoneHash);
    sceneLogger.info({ userId }, 'Telegram session connected');

    await context.send(s.success(maskPhone(state.phone!)));
  } catch (err) {
    sceneLogger.error({ err, userId }, 'Failed to finalize session');
    await context.send(s.featureUnavailable);
  } finally {
    await SessionBridge.cleanupTempFile(state.sessionPath!);
    await context.scene.exit();
  }
}
```

- [ ] **Step 3: Register scene in `src/bot/scenes/index.ts`**

Thread `TelegramSessionRepository` and `EnvConfig` through `createScenesPlugin`:

```ts
export function createScenesPlugin(
  db: DatabaseService,
  eventService: EventService,
  botToken: string,
  userComposer: UserResolverComposer,
  config: EnvConfig,                 // NEW
  gcalConfigured = false,
  // ... existing params ...
) {
  // ... existing scene construction ...
  const connectTelegramScene = createConnectTelegramScene(db.telegramSessions, config, userComposer);
  const allScenes = [
    addEventScene,
    editValueScene,
    importScene,
    timezoneScene,
    onboardingScene,
    connectTelegramScene,
  ];

  return {
    plugin: scenes(allScenes, { storage: scopedStorage }),
    storage: scopedStorage,
    scenes: {
      addEventScene,
      editValueScene,
      importScene,
      timezoneScene,
      onboardingScene,
      connectTelegramScene,
    },
  };
}
```

Update the call site in `src/bot/index.ts` to pass `config`.

- [ ] **Step 4: Run tests, type-check**

```bash
bun test test/bot/scenes/connect-telegram.scene.test.ts
tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/scenes/connect-telegram.scene.ts \
  src/bot/scenes/index.ts src/bot/index.ts \
  test/bot/scenes/connect-telegram.scene.test.ts
git commit -m "feat(connect-telegram): GramIO scene for account connection flow"
```

---

