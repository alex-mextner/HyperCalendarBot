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

- **Fail-fast startup check:** on every bot start, if `TELEGRAM_SESSION_MASTER_KEY` is set and the
  DB has at least one `active` session, the bot decrypts the most recently updated session. If
  decryption fails (wrong key, rotated key, truncated env var), the bot logs a `fatal` and calls
  `process.exit(1)`. This prevents an accidental key swap from silently bricking every stored
  session while the bot keeps serving other traffic. No sessions in the DB → check passes trivially.
- **Key rotation (intentional):** re-encrypt all sessions with the new key via a one-shot script
  that (a) loads the OLD key from `.env.backup`, (b) loads the NEW key from `.env`, (c) for each row
  decrypts with OLD + encrypts with NEW inside a transaction. Script lives at
  `scripts/rotate-session-master-key.ts`. This is manual, not part of the CI deploy pipeline.
- **Compromise response:** rotate key + revoke all Pyrogram sessions (`client.log_out()` for each
  stored session), then ask users to re-connect. The AI agent can drive this via a broadcast command
  once the `connect_telegram_status` tool exists.

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
  encrypted_phone  BLOB NOT NULL,                 -- AES-256-GCM encrypted phone in E.164 format (e.g. "+79001234567")
  phone_hash       TEXT NOT NULL,                 -- SHA-256 of phone (for uniqueness / soft takeover on reconnect)
  status           TEXT NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'revoked'
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);
CREATE INDEX idx_tg_sessions_phone_hash ON user_telegram_sessions(phone_hash);
```

**No plain-text phone numbers stored.** The phone number is encrypted with the same master key as
the session blob. For display (`+7 ••• 4567`), the phone is decrypted in-memory, the country code is
extracted via `libphonenumber-js`, and the middle digits are masked. `phone_hash` exists only for
uniqueness — it lets a reconnect with the same phone perform a soft takeover (previous row deleted,
new row inserted in the same SQLite transaction).

**Migration number:** next available sequential migration (054 as of the plan's authoring date —
check `src/database/migrations.ts` for the latest and append).

---

## 3. Auth Flow (GramIO Scene)

### Scene: `connect-telegram`

**Step 1: Consent**
```
🔐 Подключение Telegram-аккаунта

Это позволит боту отправлять приглашения на встречи от твоего имени
людям, которые ещё не пользуются ботом.

🔒 Безопасность:
• Данные сессии зашифрованы AES-256-GCM
• Ключ шифрования живёт только в памяти процесса бота — на диске рядом с данными его нет
• Бот хранит только техническую сессию — без паролей и сообщений

Бот НЕ будет:
• Читать твои сообщения
• Отправлять сообщения без твоей команды
• Получать доступ к твоим контактам

Бот БУДЕТ:
• Отправлять приглашения на встречи от твоего имени

Отключить можно в любой момент в /settings.

[Подключить] [Отмена]
```

> Note: the §13 timezone detection bullet is added back to the consent screen in the Task 13
> rollout. Users who connected before §13 shipped must re-consent via a one-time confirmation
> prompt before the first `account.getAuthorizations()` call — tracked via
> `user_telegram_sessions.tz_detection_consent_at`.

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
✅ Telegram-аккаунт подключён (+7 ••• 4567)

Теперь приглашения на встречи будут отправляться от твоего имени.
Отключить: /disconnect_telegram
```

The masked display (`+7 ••• 4567`) is computed at render time by decrypting the stored
`encrypted_phone`, extracting the country calling code via `libphonenumber-js`, and dotting out the
middle digits. No masked fragment of the phone is ever persisted.

Session file → encrypt → store in DB → delete session file.

### Error Handling

| Error | Response |
|-------|----------|
| `PhoneNumberInvalid` | "Неверный формат. Используй международный формат: +79001234567" + inline "Отменить авторизацию" |
| `PhoneCodeInvalid` | "Неверный код. Введи 5 цифр через пробелы или дефисы…" + inline "Отменить авторизацию" (3 attempts max) |
| `PhoneCodeExpired` | "Код истёк. Начни заново: /connect_telegram" |
| `SessionPasswordNeeded` | Go to Step 4 |
| `PasswordHashInvalid` | "Неверный пароль. Попробуй ещё раз." + inline "Отменить авторизацию" (3 attempts max) |
| `FloodWait` | "Telegram ограничил запросы. Попробуй через {n} минут." |

### Cancel-authorization Inline Button

Every retryable prompt (`invalidPhone`, `invalidCode`, `invalid2fa`) and the initial
prompts that have no reply keyboard (`enter2fa`) carry an inline `ct:cancel_auth` button.
The phone-input step also posts a separate short inline message right after `enterPhone`,
because `request_contact` uses a reply keyboard that cannot coexist with inline buttons.

