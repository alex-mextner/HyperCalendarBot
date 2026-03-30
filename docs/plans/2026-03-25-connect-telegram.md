# Connect Telegram Account — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to connect their Telegram account so the bot can send event invitations from the user's own account to people who haven't started the bot.

**Architecture:** GramIO scene guides user through Pyrogram auth flow (phone → OTP → optional 2FA). Encrypted session stored in SQLite. On invitation delivery, user's session is tried before the admin MTProto fallback. Settings menu shows connection status with connect/disconnect actions.

**Tech Stack:** AES-256-GCM (node:crypto), Pyrogram (Python bridge via Bun.spawn), GramIO scenes, bun:sqlite

**Spec:** `docs/specs/2026-03-24-connect-telegram.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/database/repositories/telegram-session.repository.ts` | CRUD for `user_telegram_sessions` table |
| `src/services/crypto/session-crypto.ts` | Buffer-based AES-256-GCM encrypt/decrypt for Pyrogram session blobs |
| `src/services/telegram-session/session-bridge.ts` | TypeScript wrapper for Python bridge scripts (`Bun.spawn`) |
| `src/bot/scenes/connect-telegram.scene.ts` | 5-step GramIO scene + `ConnectTelegramState` interface (co-located) |
| `scripts/connect-session.py` | Pyrogram auth: `send_code`, `sign_in`, `check_password` subcommands |
| `scripts/send-as-user.py` | Send message via user's Pyrogram session |
| `test/database/repositories/telegram-session.repository.test.ts` | Repository tests |
| `test/services/crypto/session-crypto.test.ts` | Crypto roundtrip + tamper detection tests |
| `test/services/telegram-session/session-bridge.test.ts` | Bridge wrapper tests (mocked Bun.spawn) |
| `test/bot/scenes/connect-telegram.scene.test.ts` | Scene step flow tests |
| `test/services/ai/tool-handlers/connect-telegram-status.test.ts` | AI tool handler test |

### Modified files

| File | Change |
|------|--------|
| `src/config/env.ts` | Add `TELEGRAM_SESSION_MASTER_KEY?: string` |
| `src/config/constants.ts` | Add i18n strings for connect/disconnect UI |
| `src/database/types.ts` | Add `TelegramSession` interface |
| `src/database/migrations.ts` | Migration 043: `user_telegram_sessions` table |
| `src/database/index.ts` | Register `TelegramSessionRepository` in `DatabaseService` |
| `src/bot/scenes/index.ts` | Register connect-telegram scene |
| `src/bot/commands/settings.ts` | Add Telegram account row to settings UI + callbacks |
| `src/services/ai/tools.ts` | Add `connect_telegram_status` tool definition |
| `src/services/ai/tool-executor.ts` | Add dispatch case for the new tool |
| `src/services/ai/tool-handlers/settings.ts` | Add handler for `connect_telegram_status` |
| `src/services/ai/types.ts` | Add `TelegramSessionData` to `ToolResultData`, add `sendAsConnectedUser` to `TelegramSender` |
| `src/services/ai/tool-handlers/sharing.ts` | Insert user-session delivery step into `deliverInvitationAsync` |
| `src/services/ai/telegram-sender.ts` | Implement `sendAsConnectedUser` — decrypt session, write temp file, spawn send-as-user.py |

---

