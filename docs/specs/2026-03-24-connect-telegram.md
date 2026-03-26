# /connect_telegram — User MTProto Session Delegation

**Extends:** spec 06-sharing-social, scripts/send-message.py
**Depends on:** Pyrogram, bun:sqlite, Node.js crypto

---

## Problem

When Alice invites Bob (who hasn't started the bot) to a meeting, the invitation is delivered via
the admin's MTProto session (`voice_caller`). Bob receives a message from a random account he
doesn't know — confusing and suspicious.

**With this feature:** Bob receives a message **from Alice** — natural, trusted, higher response rate.

---

## Overview

User runs `/connect_telegram` to authorize the bot to send Telegram messages on their behalf.
The bot initiates a Pyrogram sign-in, stores the encrypted session, and uses it when the user
invites someone who hasn't started the bot.

Only invitations are sent via the user's account — reminders, agendas, and other notifications
still go through the Bot API as usual.

---

## 1. Security Architecture

### 1.1 Encryption

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Master key:** `TELEGRAM_SESSION_MASTER_KEY` env var — 32-byte hex string
  - Stored in GitHub Secrets, injected into Docker via `docker-compose.yml` `environment:`
  - **Never written to a file on the server** — lives only in container process memory
  - If absent: feature is disabled, `/connect_telegram` replies "feature unavailable"
- **Per-session IV:** 12-byte random, stored alongside ciphertext
- **Auth tag:** 16-byte, appended to ciphertext (standard GCM output)

```
Stored blob = IV (12 bytes) || ciphertext || auth_tag (16 bytes)
```

### 1.2 Key Management

- Master key rotation: re-encrypt all sessions with new key. Migration script provided.
- If master key is compromised: rotate key + revoke all Pyrogram sessions
  (call `client.log_out()` for each stored session).

### 1.3 Session Lifecycle

| State | Description |
|-------|-------------|
| `active` | Session works, ready for use |
| `expired` | Telegram terminated the session (password change, manual logout) |
| `revoked` | User ran `/disconnect_telegram` |

Expired sessions are detected at send time (Pyrogram raises `SessionRevoked` or `AuthKeyUnregistered`).
On detection: mark `expired`, notify user, suggest re-connecting.

### 1.4 Temp File Handling

Pyrogram sessions are SQLite files — can't be piped via stdin. On each send:

1. Decrypt session blob from DB
2. Write to temp file: `/tmp/tgsess_{userId}_{random}.session` with `0600` permissions
3. Spawn Python script with temp session path
4. Delete temp file in `finally` block (even on error)

---

## 2. Database

### user_telegram_sessions

```sql
CREATE TABLE user_telegram_sessions (
  user_id          INTEGER PRIMARY KEY,           -- FK → users.telegram_id
  encrypted_session BLOB NOT NULL,                -- AES-256-GCM encrypted Pyrogram session
  phone_hash       TEXT NOT NULL,                 -- SHA-256 of phone number (for display: "connected as +7***89")
  phone_last4      TEXT NOT NULL,                 -- last 4 digits for UI display
  status           TEXT NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'revoked'
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
```

**No plain-text phone numbers stored.** Only hash (for dedup) and last 4 digits (for display).

---

## 3. Auth Flow (GramIO Scene)

### Scene: `connect-telegram`

**Step 1: Consent**
```
🔐 Подключение Telegram-аккаунта

Это позволит боту отправлять приглашения на встречи от твоего имени
людям, которые ещё не пользуются ботом.

🔒 Безопасность:
• Данные сессии зашифрованы AES-256-GCM (военный стандарт шифрования)
• Бот хранит только техническую сессию — без номера телефона, паролей и сообщений
• Ключ шифрования хранится отдельно от данных и никогда не записывается на диск

Бот НЕ будет:
• Читать твои сообщения
• Отправлять сообщения без твоей команды
• Получать доступ к твоим контактам

Бот БУДЕТ:
• Отправлять приглашения на встречи от твоего имени

Отключить можно в любой момент в /settings.

[Подключить] [Отмена]
```

**Step 2: Phone number**
```
Введи номер телефона в международном формате:
Например: +79001234567
```

Validation: `^\+\d{7,15}$`

**Step 3: OTP code**
Bot calls `client.send_code(phone)` via Python bridge script.
```
Код подтверждения отправлен в Telegram.
Введи код (5 цифр):
```

Timeout: 5 minutes. After 3 failed attempts: abort.

**Step 4: 2FA password (conditional)**
If Telegram returns `SessionPasswordNeeded`:
```
У тебя включена двухфакторная аутентификация.
Введи пароль (он не будет сохранён):
```

Password is used once for `client.check_password()`, then discarded. Not stored anywhere.

**Step 5: Success**
```
✅ Telegram-аккаунт подключён (+7***4567)

Теперь приглашения на встречи будут отправляться от твоего имени.
Отключить: /disconnect_telegram
```

Session file → encrypt → store in DB → delete session file.

### Error Handling

| Error | Response |
|-------|----------|
| `PhoneNumberInvalid` | "Неверный номер. Попробуй ещё раз." |
| `PhoneCodeInvalid` | "Неверный код. Попробуй ещё раз." (3 attempts max) |
| `PhoneCodeExpired` | "Код истёк. Начни заново: /connect_telegram" |
| `SessionPasswordNeeded` | Go to Step 4 |
| `PasswordHashInvalid` | "Неверный пароль. Попробуй ещё раз." (3 attempts max) |
| `FloodWait` | "Telegram ограничил запросы. Попробуй через {n} минут." |

---

## 4. Python Bridge Script

### `scripts/connect-session.py`

Three subcommands:

```bash
# Step 1: Send code (session_path required — Pyrogram binds auth key to client session file)
venv/bin/python scripts/connect-session.py send_code --phone +79001234567 --session_path /tmp/tgsess_42_xyz.session
# stdout: {"phone_code_hash": "abc123"}
# stderr: ERROR:... on failure

# Step 2: Sign in with code
venv/bin/python scripts/connect-session.py sign_in \
  --phone +79001234567 \
  --code 12345 \
  --phone_code_hash abc123 \
  --session_path /tmp/tgsess_42_xyz.session
# stdout: {"status": "ok"} or {"status": "2fa_required"}

# Step 3: Enter 2FA password (if needed)
venv/bin/python scripts/connect-session.py check_password \
  --password "hunter2" \
  --session_path /tmp/tgsess_42_xyz.session
# stdout: {"status": "ok"}
```

- Each subcommand creates a new Pyrogram Client, performs one operation, disconnects
- Session path is a temp file managed by the TypeScript side
- `MTPROTO_API_ID` and `MTPROTO_API_HASH` from env (same as existing scripts)

### `scripts/send-as-user.py`

New script (or extend `send-message.py` with `--session` flag):

```bash
venv/bin/python scripts/send-as-user.py \
  --session_path /tmp/tgsess_42_xyz.session \
  --user_id 5153477378 \
  --text "📅 Alice приглашает тебя..."
  [--username bob_handle]
```

Same retry/fallback logic as `send-message.py`, but uses the user's session instead of `voice_caller`.

---

## 5. Encryption Service

### `src/services/crypto/session-crypto.ts`

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encryptSession(sessionData: Buffer, masterKey: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(sessionData), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]);
}

