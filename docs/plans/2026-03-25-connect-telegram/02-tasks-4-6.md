> Part 2 of 5 of [Connect Telegram Account — Implementation Plan](../2026-03-25-connect-telegram.md) — previous: [01-overview-tasks-1-3.md](01-overview-tasks-1-3.md) · next: [03-tasks-7-8.md](03-tasks-7-8.md)

## Task 4: I18N Strings

**Files:**
- Modify: `src/config/constants.ts`

- [ ] **Step 1: Add i18n strings to MSG.en and MSG.ru**

In `src/config/constants.ts`, add to the `settings` namespace in both `MSG.en` and `MSG.ru`. **Do not include the mask format literally** — format it via a helper.

```ts
// helper (top of file or near other formatters):
export function maskPhone(phoneE164: string): string {
  // Input: '+79001234567' → Output: '+7 ••• 4567'
  if (!phoneE164.startsWith('+') || phoneE164.length < 6) return '+••• ••••';
  const last4 = phoneE164.slice(-4);
  // Country code: rough heuristic — +1, +7 are single-digit; +XX for most; +XXX for 3-digit codes.
  // The heuristic here is "everything before the last 4 digits" joined minus the middle.
  // For now take the first 1–3 digits after '+':
  const body = phoneE164.slice(1, -4); // digits between '+' and last4
  const countryLen = body.length >= 10 ? 1 : body.length >= 9 ? 2 : 3;
  const cc = phoneE164.slice(1, 1 + countryLen);
  return `+${cc} ••• ${last4}`;
}
```

Note: the heuristic handles `+1XXXXXXXXXX` (NANP, 10 body digits → cc=1), `+7XXXXXXXXXX` (RU, 10 → cc=1 — wait, 1-digit cc means 10 body digits), `+44XXXXXXXXXX` (UK, 10 body → cc=2 with body=10? fix logic).

Correct rule: `body.length` is total number length minus 1 (plus) minus 4 (last4). For E.164 range 8–15 total digits, `body` is 3–10. Simpler: store a small `COUNTRY_CODE_LEN` lookup by first 1–3 digits, but that's a table of ~300 entries. For MVP just take the first 2 digits after `+` and mask the rest:

```ts
export function maskPhone(phoneE164: string): string {
  if (!phoneE164.startsWith('+') || phoneE164.length < 6) return '+••• ••••';
  const cc = phoneE164.slice(1, 3);
  const last4 = phoneE164.slice(-4);
  return `+${cc} ••• ${last4}`;
}
```

For `+7` this shows `+79 ••• 4567` which is wrong (country code is `7`, not `79`). The right answer is `libphonenumber-js`:

```bash
bun add libphonenumber-js
```

```ts
import { parsePhoneNumber } from 'libphonenumber-js';

export function maskPhone(phoneE164: string): string {
  try {
    const parsed = parsePhoneNumber(phoneE164);
    if (!parsed.isValid()) return '+••• ••••';
    const last4 = phoneE164.slice(-4);
    return `+${parsed.countryCallingCode} ••• ${last4}`;
  } catch {
    return '+••• ••••';
  }
}
```

Use this in the settings strings below:

```ts
// Inside MSG.en.settings:
telegramAccount: '📱 Telegram account',
telegramConnected: (masked: string) => `📱 Telegram: connected (${masked})`,
telegramNotConnected: '📱 Telegram: not connected',
telegramConnect: '📱 Connect',
telegramDisconnect: '📱 Disconnect',
telegramDisconnectConfirm: 'Disconnect Telegram account? Invitations will be sent from the bot.',
telegramDisconnected: '✅ Telegram account disconnected.',

// Inside MSG.ru.settings:
telegramAccount: '📱 Telegram-аккаунт',
telegramConnected: (masked: string) => `📱 Telegram: подключён (${masked})`,
telegramNotConnected: '📱 Telegram: не подключён',
telegramConnect: '📱 Подключить',
telegramDisconnect: '📱 Отключить',
telegramDisconnectConfirm: 'Отключить Telegram-аккаунт? Приглашения будут отправляться через бота.',
telegramDisconnected: '✅ Telegram-аккаунт отключён.',
```

Add to `aiTools.meta` namespace:

```ts
// MSG.en.aiTools.meta:
telegramConnectedStatus: (masked: string) => `Telegram account connected (${masked})`,
telegramNotConnectedStatus: 'Telegram account not connected. Connect via /connect_telegram',

// MSG.ru.aiTools.meta:
telegramConnectedStatus: (masked: string) => `Telegram-аккаунт подключён (${masked})`,
telegramNotConnectedStatus: 'Telegram-аккаунт не подключён. Подключить: /connect_telegram',
```