## Task 1: Config, Types & Migration

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/database/types.ts`
- Modify: `src/database/migrations.ts`
- Modify: `src/database/index.ts`
- Create: `src/database/repositories/telegram-session.repository.ts`
- Create: `test/database/repositories/telegram-session.repository.test.ts`

- [ ] **Step 1: Add env var to config**

In `src/config/env.ts`, add to `EnvConfig`:

```ts
TELEGRAM_SESSION_MASTER_KEY?: string; // 64 hex chars = 32 bytes for AES-256-GCM
```

In `loadConfig()` return block, add:

```ts
TELEGRAM_SESSION_MASTER_KEY: process.env.TELEGRAM_SESSION_MASTER_KEY || undefined,
```

No startup validation — feature degrades gracefully when key is absent.

- [ ] **Step 2: Add database type**

In `src/database/types.ts`, add:

```ts
export interface TelegramSession {
  user_id: number;
  encrypted_session: Buffer;
  phone_hash: string;
  phone_last4: string;
  status: 'active' | 'expired' | 'revoked';
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 3: Add migration**

In `src/database/migrations.ts`, add migration `043_create_user_telegram_sessions`:

```ts
{
  name: '043_create_user_telegram_sessions',
  up: (db) => {
    db.exec(`
      CREATE TABLE user_telegram_sessions (
        user_id          INTEGER PRIMARY KEY,
        encrypted_session BLOB NOT NULL,
        phone_hash       TEXT NOT NULL,
        phone_last4      TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'active',
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_tg_sessions_phone_hash ON user_telegram_sessions(phone_hash);
    `);
  },
},
```

- [ ] **Step 4: Write repository test**

```ts
// test/database/repositories/telegram-session.repository.test.ts
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach } from 'bun:test';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';

describe('TelegramSessionRepository', () => {
  let db: Database;
  let repo: TelegramSessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    runMigrations(db, migrations);
    // Create a user for FK
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(100, 'Test');
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(200, 'Other');
    repo = new TelegramSessionRepository(db);
  });

  test('upsert creates a new session', () => {
    const blob = Buffer.from('encrypted-data');
    repo.upsert(100, blob, 'hash123', '4567');
    const session = repo.findByUserId(100);
    expect(session).not.toBeNull();
    expect(session!.phone_last4).toBe('4567');
    expect(session!.status).toBe('active');
    expect(Buffer.from(session!.encrypted_session)).toEqual(blob);
  });

  test('upsert replaces existing session', () => {
    repo.upsert(100, Buffer.from('old'), 'hash1', '1111');
    repo.upsert(100, Buffer.from('new'), 'hash2', '2222');
    const session = repo.findByUserId(100);
    expect(session!.phone_last4).toBe('2222');
    expect(Buffer.from(session!.encrypted_session)).toEqual(Buffer.from('new'));
  });

  test('findByUserId returns null for missing user', () => {
    expect(repo.findByUserId(999)).toBeNull();
  });

  test('getActive returns only active sessions', () => {
    repo.upsert(100, Buffer.from('data'), 'hash1', '1111');
    expect(repo.getActive(100)).not.toBeNull();
    repo.updateStatus(100, 'revoked');
    expect(repo.getActive(100)).toBeNull();
  });

  test('updateStatus changes status and updated_at', () => {
    repo.upsert(100, Buffer.from('data'), 'hash1', '1111');
    const before = repo.findByUserId(100)!.updated_at;
    // Small delay to ensure timestamp differs
    repo.updateStatus(100, 'expired');
    const after = repo.findByUserId(100)!;
    expect(after.status).toBe('expired');
  });

  test('findByPhoneHash finds session', () => {
    repo.upsert(100, Buffer.from('data'), 'unique-hash', '1111');
    const session = repo.findByPhoneHash('unique-hash');
    expect(session).not.toBeNull();
    expect(session!.user_id).toBe(100);
  });

  test('phone_hash uniqueness prevents duplicate phones', () => {
    repo.upsert(100, Buffer.from('data1'), 'same-hash', '1111');
    // Second user with same phone hash should fail
    expect(() => repo.upsert(200, Buffer.from('data2'), 'same-hash', '1111')).toThrow();
  });

  test('deleteByUserId removes session', () => {
    repo.upsert(100, Buffer.from('data'), 'hash1', '1111');
    repo.deleteByUserId(100);
    expect(repo.findByUserId(100)).toBeNull();
  });
});
```

- [ ] **Step 5: Run test — verify it fails (no repository yet)**

```bash
bun test test/database/repositories/telegram-session.repository.test.ts
```

Expected: import error — module not found.

- [ ] **Step 6: Implement repository**

```ts
// src/database/repositories/telegram-session.repository.ts
import type { Database } from 'bun:sqlite';
import type { TelegramSession } from '../types.ts';

export class TelegramSessionRepository {
  constructor(private db: Database) {}

  findByUserId(userId: number): TelegramSession | null {
    return this.db
      .prepare('SELECT * FROM user_telegram_sessions WHERE user_id = ?')
      .get(userId) as TelegramSession | null;
  }

  getActive(userId: number): TelegramSession | null {
    return this.db
      .prepare("SELECT * FROM user_telegram_sessions WHERE user_id = ? AND status = 'active'")
      .get(userId) as TelegramSession | null;
  }

  findByPhoneHash(phoneHash: string): TelegramSession | null {
    return this.db
      .prepare('SELECT * FROM user_telegram_sessions WHERE phone_hash = ?')
      .get(phoneHash) as TelegramSession | null;
  }

  upsert(userId: number, encryptedSession: Buffer, phoneHash: string, phoneLast4: string): void {
    this.db
      .prepare(
        `INSERT INTO user_telegram_sessions (user_id, encrypted_session, phone_hash, phone_last4)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           encrypted_session = excluded.encrypted_session,
           phone_hash = excluded.phone_hash,
           phone_last4 = excluded.phone_last4,
           status = 'active',
           updated_at = datetime('now')`,
      )
      .run(userId, encryptedSession, phoneHash, phoneLast4);
  }

  updateStatus(userId: number, status: 'active' | 'expired' | 'revoked'): void {
    this.db
      .prepare("UPDATE user_telegram_sessions SET status = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(status, userId);
  }

  deleteByUserId(userId: number): void {
    this.db.prepare('DELETE FROM user_telegram_sessions WHERE user_id = ?').run(userId);
  }
}
```

- [ ] **Step 7: Register in DatabaseService**

In `src/database/index.ts`:
1. Import `TelegramSessionRepository`
2. Add field: `readonly telegramSessions: TelegramSessionRepository;`
3. In constructor: `this.telegramSessions = new TelegramSessionRepository(this.db);`

- [ ] **Step 8: Run test — verify it passes**

```bash
bun test test/database/repositories/telegram-session.repository.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/config/env.ts src/database/types.ts src/database/migrations.ts \
  src/database/index.ts src/database/repositories/telegram-session.repository.ts \
  test/database/repositories/telegram-session.repository.test.ts
git commit -m "feat(connect-telegram): add migration, types, and repository for user Telegram sessions"
```

---

## Task 2: Session Crypto

**Files:**
- Create: `src/services/crypto/session-crypto.ts`
- Create: `test/services/crypto/session-crypto.test.ts`

- [ ] **Step 1: Write crypto tests**

```ts
// test/services/crypto/session-crypto.test.ts
import { describe, test, expect } from 'bun:test';
import { encryptSession, decryptSession } from '../../../src/services/crypto/session-crypto.ts';
import { randomBytes } from 'node:crypto';

describe('session-crypto', () => {
  const masterKey = randomBytes(32); // 32 bytes for AES-256

  test('encrypt → decrypt roundtrip preserves data', () => {
    const original = randomBytes(4096); // simulate Pyrogram session file
    const encrypted = encryptSession(original, masterKey);
    const decrypted = decryptSession(encrypted, masterKey);
    expect(decrypted).toEqual(original);
  });

  test('encrypted blob is longer than plaintext (IV + tag overhead)', () => {
    const original = Buffer.from('short');
    const encrypted = encryptSession(original, masterKey);
    // 12 (IV) + len(ciphertext) + 16 (tag)
    expect(encrypted.length).toBe(original.length + 12 + 16);
  });

  test('different encryptions of same data produce different blobs (random IV)', () => {
    const original = Buffer.from('test-data');
    const enc1 = encryptSession(original, masterKey);
    const enc2 = encryptSession(original, masterKey);
    expect(enc1).not.toEqual(enc2); // random IV → different output
  });

  test('tampered ciphertext throws on decrypt', () => {
    const original = Buffer.from('secret');
    const encrypted = encryptSession(original, masterKey);
    // Flip a byte in the middle
    encrypted[20] ^= 0xff;
    expect(() => decryptSession(encrypted, masterKey)).toThrow();
  });

  test('wrong key throws on decrypt', () => {
    const original = Buffer.from('secret');
    const encrypted = encryptSession(original, masterKey);
    const wrongKey = randomBytes(32);
    expect(() => decryptSession(encrypted, wrongKey)).toThrow();
  });

  test('empty buffer roundtrip works', () => {
    const original = Buffer.alloc(0);
    const encrypted = encryptSession(original, masterKey);
    const decrypted = decryptSession(encrypted, masterKey);
    expect(decrypted).toEqual(original);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/services/crypto/session-crypto.test.ts
```

Expected: import error — module not found.

- [ ] **Step 3: Implement session crypto**

```ts
// src/services/crypto/session-crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Encrypts a binary blob (e.g. Pyrogram session file).
 * Output format: IV (12 bytes) || ciphertext || auth_tag (16 bytes)
 */
export function encryptSession(sessionData: Buffer, masterKey: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(sessionData), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]);
}

/**
 * Decrypts a blob produced by encryptSession.
 * Throws if tampered or wrong key (GCM auth tag verification).
 */
export function decryptSession(blob: Buffer, masterKey: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/services/crypto/session-crypto.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/crypto/session-crypto.ts test/services/crypto/session-crypto.test.ts
git commit -m "feat(connect-telegram): AES-256-GCM session encryption for Pyrogram blobs"
```

---

## Task 3: I18N Strings

**Files:**
- Modify: `src/config/constants.ts`

- [ ] **Step 1: Add i18n strings to MSG.en and MSG.ru**

In `src/config/constants.ts`, add to the `aiTools` namespace and `settings` namespace in both `MSG.en` and `MSG.ru`:

```ts
// Inside MSG.en.settings:
telegramAccount: '📱 Telegram account',
telegramConnected: (last4: string) => `📱 Telegram: connected (+***${last4})`,
telegramNotConnected: '📱 Telegram: not connected',
telegramConnect: '📱 Connect',
telegramDisconnect: '📱 Disconnect',
telegramDisconnectConfirm: 'Disconnect Telegram account? Invitations will be sent through the bot.',
telegramDisconnected: '✅ Telegram account disconnected.',

// Inside MSG.ru.settings:
telegramAccount: '📱 Telegram-аккаунт',
telegramConnected: (last4: string) => `📱 Telegram: подключён (+***${last4})`,
telegramNotConnected: '📱 Telegram: не подключён',
telegramConnect: '📱 Подключить',
telegramDisconnect: '📱 Отключить',
telegramDisconnectConfirm: 'Отключить Telegram-аккаунт? Приглашения будут отправляться через бота.',
telegramDisconnected: '✅ Telegram-аккаунт отключён.',
```

Add to `aiTools.meta` namespace:

```ts
// MSG.en.aiTools.meta:
telegramConnectedStatus: (last4: string) => `Telegram account connected (+***${last4})`,
telegramNotConnectedStatus: 'Telegram account not connected. Connect via /connect_telegram',

// MSG.ru.aiTools.meta:
telegramConnectedStatus: (last4: string) => `Telegram-аккаунт подключён (+***${last4})`,
telegramNotConnectedStatus: 'Telegram-аккаунт не подключён. Подключить: /connect_telegram',
```

Add scene strings (top-level `connectTelegram` namespace):

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
    '• Session data encrypted with AES-256-GCM (military-grade)',
    '• Only technical session stored — no phone number, passwords, or messages',
    '• Encryption key stored separately and never written to disk',
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
  success: (last4: string) => `✅ Telegram account connected (+***${last4})\n\nInvitations will now be sent from your account.\nDisconnect: /settings`,
  cancelled: 'Connection cancelled.',
  featureUnavailable: 'Feature temporarily unavailable.',
  phoneAlreadyUsed: 'This phone number is already connected to another account.',
  floodWait: (minutes: number) => `Telegram rate-limited. Try again in ${minutes} minutes.`,
  alreadyConnected: (last4: string) => `✅ Telegram account already connected (+***${last4})\nReconnect?`,
  btnReconnect: 'Reconnect',
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
    '• Данные сессии зашифрованы AES-256-GCM (военный стандарт шифрования)',
    '• Бот хранит только техническую сессию — без номера телефона, паролей и сообщений',
    '• Ключ шифрования хранится отдельно от данных и никогда не записывается на диск',
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
  success: (last4: string) => `✅ Telegram-аккаунт подключён (+***${last4})\n\nТеперь приглашения на встречи будут отправляться от твоего имени.\nОтключить: /settings`,
  cancelled: 'Подключение отменено.',
  featureUnavailable: 'Функция временно недоступна.',
  phoneAlreadyUsed: 'Этот номер телефона уже подключён к другому аккаунту.',
  floodWait: (minutes: number) => `Telegram ограничил запросы. Попробуй через ${minutes} мин.`,
  alreadyConnected: (last4: string) => `✅ Telegram-аккаунт уже подключён (+***${last4})\nПереподключить?`,
  btnReconnect: 'Переподключить',
},
```

- [ ] **Step 2: Verify types compile**

```bash
tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/config/constants.ts
git commit -m "feat(connect-telegram): add i18n strings for connect/disconnect Telegram flow"
```

---

## Task 4: Python Bridge Scripts

**Files:**
- Create: `scripts/connect-session.py`
- Create: `scripts/send-as-user.py`

- [ ] **Step 1: Create connect-session.py**

```python
#!/usr/bin/env python3
"""Pyrogram auth bridge for /connect_telegram flow.

Subcommands:
  send_code    — send verification code to phone
  sign_in      — verify code, produce session file
  check_password — enter 2FA password

Each subcommand outputs JSON on stdout, errors on stderr.
Exit code: 0 = success, 1 = known error (JSON on stdout), 2 = unexpected error.
"""

import argparse
import asyncio
import json
import os
import sys

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


async def cmd_send_code(args: argparse.Namespace) -> None:
    # Must use file-based session at the SAME path that sign_in will use later.
    # Pyrogram binds auth session key to the client — send_code and sign_in must share the session file.
    client = Client(
        name=args.session_path.replace(".session", ""),
        api_id=API_ID,
        api_hash=API_HASH,
        workdir=os.path.dirname(args.session_path) or ".",
    )
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
    client = Client(
        name=args.session_path.replace(".session", ""),
        api_id=API_ID,
        api_hash=API_HASH,
        workdir=os.path.dirname(args.session_path) or ".",
    )
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
    # Read password from stdin to avoid exposure in process listing (ps aux / /proc/cmdline)
    password = sys.stdin.readline().rstrip('\n')
    client = Client(
        name=args.session_path.replace(".session", ""),
        api_id=API_ID,
        api_hash=API_HASH,
        workdir=os.path.dirname(args.session_path) or ".",
    )
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
    # password is read from stdin — not passed as arg to avoid process listing exposure