export function decryptSession(blob: Buffer, masterKey: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

### Master Key Loading

In `src/config/env.ts`:

```ts
TELEGRAM_SESSION_MASTER_KEY?: string; // 64 hex chars = 32 bytes, optional
```

At the point of use (not at startup — graceful degradation):

```ts
function getMasterKey(config: EnvConfig): Buffer | null {
  if (!config.TELEGRAM_SESSION_MASTER_KEY) return null;
  return Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY, 'hex');
}
```

---

## 6. Integration with Invitation Delivery

### Modified Delivery Chain

Current: Bot API → Admin MTProto → Deep-link fallback

New:

```
1. Bot API (sendMessage to invitee)
   ↓ fails (user hasn't started bot)
2. User's own MTProto session (if connected)
   ↓ fails or not connected
3. Admin MTProto session (voice_caller, existing fallback)
   ↓ fails
4. Deep-link fallback (send link to inviter)
```

### Changes to `deliverInvitationAsync()`

```ts
// After bot API fails:
const userSession = sessionRepo.getActive(inviterId);
if (userSession && masterKey) {
  const sent = await sendViaUserSession(userSession, inviteeId, text, inviteeUsername);
  if (sent) return; // delivered from user's own account
}
// Fall through to admin MTProto...
```

---

## 7. Commands

### `/connect_telegram`
Starts the connection scene. If already connected:
```
✅ Telegram-аккаунт подключён (+7***4567)
Переподключить? [Да] [Нет]
```

### `/disconnect_telegram`
```
Отключить Telegram-аккаунт? Приглашения будут отправляться через бота.
[Отключить] [Отмена]
```

On confirm: set `status = 'revoked'`, call `client.log_out()` via Python script.

### Settings integration

`/settings` menu shows Telegram connection status and allows disconnecting:

```
⚙️ Настройки
...
📱 Telegram-аккаунт: подключён (+7***4567) [Отключить]
```

If not connected:
```
📱 Telegram-аккаунт: не подключён [Подключить]
```

Callback prefix: `settings:tg_connect` / `settings:tg_disconnect`.
Disconnect via settings uses the same logic as `/disconnect_telegram` — confirm → revoke → log_out.

---

## 8. Privacy & Transparency

- **Consent**: explicit opt-in, clear description of what the bot will and won't do
- **No phone storage**: only hash + last 4 digits
- **No password storage**: 2FA password used once, never written to disk or DB
- **Session scope**: Pyrogram session allows full account access in theory, but the bot
  only ever calls `send_message()`. This trust boundary is enforced at the code level
  (Python scripts are the only consumers of the session), not cryptographically.
- **Transparency log**: every message sent via user's session is logged in `notification_log`
  with `channel = 'mtproto_user'` so the user can audit what was sent on their behalf.
- **User can always revoke**: `/disconnect_telegram` instantly stops all delegation.

---

## 9. Deployment

### GitHub Secrets

Add `TELEGRAM_SESSION_MASTER_KEY` (32-byte hex, generated via `openssl rand -hex 32`).

### docker-compose.yml

```yaml
services:
  bot:
    environment:
      - TELEGRAM_SESSION_MASTER_KEY=${TELEGRAM_SESSION_MASTER_KEY}
```

### GitHub Actions deploy step

```yaml
- name: Deploy
  env:
    TELEGRAM_SESSION_MASTER_KEY: ${{ secrets.TELEGRAM_SESSION_MASTER_KEY }}
  run: |
    ssh ... "cd $DEPLOY_PATH && TELEGRAM_SESSION_MASTER_KEY=$TELEGRAM_SESSION_MASTER_KEY docker compose up -d"
```

The key exists only as:
1. GitHub Secret (encrypted at rest by GitHub)
2. Environment variable in the running container process
3. Never in any file on disk, never in git, never in logs

---

## 10. AI Tools

### `connect_telegram_status`

Tool for AI agent to check if user has a connected session:

```ts
{
  name: 'connect_telegram_status',
  description: 'Check if user has connected their Telegram account for direct invitation delivery',
  input_schema: {},
}
```

Returns: `{ connected: boolean, phone_last4?: string, status?: string }`

Used by AI agent to provide contextual help:
- "Хочешь, чтобы приглашение пришло от тебя? Подключи аккаунт: /connect_telegram"

---

## 11. Edge Cases

| Case | Behavior |
|------|----------|
| User changes Telegram password | Session expires, bot detects at next send, notifies user |
| User logs out from all sessions | Same as above — `AuthKeyUnregistered` |
| Multiple users connect same phone | Rejected: `phone_hash` uniqueness check |
| Master key rotated | Migration script re-encrypts all sessions |
| Master key missing at startup | Feature disabled, existing sessions inaccessible |
| Pyrogram session file corrupted | Decrypt succeeds but send fails → mark expired |
| User deletes account | Bot API delivery of regular messages also fails → user cleanup cascade |

---

## 12. Out of Scope

- Reading user's messages or contacts
- Sending anything other than event invitations
- Background session keep-alive (sessions are opened on-demand)
- Web UI for managing sessions
- Session sharing between bot instances