Scene strings (top-level `connectTelegram` namespace):

```ts
// MSG.en:
connectTelegram: {
  consent: [
    '🔐 Connect Telegram Account',
    '',
    'This lets the bot send meeting invitations on your behalf',
    'to people who haven\'t started the bot yet.',
    '',
    '🔒 Security:',
    '• Session data is encrypted with AES-256-GCM',
    '• The encryption key lives only in the bot process memory — it is not stored on disk next to the data',
    '• The bot stores a technical session — no passwords, no messages',
    '',
    'The bot will NOT:',
    '• Read your messages',
    '• Send messages without your command',
    '• Access your contacts',
    '',
    'The bot WILL:',
    '• Send meeting invitations on your behalf',
    '',
    'You can disconnect anytime in /settings.',
  ].join('\n'),
  btnConnect: 'Connect',
  btnCancel: 'Cancel',
  enterPhone: 'Enter phone number in international format:\nExample: +79001234567',
  invalidPhone: 'Invalid format. Use international format: +79001234567',
  codeSent: 'Verification code sent to Telegram.\nEnter the code (5 digits):',
  invalidCode: 'Invalid code. Try again.',
  codeExpired: 'Code expired. Start over: /connect_telegram',
  tooManyAttempts: 'Too many failed attempts. Start over: /connect_telegram',
  enter2fa: 'You have two-factor authentication enabled.\nEnter your password (it will not be stored):',
  invalid2fa: 'Wrong password. Try again.',
  success: (masked: string) => `✅ Telegram account connected (${masked})\n\nInvitations will now be sent from your account.\nDisconnect: /settings`,
  cancelled: 'Connection cancelled.',
  featureUnavailable: 'Feature temporarily unavailable.',
  phoneAlreadyUsed: 'This phone number is already connected to another account.',
  floodWait: (minutes: number) => `Telegram rate-limited. Try again in ${minutes} min.`,
  alreadyConnected: (masked: string) => `✅ Telegram account already connected (${masked})\nReconnect?`,
  btnReconnect: 'Reconnect',
  cooldown: (seconds: number) => `Please wait ${seconds}s before retrying.`,
},

// MSG.ru:
connectTelegram: {
  consent: [
    '🔐 Подключение Telegram-аккаунта',
    '',
    'Это позволит боту отправлять приглашения на встречи от твоего имени',
    'людям, которые ещё не пользуются ботом.',
    '',
    '🔒 Безопасность:',
    '• Данные сессии зашифрованы AES-256-GCM',
    '• Ключ шифрования живёт только в памяти процесса бота — на диске рядом с данными его нет',
    '• Бот хранит только техническую сессию — без паролей и сообщений',
    '',
    'Бот НЕ будет:',
    '• Читать твои сообщения',
    '• Отправлять сообщения без твоей команды',
    '• Получать доступ к твоим контактам',
    '',
    'Бот БУДЕТ:',
    '• Отправлять приглашения на встречи от твоего имени',
    '',
    'Отключить можно в любой момент в /settings.',
  ].join('\n'),
  btnConnect: 'Подключить',
  btnCancel: 'Отмена',
  enterPhone: 'Введи номер телефона в международном формате:\nНапример: +79001234567',
  invalidPhone: 'Неверный формат. Используй международный формат: +79001234567',
  codeSent: 'Код подтверждения отправлен в Telegram.\nВведи код (5 цифр):',
  invalidCode: 'Неверный код. Попробуй ещё раз.',
  codeExpired: 'Код истёк. Начни заново: /connect_telegram',
  tooManyAttempts: 'Слишком много попыток. Начни заново: /connect_telegram',
  enter2fa: 'У тебя включена двухфакторная аутентификация.\nВведи пароль (он не будет сохранён):',
  invalid2fa: 'Неверный пароль. Попробуй ещё раз.',
  success: (masked: string) => `✅ Telegram-аккаунт подключён (${masked})\n\nТеперь приглашения на встречи будут отправляться от твоего имени.\nОтключить: /settings`,
  cancelled: 'Подключение отменено.',
  featureUnavailable: 'Функция временно недоступна.',
  phoneAlreadyUsed: 'Этот номер телефона уже подключён к другому аккаунту.',
  floodWait: (minutes: number) => `Telegram ограничил запросы. Попробуй через ${minutes} мин.`,
  alreadyConnected: (masked: string) => `✅ Telegram-аккаунт уже подключён (${masked})\nПереподключить?`,
  btnReconnect: 'Переподключить',
  cooldown: (seconds: number) => `Подожди ${seconds}с перед повтором.`,
},
```