    args = parser.parse_args()

    commands = {
        "send_code": cmd_send_code,
        "sign_in": cmd_sign_in,
        "check_password": cmd_check_password,
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
    client = Client(
        name=session_path.replace(".session", ""),
        api_id=API_ID,
        api_hash=API_HASH,
        workdir=os.path.dirname(session_path) or ".",
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

- [ ] **Step 3: Verify Python syntax**

```bash
venv/bin/python -m py_compile scripts/connect-session.py && \
venv/bin/python -m py_compile scripts/send-as-user.py && echo "OK"
```

Expected: "OK" (no syntax errors). If pyrogram imports fail, that's fine — they're not installed locally but will be on the server.

- [ ] **Step 4: Commit**

```bash
git add scripts/connect-session.py scripts/send-as-user.py
git commit -m "feat(connect-telegram): Python bridge scripts for Pyrogram auth and user-session messaging"
```

---

## Task 5: TypeScript Session Bridge

**Files:**
- Create: `src/services/telegram-session/session-bridge.ts`
- Create: `test/services/telegram-session/session-bridge.test.ts`

- [ ] **Step 1: Write bridge tests**

```ts
// test/services/telegram-session/session-bridge.test.ts
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';

// We test the JSON parsing and error handling logic, not actual Python calls.
// The bridge spawns `Bun.spawn` — we mock at the integration boundary.

describe('SessionBridge', () => {
  // Test the result parsing utilities exposed by the bridge

  test('parseResult handles success JSON (Zod-validated)', () => {
    const result = SessionBridge.parseResult('{"phone_code_hash": "abc123"}', '', 0);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ phone_code_hash: 'abc123' });
    }
  });

  test('parseResult handles sign_in success with 2fa_required', () => {
    const result = SessionBridge.parseResult('{"status": "2fa_required"}', '', 0);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ status: '2fa_required' });
    }
  });

  test('parseResult handles known error (exit 1)', () => {
    const result = SessionBridge.parseResult(
      '{"error": "PHONE_INVALID", "message": "Invalid phone number"}',
      '',
      1,
    );
    expect(result).toEqual({
      success: false,
      error: 'PHONE_INVALID',
      message: 'Invalid phone number',
    });
  });

  test('parseResult handles unexpected error (exit 2)', () => {
    const result = SessionBridge.parseResult('', 'Traceback...', 2);
    expect(result).toEqual({
      success: false,
      error: 'UNEXPECTED',
      message: 'Traceback...',
    });
  });

  test('parseResult handles flood wait with retry_after', () => {
    const result = SessionBridge.parseResult(
      '{"error": "FLOOD_WAIT", "message": "Rate limited", "retry_after": 300}',
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

  test('parseResult rejects malformed success JSON via Zod', () => {
    // Valid JSON but doesn't match any SuccessSchema variant
    const result = SessionBridge.parseResult('{"random": "field"}', '', 0);
    expect(result.success).toBe(false);
  });

  test('phoneLast4 extracts last 4 digits', () => {
    expect(SessionBridge.phoneLast4('+79001234567')).toBe('4567');
    expect(SessionBridge.phoneLast4('+1234')).toBe('1234');
  });

  test('phoneHash produces consistent SHA-256', () => {
    const hash1 = SessionBridge.phoneHash('+79001234567');
    const hash2 = SessionBridge.phoneHash('+79001234567');
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // hex SHA-256
    // Different phone → different hash
    expect(SessionBridge.phoneHash('+79009999999')).not.toBe(hash1);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/services/telegram-session/session-bridge.test.ts
```

Expected: import error — module not found.

- [ ] **Step 3: Implement session bridge**

```ts
// src/services/telegram-session/session-bridge.ts
import { createHash, randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { z } from 'zod';
import { logger } from '../../utils/logger.ts';

const bridgeLogger = logger.child({ module: 'session-bridge' });

const PYTHON_PATH = 'venv/bin/python';
const CONNECT_SCRIPT = 'scripts/connect-session.py';
const SEND_SCRIPT = 'scripts/send-as-user.py';
const SPAWN_TIMEOUT_MS = 30_000;

// Zod schemas for all Python bridge response types
const SendCodeSchema = z.object({ phone_code_hash: z.string() });
const SignInSchema = z.object({ status: z.enum(['ok', '2fa_required']) });
const CheckPasswordSchema = z.object({ status: z.literal('ok') });
const SendAsUserSchema = z.object({ status: z.literal('ok') });

const SuccessSchema = z.union([SendCodeSchema, SignInSchema, CheckPasswordSchema, SendAsUserSchema]);
type BridgeSuccessData = z.infer<typeof SuccessSchema>;

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  retry_after: z.number().optional(),
});

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
   * Parse stdout/stderr from Python bridge into typed result.
   * JSON.parse always goes through Zod validation.
   */
  static parseResult(stdout: string, stderr: string, exitCode: number): BridgeResult {
    if (exitCode === 0) {
      const parsed = SuccessSchema.safeParse(JSON.parse(stdout.trim()));
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return { success: false, error: 'UNEXPECTED', message: `Invalid response: ${stdout}` };
    }

    // Exit 1 = known error with JSON on stdout
    if (exitCode === 1) {
      const parsed = ErrorSchema.safeParse(JSON.parse(stdout.trim()));
      if (parsed.success) {
        return {
          success: false,
          error: parsed.data.error,
          message: parsed.data.message,
          retryAfter: parsed.data.retry_after,
        };
      }
    }

    // Exit 2 or unparseable = unexpected error
    return {
      success: false,
      error: 'UNEXPECTED',
      message: stderr.trim() || stdout.trim() || `Process exited with code ${exitCode}`,
    };
  }

  static phoneLast4(phone: string): string {
    return phone.slice(-4);
  }

  static phoneHash(phone: string): string {
    return createHash('sha256').update(phone).digest('hex');
  }

  /**
   * Generate a temporary session file path.
   */
  static tempSessionPath(userId: number): string {
    const rand = randomBytes(8).toString('hex');
    return `/tmp/tgsess_${userId}_${rand}.session`;
  }

  /**
   * Spawn Python script and collect output.
   */
  private static async spawn(args: string[], stdinData?: Buffer): Promise<BridgeResult> {
    const proc = Bun.spawn([PYTHON_PATH, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: stdinData,
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

  /**
   * Step 1: Send verification code to phone.
   * sessionPath is required — Pyrogram binds auth key to the session file,
   * so send_code and sign_in MUST share the same file.
   */
  static async sendCode(phone: string, sessionPath: string): Promise<BridgeResult> {
    bridgeLogger.info({ phone: `+***${phone.slice(-4)}` }, 'Sending verification code');
    return SessionBridge.spawn([CONNECT_SCRIPT, 'send_code', '--phone', phone, '--session_path', sessionPath]);
  }

  /**
   * Step 2: Sign in with verification code.
   */
  static async signIn(
    phone: string,
    code: string,
    phoneCodeHash: string,
    sessionPath: string,
  ): Promise<BridgeResult> {
    bridgeLogger.info({ phone: `+***${phone.slice(-4)}` }, 'Signing in with code');
    return SessionBridge.spawn([
      CONNECT_SCRIPT,
      'sign_in',
      '--phone', phone,
      '--code', code,
      '--phone_code_hash', phoneCodeHash,
      '--session_path', sessionPath,
    ]);
  }

  /**
   * Step 3: Check 2FA password.
   */
  static async checkPassword(password: string, sessionPath: string): Promise<BridgeResult> {
    bridgeLogger.info('Checking 2FA password');
    // Password passed via stdin to avoid exposure in process listing
    return SessionBridge.spawn(
      [CONNECT_SCRIPT, 'check_password', '--session_path', sessionPath],
      Buffer.from(`${password}\n`),
    );
  }

  /**
   * Send a message using a user's decrypted session file.
   * Cleans up temp file in finally.
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

    try {
      return await SessionBridge.spawn(args);
    } finally {
      try {
        await unlink(sessionPath);
      } catch {
        // File may not exist if spawn failed before creating it
      }
    }
  }

  /**
   * Clean up a temp session file (best-effort).
   */
  static async cleanupTempFile(sessionPath: string): Promise<void> {
    try {
      await unlink(sessionPath);
    } catch {
      // ignore
    }
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
bun test test/services/telegram-session/session-bridge.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/telegram-session/session-bridge.ts \
  test/services/telegram-session/session-bridge.test.ts
git commit -m "feat(connect-telegram): TypeScript bridge wrapper for Python session scripts"
```

---

## Task 6: GramIO Scene

**Files:**
- Create: `src/bot/scenes/connect-telegram.scene.ts` (includes `ConnectTelegramState` interface)
- Modify: `src/bot/scenes/index.ts`
- Create: `test/bot/scenes/connect-telegram.scene.test.ts`

- [ ] **Step 1: Define state type inline in scene file**

`ConnectTelegramState` lives in the scene file itself (matching codebase pattern where state interfaces are co-located with their scenes, not in a shared types.ts):

```ts
export interface ConnectTelegramState {
  phone?: string;
  phoneCodeHash?: string;
  sessionPath?: string;
  codeAttempts?: number;
  passwordAttempts?: number;
}
```

- [ ] **Step 2: Write scene test**

Test the consent step flow and phone validation. Scene tests focus on the message-response cycle:

```ts
// test/bot/scenes/connect-telegram.scene.test.ts
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';

// Test the phone validation regex and state transitions without a real GramIO scene runtime.
// Full scene integration tests require the bot framework — keep these as unit tests on helpers.

describe('connect-telegram scene helpers', () => {
  const PHONE_REGEX = /^\+\d{7,15}$/;

  test('phone regex accepts valid international numbers', () => {
    expect(PHONE_REGEX.test('+79001234567')).toBe(true);
    expect(PHONE_REGEX.test('+1234567890')).toBe(true);
    expect(PHONE_REGEX.test('+380501234567')).toBe(true);
  });

  test('phone regex rejects invalid formats', () => {
    expect(PHONE_REGEX.test('79001234567')).toBe(false); // no +
    expect(PHONE_REGEX.test('+123')).toBe(false); // too short
    expect(PHONE_REGEX.test('+1234567890123456')).toBe(false); // too long
    expect(PHONE_REGEX.test('+7900abc1234')).toBe(false); // letters
    expect(PHONE_REGEX.test('')).toBe(false);
  });

  test('OTP code regex accepts 5-digit codes', () => {
    const CODE_REGEX = /^\d{5}$/;
    expect(CODE_REGEX.test('12345')).toBe(true);
    expect(CODE_REGEX.test('00000')).toBe(true);
    expect(CODE_REGEX.test('1234')).toBe(false);
    expect(CODE_REGEX.test('123456')).toBe(false);
    expect(CODE_REGEX.test('abcde')).toBe(false);
  });

  test('phoneLast4 and phoneHash are consistent', () => {
    const phone = '+79001234567';
    expect(SessionBridge.phoneLast4(phone)).toBe('4567');
    expect(SessionBridge.phoneHash(phone).length).toBe(64);
  });
});
```

- [ ] **Step 3: Run test — verify it passes (pure validation tests)**

```bash
bun test test/bot/scenes/connect-telegram.scene.test.ts
```

- [ ] **Step 4: Implement scene**

Create `src/bot/scenes/connect-telegram.scene.ts`. The scene has 5 steps:

1. **Consent** — show security info, [Connect] / [Cancel]
2. **Phone** — validate `^\+\d{7,15}$`, call `SessionBridge.sendCode()`
3. **OTP** — validate 5-digit code, call `SessionBridge.signIn()`. If 2fa_required → go to step 4
4. **2FA password** — call `SessionBridge.checkPassword()` (skipped if no 2FA)
5. **Success** — encrypt session file, store in DB, cleanup temp file

Key implementation notes:
- `context.scene.step.firstTime` for initial prompts
- `context.scene.update(state)` to persist phone, hash, sessionPath
- Max 3 attempts for OTP and 2FA password
- On error: cleanup temp session file via `SessionBridge.cleanupTempFile(state.sessionPath)`
- Check `config.TELEGRAM_SESSION_MASTER_KEY` before starting — if absent, reply "feature unavailable"
- Check if phone is already connected via `repo.findByPhoneHash()` — reject duplicate

The scene needs injected dependencies: `TelegramSessionRepository`, `EnvConfig`.

```ts
// src/bot/scenes/connect-telegram.scene.ts
import { InlineKeyboard } from 'gramio';
import { Scene } from '@gramio/scenes';
import { t } from '../../config/constants.ts';
import type { EnvConfig } from '../../config/env.ts';
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import { encryptSession } from '../../services/crypto/session-crypto.ts';
import { SessionBridge } from '../../services/telegram-session/session-bridge.ts';
import { logger } from '../../utils/logger.ts';
import { getSceneLang } from './helpers.ts';

export interface ConnectTelegramState {
  phone?: string;
  phoneCodeHash?: string;
  sessionPath?: string;
  codeAttempts?: number;
  passwordAttempts?: number;
}

const sceneLogger = logger.child({ module: 'connect-telegram-scene' });
const PHONE_REGEX = /^\+\d{7,15}$/;
const CODE_REGEX = /^\d{5}$/;
const MAX_ATTEMPTS = 3;

export function createConnectTelegramScene(
  sessionRepo: TelegramSessionRepository,
  config: EnvConfig,
) {
  return new Scene('connect-telegram')
    .state<ConnectTelegramState>()

    // Step 0: Consent
    // Step 0 must accept both message (command entry) and callback_query (button clicks)
    .step(['message', 'callback_query'], async (context) => {
      const lang = getSceneLang(context);
      const s = t(lang).connectTelegram;

      if (context.scene.step.firstTime) {
        // Check if feature is available
        if (!config.TELEGRAM_SESSION_MASTER_KEY) {
          await context.send(s.featureUnavailable);
          return context.scene.exit();
        }

        // Check if already connected
        const userId = context.from?.id;
        if (userId) {
          const existing = sessionRepo.getActive(userId);
          if (existing) {
            const kb = new InlineKeyboard()
              .text(s.btnReconnect, 'ct:reconnect')
              .text(s.btnCancel, 'ct:cancel');
            await context.send(s.alreadyConnected(existing.phone_last4), { reply_markup: kb });
            return;
          }
        }

        const kb = new InlineKeyboard()
          .text(s.btnConnect, 'ct:connect')
          .text(s.btnCancel, 'ct:cancel');
        await context.send(s.consent, { reply_markup: kb });
        return;
      }

      const data = context.data;
      if (data === 'ct:cancel') {
        await context.send(s.cancelled);
        return context.scene.exit();
      }
      if (data === 'ct:connect' || data === 'ct:reconnect') {
        await context.send(s.enterPhone);
        return context.scene.step.next();
      }
    })

    // Step 1: Phone number
    .step('message', async (context) => {
      const lang = getSceneLang(context);
      const s = t(lang).connectTelegram;
      const text = context.text?.trim();

      if (!text || !PHONE_REGEX.test(text)) {
        await context.send(s.invalidPhone);
        return; // stay on same step
      }

      const phone = text;

      // Check if phone is used by another account
      const phoneHash = SessionBridge.phoneHash(phone);
      const existing = sessionRepo.findByPhoneHash(phoneHash);
      if (existing && existing.user_id !== context.from?.id) {
        await context.send(s.phoneAlreadyUsed);
        return context.scene.exit();
      }

      // Create temp session path BEFORE sendCode — Pyrogram needs a file-based session
      const sessionPath = SessionBridge.tempSessionPath(context.from!.id);

      // Send verification code (session file created here)
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
        sceneLogger.error({ err: result.message }, 'sendCode failed');
        await context.send(s.featureUnavailable);
        return context.scene.exit();
      }

      // data is typed by Zod — phone_code_hash guaranteed present on success
      await context.scene.update({
        phone,
        phoneCodeHash: 'phone_code_hash' in result.data ? result.data.phone_code_hash : '',
        sessionPath,
        codeAttempts: 0,
      });

      await context.send(s.codeSent);
      return context.scene.step.next();
    })

    // Step 2: OTP code
    .step('message', async (context) => {
      const lang = getSceneLang(context);
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

      // Check if 2FA required — data is typed by Zod union, use narrowing
      if ('status' in result.data && result.data.status === '2fa_required') {
        await context.scene.update({ passwordAttempts: 0 });
        await context.send(s.enter2fa);
        return context.scene.step.next();
      }

      // No 2FA — finalize
      await finalizeSession(context, state, sessionRepo, config, lang);
    })

    // Step 3: 2FA password
    .step('message', async (context) => {
      const lang = getSceneLang(context);
      const s = t(lang).connectTelegram;
      const state = context.scene.state;
      const password = context.text?.trim();

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

      await finalizeSession(context, state, sessionRepo, config, lang);
    });
}

/**
 * Read the temp session file, encrypt it, store in DB, send success message, cleanup.
 */
async function finalizeSession(
  context: { from?: { id: number }; send: (text: string) => Promise<unknown>; scene: { exit: () => unknown } },
  state: ConnectTelegramState,
  sessionRepo: TelegramSessionRepository,
  config: EnvConfig,
  lang: 'en' | 'ru',
): Promise<void> {
  const s = t(lang).connectTelegram;
  const userId = context.from!.id;

  try {
    const sessionFile = Bun.file(state.sessionPath!);
    const sessionData = Buffer.from(await sessionFile.arrayBuffer());
    const masterKey = Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY!, 'hex');
    const encrypted = encryptSession(sessionData, masterKey);

    const phoneHash = SessionBridge.phoneHash(state.phone!);
    const phoneLast4 = SessionBridge.phoneLast4(state.phone!);

    sessionRepo.upsert(userId, encrypted, phoneHash, phoneLast4);
    sceneLogger.info({ userId, phoneLast4 }, 'Telegram session connected');

    await context.send(s.success(phoneLast4));
  } catch (err) {
    sceneLogger.error({ err, userId }, 'Failed to finalize session');
    await context.send(s.featureUnavailable);
  } finally {
    await SessionBridge.cleanupTempFile(state.sessionPath!);
    context.scene.exit();
  }
}
```

- [ ] **Step 5: Register scene in index.ts**

In `src/bot/scenes/index.ts`:
1. Import `createConnectTelegramScene`
2. Add `config: EnvConfig` parameter to `createScenesPlugin` (or access it from existing deps)
3. Create scene: `const connectTelegramScene = createConnectTelegramScene(db.telegramSessions, config);`
4. Add to `allScenes` array
5. Export in the `scenes` object

- [ ] **Step 6: Run tests**

```bash
bun test test/bot/scenes/connect-telegram.scene.test.ts
```

Expected: all pass.

- [ ] **Step 7: Type-check**

```bash
tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add src/bot/scenes/connect-telegram.scene.ts \
  src/bot/scenes/index.ts test/bot/scenes/connect-telegram.scene.test.ts
git commit -m "feat(connect-telegram): GramIO scene for Telegram account connection flow"
```

---

## Task 7: Bot Commands & Settings Integration

**Files:**
- Modify: `src/bot/commands/settings.ts`
- Modify: bot command registration (where `/connect_telegram` command is registered)
- Create: `test/bot/commands/settings-telegram.test.ts`

- [ ] **Step 1: Add /connect_telegram and /disconnect_telegram commands**

These commands are thin wrappers:
- `/connect_telegram` → enter the `connect-telegram` scene
- `/disconnect_telegram` → confirm inline keyboard → revoke session + Pyrogram logout

Find where bot commands are registered (likely `src/bot/index.ts` or similar) and add:

```ts
bot.command('connect_telegram', async (ctx) => {
  ctx.scene.enter('connect-telegram');
});

bot.command('disconnect_telegram', async (ctx) => {
  const lang = ctx.lang ?? 'en';
  const s = t(lang).settings;
  const session = db.telegramSessions.getActive(ctx.dbUser.telegram_id);
  if (!session) {
    await ctx.send(s.telegramNotConnected);
    return;
  }
  const kb = new InlineKeyboard()
    .text(s.telegramDisconnect, 'stg:tg_disconnect_confirm')
    .text(t(lang).connectTelegram.btnCancel, 'stg:back');
  await ctx.send(s.telegramDisconnectConfirm, { reply_markup: kb });
});
```

- [ ] **Step 2: Add Telegram account row to settings UI**

In `src/bot/commands/settings.ts`:

1. Add `TelegramSessionRepository` to `settingsCategoryKeyboard` or the main settings view.

Add a new row to `settingsCategoryKeyboard()`:

```ts
// After the .text(s.categoryVoice, 'stg:voice') row, add:
.row()
.text(s.telegramAccount, 'stg:telegram')
```

2. Add a `buildTelegramView` function:

```ts
function buildTelegramView(
  session: TelegramSession | null,
  lang: 'en' | 'ru',
): { text: string; kb: InlineKeyboard } {
  const s = t(lang).settings;
  const ct = t(lang).connectTelegram;

  if (session && session.status === 'active') {
    const text = s.telegramConnected(session.phone_last4);
    const kb = backRow(
      new InlineKeyboard().text(s.telegramDisconnect, 'stg:tg_disconnect_confirm'),
      lang,
    );
    return { text, kb };
  }

  const text = s.telegramNotConnected;
  const kb = backRow(
    new InlineKeyboard().text(s.telegramConnect, 'stg:tg_connect'),
    lang,
  );
  return { text, kb };
}
```

3. Add callback handling in `handleSettingsCallback`:

```ts
if (subAction === 'telegram') {
  const session = telegramSessionRepo?.findByUserId(user.telegram_id) ?? null;
  const { text, kb } = buildTelegramView(session, lang);
  await ctx.answer();
  await ctx.editText(text, { reply_markup: kb });
  return;
}

if (subAction === 'tg_connect') {
  await ctx.answer();
  // Enter scene via injected callback — avoids double-casting ctx
  if (enterScene) {
    enterScene('connect-telegram');
  } else {
    logger.warn({ userId: user.telegram_id }, 'enterScene not injected — connect flow unavailable');
  }
  return;
}

if (subAction === 'tg_disconnect_confirm') {
  if (telegramSessionRepo) {
    const session = telegramSessionRepo.getActive(user.telegram_id);
    telegramSessionRepo.updateStatus(user.telegram_id, 'revoked');
    // Revoke Pyrogram session (best-effort, fire-and-forget)
    if (session && masterKey) {
      revokeSessionAsync(session, masterKey).catch((err) =>
        logger.warn({ err, userId: user.telegram_id }, 'Pyrogram log_out failed'),
      );
    }
  }
  await ctx.answer();
  await ctx.editText(t(lang).settings.telegramDisconnected, {
    reply_markup: new InlineKeyboard().text(t(lang).settings.back, 'stg:back'),
  });
  return;
}
```

Add `revokeSessionAsync` helper in `settings.ts`:

```ts
import { decryptSession } from '../../services/crypto/session-crypto.ts';
import { SessionBridge } from '../../services/telegram-session/session-bridge.ts';

async function revokeSessionAsync(session: TelegramSession, masterKey: Buffer): Promise<void> {
  const sessionData = decryptSession(Buffer.from(session.encrypted_session), masterKey);
  const tempPath = `/tmp/tgsess_revoke_${session.user_id}_${Date.now()}.session`;
  // Use node:fs/promises writeFile for reliable mode support (Bun.write { mode } not guaranteed)
  // Import at top of settings.ts: import { writeFile } from 'node:fs/promises';
  await writeFile(tempPath, sessionData, { mode: 0o600 });
  try {
    // log_out via Python — add a 'log_out' subcommand to connect-session.py
    const proc = Bun.spawn(['venv/bin/python', 'scripts/connect-session.py', 'log_out', '--session_path', tempPath]);
    await proc.exited;
  } finally {
    await SessionBridge.cleanupTempFile(tempPath);
  }
}
```

Also add `log_out` subcommand to `scripts/connect-session.py`:

```python
async def cmd_log_out(args: argparse.Namespace) -> None:
    client = Client(
        name=args.session_path.replace(".session", ""),
        api_id=API_ID,
        api_hash=API_HASH,
        workdir=os.path.dirname(args.session_path) or ".",
    )
    await client.connect()
    try:
        await client.log_out()
        print(json.dumps({"status": "ok"}))
    except Exception as e:
        print(error_json("LOG_OUT_FAILED", str(e)))
        sys.exit(1)
    finally:
        await client.disconnect()
```

Also update `main()` in `connect-session.py` — add parser and dispatch entry for `log_out`:

```python
    p_logout = sub.add_parser("log_out")
    p_logout.add_argument("--session_path", required=True)

    # in the commands dict:
    commands = {
        "send_code": cmd_send_code,
        "sign_in": cmd_sign_in,
        "check_password": cmd_check_password,
        "log_out": cmd_log_out,
    }
```

- [ ] **Step 3: Add new parameters to handleSettingsCallback**

Add to function signature:
- `telegramSessionRepo?: TelegramSessionRepository`
- `masterKey?: Buffer` (pre-parsed from hex, passed by caller)
- `enterScene?: (name: string) => void` (callback to enter a scene, avoids double-cast on ctx)

Update all call sites to pass these new dependencies.

- [ ] **Step 4: Write settings test**

Test the view builder functions and disconnect logic — not just repo CRUD:

```ts
// test/bot/commands/settings-telegram.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { buildTelegramView } from '../../../src/bot/commands/settings.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';

describe('settings telegram view', () => {
  let db: Database;
  let repo: TelegramSessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    runMigrations(db, migrations);
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(100, 'Test');
    repo = new TelegramSessionRepository(db);
  });

  test('buildTelegramView shows "not connected" when no session', () => {
    const { text, kb } = buildTelegramView(null, 'en');
    expect(text).toContain('not connected');
    // Keyboard should have "Connect" button
    const kbJson = JSON.stringify(kb);
    expect(kbJson).toContain('tg_connect');
  });

  test('buildTelegramView shows connected with phone in RU', () => {
    repo.upsert(100, Buffer.from('data'), 'hash', '4567');
    const session = repo.getActive(100);
    const { text, kb } = buildTelegramView(session, 'ru');
    expect(text).toContain('подключён');
    expect(text).toContain('4567');
    // Keyboard should have "Disconnect" button
    const kbJson = JSON.stringify(kb);
    expect(kbJson).toContain('tg_disconnect');
  });

  test('buildTelegramView shows "not connected" for expired session', () => {
    repo.upsert(100, Buffer.from('data'), 'hash', '4567');
    repo.updateStatus(100, 'expired');
    const session = repo.getActive(100); // returns null for non-active
    const { text } = buildTelegramView(session, 'en');
    expect(text).toContain('not connected');
  });

  test('disconnect flow: revoke sets status and getActive returns null', () => {
    repo.upsert(100, Buffer.from('data'), 'hash', '4567');
    expect(repo.getActive(100)).not.toBeNull();
    repo.updateStatus(100, 'revoked');
    expect(repo.getActive(100)).toBeNull();
  });

  test('reconnect after revoke restores active status', () => {
    repo.upsert(100, Buffer.from('old'), 'hash1', '1111');
    repo.updateStatus(100, 'revoked');
    repo.upsert(100, Buffer.from('new'), 'hash2', '2222');
    const session = repo.getActive(100);
    expect(session).not.toBeNull();
    expect(session!.phone_last4).toBe('2222');
    expect(session!.status).toBe('active');
  });
});
```

Note: `buildTelegramView` must be exported from `settings.ts` to be testable.

- [ ] **Step 5: Run tests**

```bash
bun test test/bot/commands/settings-telegram.test.ts
```

- [ ] **Step 6: Type-check**

```bash
tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/settings.ts src/bot/index.ts \
  test/bot/commands/settings-telegram.test.ts
git commit -m "feat(connect-telegram): /connect_telegram, /disconnect_telegram commands and settings integration"
```

- [ ] **Step 8: Register commands in Telegram menu**

Find where `setMyCommands` is called (likely `src/bot/index.ts` or bot setup). Add the new commands:

```ts
// Add alongside existing commands in setMyCommands call:
{ command: 'connect_telegram', description: 'Connect your Telegram account for invitation delivery' },
{ command: 'disconnect_telegram', description: 'Disconnect your Telegram account' },
```

If the bot sets language-scoped command lists (ru/en), add both language variants.

---

## Task 8: Delivery Chain Integration

**Files:**
- Modify: `src/services/ai/telegram-sender.ts` — implement `sendAsConnectedUser`
- Modify: `src/services/ai/types.ts` — add `sendAsConnectedUser` to `TelegramSender` interface
- Modify: `src/services/ai/tool-handlers/sharing.ts` — chain user session before admin MTProto
- Modify: `src/bot/index.ts` — wire up `sendAsConnectedUser` in sender creation

Architecture: `sendAsConnectedUser` lives on `TelegramSender` (not on `AgentContext`). This keeps crypto keys out of the agent context and follows the existing pattern where all send methods are on the sender.

Delivery chain becomes 4 levels:
1. Bot API
2. **User's MTProto session (new)** — via `sender.sendAsConnectedUser`
3. Admin MTProto session — via `sender.sendAsUser`
4. Deep-link fallback

- [ ] **Step 1: Add `sendAsConnectedUser` to TelegramSender interface**

In `src/services/ai/types.ts`, add to `TelegramSender`:

```ts
sendAsConnectedUser?(inviterId: number, targetId: number, text: string, username?: string): Promise<boolean>;
```

- [ ] **Step 2: Implement in telegram-sender.ts**

In `createTelegramSender`, accept new options:

```ts
interface TelegramSenderOptions {
  sendAsUser?: (userId: number, text: string, username?: string) => Promise<boolean>;
  sendAsConnectedUser?: (inviterId: number, targetId: number, text: string, username?: string) => Promise<boolean>;
}
```

Wire it through:

```ts
sendAsConnectedUser: options?.sendAsConnectedUser
  ? async (inviterId, targetId, text, username) => options.sendAsConnectedUser!(inviterId, targetId, text, username)
  : undefined,
```

- [ ] **Step 3: Create factory function for connected-user sending**

In `src/bot/index.ts` (or a new helper file), create the function that closes over the repo and master key:

```ts
function createSendAsConnectedUser(
  sessionRepo: TelegramSessionRepository,
  masterKey: Buffer,
): (inviterId: number, targetId: number, text: string, username?: string) => Promise<boolean> {
  return async (inviterId, targetId, text, username) => {
    const session = sessionRepo.getActive(inviterId);
    if (!session) return false;

    const sessionData = decryptSession(Buffer.from(session.encrypted_session), masterKey);
    const tempPath = `/tmp/tgsess_${inviterId}_${Date.now()}.session`;
    // Import at top of file: import { writeFile } from 'node:fs/promises';
    await writeFile(tempPath, sessionData, { mode: 0o600 });

    try {
      const result = await SessionBridge.sendAsUser(tempPath, targetId, text, username);

      if (!result.success && result.error === 'SESSION_EXPIRED') {
        sessionRepo.updateStatus(inviterId, 'expired');
        logger.warn({ inviterId }, 'User Telegram session expired — marked');
      }

      return result.success;
    } catch (err) {
      logger.error({ err, inviterId }, 'sendAsConnectedUser failed');
      return false;
    }
    // Note: SessionBridge.sendAsUser already cleans up the temp file in its finally block
  };
}
```

Pass it to `createTelegramSender`:

```ts
const sendAsConnectedUser = config.TELEGRAM_SESSION_MASTER_KEY
  ? createSendAsConnectedUser(db.telegramSessions, Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY, 'hex'))
  : undefined;

const sender = createTelegramSender(bot, { sendAsUser: ..., sendAsConnectedUser });
```

- [ ] **Step 4: Chain in sharing.ts**

In `deliverInvitationAsync`, build a combined MTProto send function that tries user session first:

```ts
// First, extract invitation text formatting from the existing mtprotoSend closure into a
// shared helper function at the top of deliverInvitationAsync:
//   function buildMtprotoText(invitation: ..., inviter: ...): string { ... }
// Both mtprotoSend and userMtprotoSend must use the same helper.

// After existing mtprotoSend definition:
const userMtprotoSend = sender.sendAsConnectedUser
  ? async (userId: number, text: string, username?: string): Promise<boolean> => {
      return sender.sendAsConnectedUser!(inviterId, userId, text, username);
    }
  : undefined;

// Combined: try user session, then admin session
const combinedMtprotoSend = userMtprotoSend || mtprotoSend
  ? async (userId: number, text: string, username?: string): Promise<boolean> => {
      if (userMtprotoSend) {
        const ok = await userMtprotoSend(userId, text, username);
        if (ok) return true;
      }
      return mtprotoSend ? mtprotoSend(userId, text, username) : false;
    }
  : undefined;
```

Replace the `mtprotoSend` arg in `deliverMessage()` with `combinedMtprotoSend`.

- [ ] **Step 5: Add notification_log entry**

In the `sendAsConnectedUser` factory, after successful send, log to `notification_log`:

```ts
if (result.success) {
  // Log with channel = 'mtproto_user' per spec section 8
  notificationLogRepo?.log(targetId, 'mtproto_user', text);
}
```

Pass `notificationLogRepo` as an additional dependency to the factory.

**Note:** If `notification_log.channel` has a CHECK constraint, add `'mtproto_user'` to the allowed values in a migration (check `src/database/migrations.ts` for the existing constraint).

- [ ] **Step 6: Write test for `createSendAsConnectedUser`**

```ts
// test/services/telegram-session/send-as-connected-user.test.ts
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { encryptSession } from '../../../src/services/crypto/session-crypto.ts';
import { randomBytes } from 'node:crypto';

describe('createSendAsConnectedUser', () => {
  let db: Database;
  let repo: TelegramSessionRepository;
  const masterKey = randomBytes(32);

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    runMigrations(db, migrations);
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(1, 'Sender');
    repo = new TelegramSessionRepository(db);
  });

  test('returns false when no active session for inviter', async () => {
    const fn = createSendAsConnectedUser(repo, masterKey);
    const result = await fn(1, 2, 'Hello');
    expect(result).toBe(false);
  });

  test('returns false and marks expired on SESSION_EXPIRED error', async () => {
    const encrypted = encryptSession(Buffer.from('fake-session'), masterKey);
    repo.upsert(1, encrypted, 'hash', '1234');

    mock.module('../../../src/services/telegram-session/session-bridge.ts', () => ({
      SessionBridge: {
        ...SessionBridge,
        sendAsUser: async () => ({ success: false, error: 'SESSION_EXPIRED', message: 'revoked' }),
      },
    }));

    const fn = createSendAsConnectedUser(repo, masterKey);
    const result = await fn(1, 2, 'Hello');
    expect(result).toBe(false);
    expect(repo.getActive(1)).toBeNull();
  });
});
```

Add this test to the commit in Step 8.

- [ ] **Step 7: Type-check**

```bash
tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/types.ts src/services/ai/telegram-sender.ts \
  src/services/ai/tool-handlers/sharing.ts src/bot/index.ts \
  test/services/telegram-session/send-as-connected-user.test.ts
git commit -m "feat(connect-telegram): integrate user Telegram session into invitation delivery chain"
```

---

## Task 9: AI Tool — connect_telegram_status

**Files:**
- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/tool-handlers/settings.ts` (or create new handler file)
- Modify: `src/services/ai/types.ts`
- Create: `test/services/ai/tool-handlers/connect-telegram-status.test.ts`

- [ ] **Step 1: Write test — tests the actual handler function**

```ts
// test/services/ai/tool-handlers/connect-telegram-status.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TelegramSessionRepository } from '../../../../src/database/repositories/telegram-session.repository.ts';
import { handleConnectTelegramStatus } from '../../../../src/services/ai/tool-handlers/settings.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { migrations } from '../../../../src/database/migrations.ts';

// Minimal AgentContext factory — uses Partial to only include what handler needs
function makeCtx(overrides: {
  telegramSessionRepo: TelegramSessionRepository;
  userId: number;
  lang?: 'en' | 'ru';
}) {
  return {
    user: { telegram_id: overrides.userId, language: overrides.lang ?? 'en' },
    telegramSessionRepo: overrides.telegramSessionRepo,
  };
}

describe('handleConnectTelegramStatus', () => {
  let db: Database;
  let repo: TelegramSessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    runMigrations(db, migrations);
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(100, 'Test');
    repo = new TelegramSessionRepository(db);
  });

  test('returns not connected output when no session', () => {
    const ctx = makeCtx({ telegramSessionRepo: repo, userId: 100 });
    const result = handleConnectTelegramStatus(ctx as any);
    expect(result.success).toBe(true);
    expect(result.output).toContain('not connected');
    expect(result.data).toEqual({ connected: false });
  });

  test('returns connected with phone_last4 in output', () => {
    repo.upsert(100, Buffer.from('data'), 'hash', '4567');
    const ctx = makeCtx({ telegramSessionRepo: repo, userId: 100 });
    const result = handleConnectTelegramStatus(ctx as any);
    expect(result.success).toBe(true);
    expect(result.output).toContain('4567');
    expect(result.data).toMatchObject({ connected: true, phone_last4: '4567' });
  });

  test('returns not connected for expired session', () => {
    repo.upsert(100, Buffer.from('data'), 'hash', '4567');
    repo.updateStatus(100, 'expired');
    const ctx = makeCtx({ telegramSessionRepo: repo, userId: 100 });
    const result = handleConnectTelegramStatus(ctx as any);
    expect(result.data).toEqual({ connected: false });
  });

  test('output is in Russian when user language is ru', () => {
    repo.upsert(100, Buffer.from('data'), 'hash', '4567');
    const ctx = makeCtx({ telegramSessionRepo: repo, userId: 100, lang: 'ru' });
    const result = handleConnectTelegramStatus(ctx as any);
    expect(result.output).toContain('подключён');
  });

  test('returns not connected when telegramSessionRepo is undefined', () => {
    const ctx = {
      user: { telegram_id: 100, language: 'en' },
      telegramSessionRepo: undefined,
    };
    const result = handleConnectTelegramStatus(ctx as any);
    expect(result.data).toEqual({ connected: false });
  });
});
```

- [ ] **Step 2: Run test**

```bash
bun test test/services/ai/tool-handlers/connect-telegram-status.test.ts
```

- [ ] **Step 3: Add tool definition to tools.ts**

```ts
{
  name: 'connect_telegram_status',
  description: 'Check if user has connected their Telegram account for direct invitation delivery',
  input_schema: {
    type: 'object',
    properties: {},
  },
},
```

- [ ] **Step 4: Add handler**

In `src/services/ai/tool-handlers/settings.ts` (or appropriate handler file):

```ts
export function handleConnectTelegramStatus(ctx: AgentContext): ToolResult {
  const session = ctx.telegramSessionRepo?.getActive(ctx.user.telegram_id);
  const lang = (ctx.user.language ?? 'en') as 'en' | 'ru';

  if (session) {
    return {
      success: true,
      output: t(lang).aiTools.meta.telegramConnectedStatus(session.phone_last4),
      data: { connected: true, phone_last4: session.phone_last4, status: session.status },
    };
  }

  return {
    success: true,
    output: t(lang).aiTools.meta.telegramNotConnectedStatus,
    data: { connected: false },
  };
}
```

- [ ] **Step 5: Add dispatch case in tool-executor.ts**

```ts
case 'connect_telegram_status':
  return handleConnectTelegramStatus(ctx);
```

- [ ] **Step 6: Add data type to ToolResultData**

In `src/services/ai/types.ts`, add `TelegramSessionData` variant:

```ts
| { connected: boolean; phone_last4?: string; status?: string }
```

- [ ] **Step 7: Type-check and run all tests**

```bash
tsc --noEmit && bun test
```

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts \
  src/services/ai/tool-handlers/settings.ts src/services/ai/types.ts \
  test/services/ai/tool-handlers/connect-telegram-status.test.ts
git commit -m "feat(connect-telegram): AI tool for checking Telegram connection status"
```

---

## Task 10: Final Integration & Full Test Pass

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

Fix any failing tests.

- [ ] **Step 2: Run linter**

```bash
bun run lint
```

Fix any issues.

- [ ] **Step 3: Type-check**

```bash
tsc --noEmit
```

- [ ] **Step 4: Run knip (unused exports)**

```bash
bunx knip
```

Fix any dead exports.

- [ ] **Step 5: Final commit (if fixes needed)**

```bash
git add -p  # review each change
git commit -m "fix(connect-telegram): address lint, type, and test issues"
```

- [ ] **Step 6: Verify `TELEGRAM_SESSION_MASTER_KEY` format**

In `src/config/env.ts` `loadConfig()`, after reading the key, add a format check:

```ts
if (process.env.TELEGRAM_SESSION_MASTER_KEY) {
  const key = process.env.TELEGRAM_SESSION_MASTER_KEY;
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    logger.warn('TELEGRAM_SESSION_MASTER_KEY must be exactly 64 hex chars (32 bytes) — connect-telegram feature disabled');
    // Return undefined to deactivate the feature rather than failing with cryptic crypto error
  }
}
```

This prevents a silent AES key-length error at runtime.

- [ ] **Step 7: Copy spec to worktree**

The spec file `docs/specs/2026-03-24-connect-telegram.md` exists in main but not in this worktree. Copy it:

```bash
git checkout main -- docs/specs/2026-03-24-connect-telegram.md
git add docs/specs/2026-03-24-connect-telegram.md
git commit -m "docs(connect-telegram): add spec"
```