When the user taps the button:

1. Acknowledge the callback and clean up the temp session file if present.
2. If the user's last input at the OTP/phone step was **natural-language text** (non-OTP-shaped
   / non-phone-shaped), the bot replies "Авторизация отменена. Отвечаю…" and hands the
   original message off to the AI agent — the conversation continues where it was.
3. Otherwise the bot replies with the plain "Авторизация отменена." and exits.

`pendingForwardText` (scene state) tracks the last natural-language input and is explicitly
cleared when:
- user enters a valid-shape code (to avoid leaking stale input into 2FA cancel),
- 2FA prompt is shown,
- OTP code is digits-only but rejected by Telegram.

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

# Step 3: Enter 2FA password (if needed) — password read from stdin, NOT CLI arg
echo "hunter2" | venv/bin/python scripts/connect-session.py check_password \
  --session_path /tmp/tgsess_42_xyz.session
# stdout: {"status": "ok"}

# Step 4 (disconnect flow): revoke the stored session on Telegram's side
venv/bin/python scripts/connect-session.py log_out \
  --session_path /tmp/tgsess_42_xyz.session
# stdout: {"status": "ok"}
```

- Each subcommand creates a new Pyrogram Client, performs one operation, disconnects
- Session path is a temp file managed by the TypeScript side, created atomically with
  `open(O_CREAT|O_EXCL|O_WRONLY, 0o600)` to protect against symlink races on shared hosts
- **2FA password is read from stdin, never passed as a CLI argument** — CLI args are visible in
  `ps auxe` and `/proc/<pid>/cmdline` to any local user
- `MTPROTO_API_ID` and `MTPROTO_API_HASH` from env (same as existing scripts)
- Client `name` is computed via `pathlib.Path(session_path).with_suffix('').name` so dots anywhere
  in the path do not break the split

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
✅ Telegram-аккаунт подключён (+7 ••• 4567)
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
📱 Telegram-аккаунт: подключён (+7 ••• 4567) [Отключить]
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

Returns: `{ connected: false } | { connected: true, phone_masked: string, status: string }` —
`phone_masked` is the `+7 ••• 4567` format computed from `encrypted_phone`. No `phone_last4` field
is exposed (it was in an earlier draft that stored `phone_last4` as a plain column).

Used by AI agent to provide contextual help when the user creates an event with
participants who haven't started the bot. See Section 10.1.

### 10.1 Contextual Connect Prompt

When the AI agent creates an event that includes participants who haven't started the bot,
and the user has NOT connected their Telegram account, the agent should suggest connecting:

```
✅ Встреча создана!

📱 Кстати, ты можешь подключить свой Telegram-аккаунт, чтобы:
• Приглашения на встречи приходили от тебя, а не от бота — так люди точно ответят
• При путешествиях часовой пояс обновлялся автоматически — события всегда в правильное время

/connect_telegram
```

This prompt is triggered by the AI agent via system prompt instruction, not hardcoded.
The agent checks `connect_telegram_status` after creating an event with external participants,
and only suggests if `connected: false`.

Do NOT show this prompt if:
- The user already has a connected account
- The event has no external participants (all participants use the bot)
- The user has dismissed this suggestion before (track via user preferences)

### 10.2 Post-Connect Invitation Flow

When `/connect_telegram` completes successfully AND was triggered in the context of a
recently created event with uninvited external participants, the success message includes
an offer to send invitations now:

```
✅ Telegram-аккаунт подключён (+7 ••• 4567)

У тебя есть встреча «Обед с Леной» (15 апреля, 13:00) — Лена ещё не приглашена.
Отправить ей приглашение от твоего имени?
[Отправить] [Не сейчас]
```

Implementation: the connect-telegram scene receives optional context (`pendingEventId`,
`pendingInviteeIds`) passed when entering the scene from the AI agent's suggestion.
On success (Step 5), if context is present, show the invitation offer instead of the
generic success message.

If multiple events have uninvited participants, show only the most recent one.
The user can always invite manually later.

---

## 11. Invitation Message Format

### From User's Account (MTProto)

When an invitation is sent via the user's own Telegram session, the message must feel
like it was written by the person, not generated by a bot:

**Format (RU):**
```
Приглашаю тебя на «{title}»
📅 {date}, {time}
{location_line}
{description_line}

Подробнее и ответить: {bot_deep_link}
```

**Format (EN):**
```
Inviting you to "{title}"
📅 {date}, {time}
{location_line}
{description_line}