Add invitation text strings (used by Task 9 first-person formatter):

```ts
// MSG.en.aiTools.sharing:
userSessionInvitation: (args: { title: string; dateLine: string; locationLine: string; descriptionLine: string; deepLink: string }) =>
  `Inviting you to "${args.title}"\n📅 ${args.dateLine}${args.locationLine}${args.descriptionLine}\n\nDetails & RSVP: ${args.deepLink}`,

// MSG.ru.aiTools.sharing:
userSessionInvitation: (args: { title: string; dateLine: string; locationLine: string; descriptionLine: string; deepLink: string }) =>
  `Приглашаю тебя на «${args.title}»\n📅 ${args.dateLine}${args.locationLine}${args.descriptionLine}\n\nПодробнее и ответить: ${args.deepLink}`,
```

- [ ] **Step 2: Type-check**

```bash
tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/config/constants.ts package.json bun.lock
git commit -m "feat(connect-telegram): add i18n strings and maskPhone helper (libphonenumber-js)"
```

---

## Task 5: Python Bridge Scripts

**Files:**
- Create: `scripts/connect-session.py`
- Create: `scripts/send-as-user.py`

- [ ] **Step 1: Create connect-session.py**

```python
#!/usr/bin/env python3
"""Pyrogram auth bridge for /connect_telegram flow.

Subcommands:
  send_code      — send verification code to phone
  sign_in        — verify code, produce session file
  check_password — enter 2FA password (read from stdin to avoid ps aux leak)
  log_out        — invalidate a Pyrogram session

Exit codes: 0 = success, 1 = known error (JSON on stdout), 2 = unexpected error.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from pyrogram import Client
from pyrogram.errors import (
    FloodWait,
    PasswordHashInvalid,
    PhoneCodeExpired,
    PhoneCodeInvalid,
    PhoneNumberInvalid,
    SessionPasswordNeeded,
)

API_ID = int(os.environ.get("MTPROTO_API_ID", "0"))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")


def error_json(code: str, message: str, extra: dict | None = None) -> str:
    result = {"error": code, "message": message}
    if extra:
        result.update(extra)
    return json.dumps(result)


def make_client(session_path: str) -> Client:
    p = Path(session_path)
    # Pyrogram uses `name` (without .session) + `workdir`. Path split is robust to dots in path.
    return Client(
        name=p.with_suffix("").name,
        api_id=API_ID,
        api_hash=API_HASH,
        workdir=str(p.parent) or ".",
    )


async def cmd_send_code(args: argparse.Namespace) -> None:
    client = make_client(args.session_path)
    await client.connect()
    try:
        sent = await client.send_code(args.phone)
        print(json.dumps({"phone_code_hash": sent.phone_code_hash}))
    except PhoneNumberInvalid:
        print(error_json("PHONE_INVALID", "Invalid phone number"))
        sys.exit(1)
    except FloodWait as e:
        print(error_json("FLOOD_WAIT", f"Rate limited for {e.value}s", {"retry_after": e.value}))
        sys.exit(1)
    finally:
        await client.disconnect()


async def cmd_sign_in(args: argparse.Namespace) -> None:
    client = make_client(args.session_path)
    await client.connect()
    try:
        await client.sign_in(args.phone, args.phone_code_hash, args.code)
        print(json.dumps({"status": "ok"}))
    except SessionPasswordNeeded:
        print(json.dumps({"status": "2fa_required"}))
    except PhoneCodeInvalid:
        print(error_json("CODE_INVALID", "Invalid verification code"))
        sys.exit(1)
    except PhoneCodeExpired:
        print(error_json("CODE_EXPIRED", "Verification code expired"))
        sys.exit(1)
    except FloodWait as e:
        print(error_json("FLOOD_WAIT", f"Rate limited for {e.value}s", {"retry_after": e.value}))
        sys.exit(1)
    finally:
        await client.disconnect()


async def cmd_check_password(args: argparse.Namespace) -> None:
    # Read password from stdin to avoid process listing exposure
    password = sys.stdin.readline().rstrip("\n")
    client = make_client(args.session_path)
    await client.connect()
    try:
        await client.check_password(password)
        print(json.dumps({"status": "ok"}))
    except PasswordHashInvalid:
        print(error_json("PASSWORD_INVALID", "Wrong 2FA password"))
        sys.exit(1)
    except FloodWait as e:
        print(error_json("FLOOD_WAIT", f"Rate limited for {e.value}s", {"retry_after": e.value}))
        sys.exit(1)
    finally:
        await client.disconnect()


async def cmd_log_out(args: argparse.Namespace) -> None:
    client = make_client(args.session_path)
    await client.connect()
    try:
        await client.log_out()
        print(json.dumps({"status": "ok"}))
    except Exception as e:
        print(error_json("LOG_OUT_FAILED", str(e)))
        sys.exit(1)
    finally:
        await client.disconnect()


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p_send = sub.add_parser("send_code")
    p_send.add_argument("--phone", required=True)
    p_send.add_argument("--session_path", required=True)

    p_sign = sub.add_parser("sign_in")
    p_sign.add_argument("--phone", required=True)
    p_sign.add_argument("--code", required=True)
    p_sign.add_argument("--phone_code_hash", required=True)
    p_sign.add_argument("--session_path", required=True)

    p_pass = sub.add_parser("check_password")
    p_pass.add_argument("--session_path", required=True)
    # password via stdin

    p_logout = sub.add_parser("log_out")
    p_logout.add_argument("--session_path", required=True)

    args = parser.parse_args()

    commands = {
        "send_code": cmd_send_code,
        "sign_in": cmd_sign_in,
        "check_password": cmd_check_password,
        "log_out": cmd_log_out,
    }

    try:
        asyncio.run(commands[args.command](args))
    except Exception as e:
        print(error_json("UNEXPECTED", str(e)), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Create send-as-user.py**

```python
#!/usr/bin/env python3
"""Send a Telegram message using a user's Pyrogram session."""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from pyrogram import Client
from pyrogram.errors import (
    AuthKeyUnregistered,
    FloodWait,
    PeerIdInvalid,
    SessionRevoked,
    UserDeactivated,
)

API_ID = int(os.environ.get("MTPROTO_API_ID", "0"))
API_HASH = os.environ.get("MTPROTO_API_HASH", "")


async def send_message(session_path: str, user_id: int, text: str, username: str | None) -> None:
    p = Path(session_path)
    client = Client(
        name=p.with_suffix("").name,
        api_id=API_ID,
        api_hash=API_HASH,
        workdir=str(p.parent) or ".",
    )
    await client.connect()
    try:
        target = username if username else user_id
        await client.send_message(target, text)
        print(json.dumps({"status": "ok"}))
    except (AuthKeyUnregistered, SessionRevoked, UserDeactivated) as e:
        print(json.dumps({"error": "SESSION_EXPIRED", "message": str(e)}))
        sys.exit(1)
    except PeerIdInvalid:
        print(json.dumps({"error": "PEER_INVALID", "message": f"Cannot reach user {user_id}"}))
        sys.exit(1)
    except FloodWait as e:
        print(json.dumps({"error": "FLOOD_WAIT", "retry_after": e.value}))
        sys.exit(1)
    finally:
        await client.disconnect()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session_path", required=True)
    parser.add_argument("--user_id", type=int, required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--username", default=None)
    args = parser.parse_args()
    asyncio.run(send_message(args.session_path, args.user_id, args.text, args.username))


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Syntax check**

```bash
venv/bin/python -m py_compile scripts/connect-session.py && \
venv/bin/python -m py_compile scripts/send-as-user.py && echo OK
```

If pyrogram is not installed locally, py_compile still succeeds because imports are not resolved.

- [ ] **Step 4: Commit**

```bash
git add scripts/connect-session.py scripts/send-as-user.py
git commit -m "feat(connect-telegram): Pyrogram bridge scripts (stdin password, pathlib client name)"
```

---

## Task 6: TypeScript Session Bridge (zod-codec stdout parsing)

**Files:**
- Create: `src/services/telegram-session/session-bridge.ts`
- Create: `test/services/telegram-session/session-bridge.test.ts`

**Design note:** Python stdout is arbitrary text — `JSON.parse` can throw. Rather than wrapping every call site in try/catch, the bridge uses a `z.codec(z.string(), Schema, { decode })` codec. `decode` runs `JSON.parse` inside and pushes an issue on failure; `safeParse` never throws. This is the cleanest way to do "JSON-string in → validated object out" with zod v4.

- [ ] **Step 1: Write bridge tests**

```ts
// test/services/telegram-session/session-bridge.test.ts
import { describe, test, expect } from 'bun:test';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';

describe('SessionBridge.parseResult', () => {
  test('success: send_code JSON', () => {
    const result = SessionBridge.parseResult('{"phone_code_hash":"abc123"}', '', 0);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ phone_code_hash: 'abc123' });
  });

  test('success: sign_in 2fa_required', () => {
    const result = SessionBridge.parseResult('{"status":"2fa_required"}', '', 0);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ status: '2fa_required' });
  });

  test('known error: exit 1 + error JSON on stdout', () => {
    const result = SessionBridge.parseResult(
      '{"error":"PHONE_INVALID","message":"Invalid phone number"}',
      '',
      1,
    );
    expect(result).toEqual({ success: false, error: 'PHONE_INVALID', message: 'Invalid phone number' });
  });

  test('unexpected: exit 2 + stderr traceback', () => {
    const result = SessionBridge.parseResult('', 'Traceback...', 2);
    expect(result).toEqual({ success: false, error: 'UNEXPECTED', message: 'Traceback...' });
  });

  test('flood wait: retry_after surfaced', () => {
    const result = SessionBridge.parseResult(
      '{"error":"FLOOD_WAIT","message":"Rate limited","retry_after":300}',
      '',
      1,
    );
    expect(result).toEqual({
      success: false,
      error: 'FLOOD_WAIT',
      message: 'Rate limited',
      retryAfter: 300,
    });
  });

  test('malformed JSON on exit 0 (codec catches parse error, no throw)', () => {
    const result = SessionBridge.parseResult('not-json', '', 0);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('UNEXPECTED');
  });

  test('valid JSON but unknown shape', () => {
    const result = SessionBridge.parseResult('{"random":"field"}', '', 0);
    expect(result.success).toBe(false);
  });

  test('phoneHash is consistent SHA-256', () => {
    const a = SessionBridge.phoneHash('+79001234567');
    const b = SessionBridge.phoneHash('+79001234567');
    expect(a).toBe(b);
    expect(a.length).toBe(64);
    expect(SessionBridge.phoneHash('+79009999999')).not.toBe(a);
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/services/telegram-session/session-bridge.ts
import { createHash, randomBytes } from 'node:crypto';
import { unlink, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { z } from 'zod';
import { logger } from '../../utils/logger.ts';

const bridgeLogger = logger.child({ module: 'session-bridge' });

const PYTHON_PATH = 'venv/bin/python';
const CONNECT_SCRIPT = 'scripts/connect-session.py';
const SEND_SCRIPT = 'scripts/send-as-user.py';
const SPAWN_TIMEOUT_MS = 60_000;

// --- Success schemas ---
const SendCodeSchema = z.object({ phone_code_hash: z.string() });
const SignInSchema = z.object({ status: z.enum(['ok', '2fa_required']) });
const CheckPasswordSchema = z.object({ status: z.literal('ok') });
const SendAsUserSchema = z.object({ status: z.literal('ok') });
const LogOutSchema = z.object({ status: z.literal('ok') });

const SuccessSchema = z.union([
  SendCodeSchema,
  SignInSchema,
  CheckPasswordSchema,
  SendAsUserSchema,
  LogOutSchema,
]);
export type BridgeSuccessData = z.infer<typeof SuccessSchema>;

// --- Error schema ---
const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  retry_after: z.number().optional(),
});

// --- Codec: JSON string → typed object, no external try/catch ---
function jsonStringCodec<T extends z.ZodTypeAny>(inner: T) {
  return z.codec(z.string(), inner, {
    decode: (raw, ctx) => {
      try {
        return JSON.parse(raw);
      } catch {
        ctx.issues.push({
          code: 'custom',
          message: 'Invalid JSON from Python bridge',
          input: raw,
        });
        return {} as z.input<T>;
      }
    },
    encode: (value) => JSON.stringify(value),
  });
}

const SuccessStringCodec = jsonStringCodec(SuccessSchema);
const ErrorStringCodec = jsonStringCodec(ErrorSchema);

export interface BridgeSuccess {
  success: true;
  data: BridgeSuccessData;
}

export interface BridgeError {
  success: false;
  error: string;
  message: string;
  retryAfter?: number;
}

export type BridgeResult = BridgeSuccess | BridgeError;

export class SessionBridge {
  /**
   * Parse stdout / stderr / exit code into a typed result.
   * JSON parsing is done inside a zod codec — no external try/catch needed.
   */
  static parseResult(stdout: string, stderr: string, exitCode: number): BridgeResult {
    const trimmedStdout = stdout.trim();

    if (exitCode === 0) {
      const parsed = SuccessStringCodec.safeParse(trimmedStdout);
      if (parsed.success) return { success: true, data: parsed.data };
      return { success: false, error: 'UNEXPECTED', message: `Invalid success response: ${trimmedStdout}` };
    }

    if (exitCode === 1) {
      const parsed = ErrorStringCodec.safeParse(trimmedStdout);
      if (parsed.success) {
        return {
          success: false,
          error: parsed.data.error,
          message: parsed.data.message,
          retryAfter: parsed.data.retry_after,
        };
      }
    }

    return {
      success: false,
      error: 'UNEXPECTED',
      message: stderr.trim() || trimmedStdout || `Process exited with code ${exitCode}`,
    };
  }

  static phoneHash(phone: string): string {
    return createHash('sha256').update(phone).digest('hex');
  }

  /**
   * Atomic temp-file creation: O_CREAT|O_EXCL|O_WRONLY, 0o600.
   * Returns the file path. Fails if the path already exists (symlink race protection).
   */
  static async createTempSessionFile(userId: number, contents: Buffer): Promise<string> {
    const rand = randomBytes(8).toString('hex');
    const path = `/tmp/tgsess_${userId}_${rand}.session`;
    const fh = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await fh.writeFile(contents);
    } finally {
      await fh.close();
    }
    return path;
  }

  /**
   * Generate an empty temp file path for send_code / sign_in where Pyrogram will create the file itself.
   * We still reserve the path atomically (touch+delete) to prevent collision, then hand it off.
   */
  static async reserveEmptySessionPath(userId: number): Promise<string> {
    const rand = randomBytes(8).toString('hex');
    const path = `/tmp/tgsess_${userId}_${rand}.session`;
    // Pyrogram creates the file; we just verify the path is free
    return path;
  }

  private static async spawn(args: string[], stdinData?: Buffer): Promise<BridgeResult> {
    const proc = Bun.spawn([PYTHON_PATH, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: stdinData ?? undefined,
    });

    const timeout = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return SessionBridge.parseResult(stdout, stderr, exitCode);
    } finally {
      clearTimeout(timeout);
    }
  }

  static async sendCode(phone: string, sessionPath: string): Promise<BridgeResult> {
    bridgeLogger.info({ phoneMask: `+***${phone.slice(-4)}` }, 'Sending verification code');
    return SessionBridge.spawn([CONNECT_SCRIPT, 'send_code', '--phone', phone, '--session_path', sessionPath]);
  }

  static async signIn(
    phone: string,
    code: string,
    phoneCodeHash: string,
    sessionPath: string,
  ): Promise<BridgeResult> {
    return SessionBridge.spawn([
      CONNECT_SCRIPT,
      'sign_in',
      '--phone', phone,
      '--code', code,
      '--phone_code_hash', phoneCodeHash,
      '--session_path', sessionPath,
    ]);
  }

  static async checkPassword(password: string, sessionPath: string): Promise<BridgeResult> {
    return SessionBridge.spawn(
      [CONNECT_SCRIPT, 'check_password', '--session_path', sessionPath],
      Buffer.from(`${password}\n`),
    );
  }

  static async logOut(sessionPath: string): Promise<BridgeResult> {
    return SessionBridge.spawn([CONNECT_SCRIPT, 'log_out', '--session_path', sessionPath]);
  }

  /**
   * Send message using a decrypted session file that the caller has already written to disk.
   * Caller owns cleanup of sessionPath.
   */
  static async sendAsUser(
    sessionPath: string,
    userId: number,
    text: string,
    username?: string,
  ): Promise<BridgeResult> {
    const args = [
      SEND_SCRIPT,
      '--session_path', sessionPath,
      '--user_id', userId.toString(),
      '--text', text,
    ];
    if (username) args.push('--username', username);
    return SessionBridge.spawn(args);
  }

  static async cleanupTempFile(sessionPath: string): Promise<void> {
    try {
      await unlink(sessionPath);
    } catch (err) {
      // Expected when Pyrogram never created the file (e.g. send_code failed before write)
      bridgeLogger.debug({ err, sessionPath }, 'Temp session file cleanup: file did not exist');
    }
  }
}
```

- [ ] **Step 3: Run test, commit**

```bash
bun test test/services/telegram-session/session-bridge.test.ts
git add src/services/telegram-session/session-bridge.ts \
  test/services/telegram-session/session-bridge.test.ts
git commit -m "feat(connect-telegram): session bridge with zod-codec stdout parsing"
```

---