Details & RSVP: {bot_deep_link}
```

Rules:
- **No greeting** (no "Привет!", "Здравствуйте", "Hi!") — impossible to guess the right
  tone for every relationship, and asking the user adds friction
- **No bot signature** — the message comes from the user's account, adding "sent via bot"
  undermines the trust benefit
- **First person** — "Приглашаю тебя", not "Вы приглашены" or "User X invites you"
- `{location_line}` — `📍 {location}` if present, omitted otherwise
- `{description_line}` — first 100 chars of description if present, omitted otherwise
- `{bot_deep_link}` — `https://t.me/{bot_username}?start=invite_{invitationId}` for
  accepting/declining via the bot

### From Bot Account (existing behavior, unchanged)

When sent via Bot API or admin MTProto session, the current format is used — third person,
bot-style messaging. No changes needed.

### From Admin MTProto Session (fallback)

Same format as bot account — third person. The message comes from an unknown account,
so first-person "Приглашаю" would be confusing.

---

## 12. Edge Cases

| Case | Behavior |
|------|----------|
| User changes Telegram password | Session expires, bot detects at next send, notifies user |
| User logs out from all sessions | Same as above — `AuthKeyUnregistered` |
| Multiple users connect same phone | Soft takeover: the old row is deleted inside the same SQLite transaction that inserts the new one (same human, different bot account is legitimate) |
| Master key rotated (intentional) | Run `scripts/rotate-session-master-key.ts` manually with OLD + NEW keys |
| Master key rotated (accidental) | Startup fail-fast check (§1.2) exits the process before traffic is served |
| Master key missing at startup | Feature disabled, existing sessions remain in DB but are inaccessible until the key returns |
| Pyrogram session file corrupted | Decrypt succeeds but send fails → mark expired |
| User deletes account | Bot API delivery of regular messages also fails → user cleanup cascade |
| Connect cooldown | 60-second in-memory cooldown on scene re-entry to avoid FloodWait from repeated send_code |
| Symlink race on /tmp | Temp session file created with `O_CREAT|O_EXCL|O_WRONLY`, 0o600 — fails closed if path exists |
| Connect triggered after event creation | Scene receives `pendingEventId` + `pendingInviteeIds`, offers to invite on success |
| User dismisses connect prompt | Track in `users.connect_telegram_dismissed_at`, don't show again for 30 days |

---

## 13. Automatic Timezone Detection

### Overview

When a user connects their Telegram account, the bot can passively detect timezone
changes via `account.getAuthorizations()` — an MTProto method that returns all active
sessions of the authenticated user.

Each `Authorization` object contains:
- `ip` — **last known IP** (updated on each session activity, not static from creation)
- `country` — country derived from current IP via GeoIP
- `region` — region derived from current IP
- `date_active` — Unix timestamp of last session activity

When a user travels and uses Telegram from a new network, `country` and `region`
reflect the new location. This is sufficient to detect timezone changes.

Source: [core.telegram.org/constructor/authorization](https://core.telegram.org/constructor/authorization)

### Resolution Strategy

1. Call `account.getAuthorizations()` via the user's stored Pyrogram session
2. Find the most recently active mobile session (`platform` = iOS/Android, highest `date_active`)
3. If `country` + `region` map to a different timezone than `users.timezone`:
   - Single-timezone countries (JP, KR, IN, AE, etc.) → resolve immediately
   - Multi-timezone countries (US, RU, CA, AU) → use `region` to narrow down
   - Use `geo-tz` or a country+region→IANA mapping
4. Send the user a confirmation message:
   ```
   Похоже, ты сейчас в Токио 🇯🇵
   Обновить таймзону на Asia/Tokyo?
   [Да] [Нет]
   ```
5. Never auto-update without confirmation — VPN users would get false positives

### When to Check

- **Opportunistic**: when the session is already opened for invitation delivery — one
  extra API call, no additional session overhead
- **Periodic** (optional): daily job for all connected users. Opens each session briefly,
  calls `getAuthorizations()`, closes. Consider Telegram rate limits for FloodWait.

### Privacy

This reads **session metadata only** (IP, device model, platform) — not messages, contacts,
or any content. Same data the user sees in Settings → Devices.

Add to the consent screen (Section 3, Step 1):
```
Бот БУДЕТ:
• Отправлять приглашения на встречи от твоего имени
• Определять твою таймзону по региону подключения для автоматического обновления часового пояса
```

### Limitations

- Only works for users who connected via `/connect_telegram` (subset of all users)
- VPN/proxy users will show the VPN server's country, not their real location —
  hence the confirmation prompt, never auto-update
- Exact update frequency of `ip` on Telegram's side is undocumented, but
  sufficient for daily/weekly timezone checks

---

## 14. Out of Scope

- Reading user's messages or contacts
- Sending anything other than event invitations
- Background session keep-alive (sessions are opened on-demand)
- Web UI for managing sessions
- Session sharing between bot instances
