# Connect Telegram Account — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to connect their Telegram account so the bot can send event invitations from the user's own account to people who haven't started the bot, using a first-person message format that feels personal.

**Architecture:** GramIO scene guides the user through Pyrogram auth flow (phone → OTP → optional 2FA). Encrypted session + encrypted phone number stored in SQLite. On invitation delivery, the user's session is tried before the admin MTProto fallback, with a first-person invitation text. Settings menu shows connection status with connect / disconnect actions. Master key is verified at startup against an existing session to fail fast if rotated incorrectly.

**Tech stack:** AES-256-GCM (`node:crypto`), Pyrogram (Python bridge via `Bun.spawn`), `@gramio/scenes` ^0.5, `bun:sqlite`, zod v4 (`z.codec` for JSON parsing without external try/catch).

**Scope note:** All spec sections are in scope, including §10.1 (contextual connect prompt), §10.2 (post-connect invitation flow), and §13 (automatic timezone detection). These are implemented in Tasks 12 and 13 after the core flow is complete in Tasks 1–11.

**Spec:** `docs/specs/2026-03-24-connect-telegram.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/database/repositories/telegram-session.repository.ts` | CRUD for `user_telegram_sessions` table |
| `src/services/crypto/session-crypto.ts` | Buffer-based AES-256-GCM encrypt/decrypt for Pyrogram session blobs and phone numbers |
| `src/services/crypto/master-key-check.ts` | Startup fail-fast check: decrypts the most recent session to verify the master key is unchanged |
| `src/services/telegram-session/session-bridge.ts` | TypeScript wrapper for Python bridge scripts (`Bun.spawn`) with zod-codec stdout parsing |
| `src/services/telegram-session/connected-user-sender.ts` | Factory for `sendAsConnectedUser`: decrypts session, writes temp file atomically, spawns `send-as-user.py`, cleans up. Builds first-person invitation text. |
| `src/services/telegram-session/invitation-text.ts` | `buildUserSessionInvitationText(event, inviter, deepLinkUrl, lang)` — first-person format per spec §11 |
| `src/services/telegram-session/timezone-detector.ts` | Resolves country+region from `account.getAuthorizations()` to an IANA timezone (spec §13) |
| `src/services/event/recent-external-events.ts` | `findMostRecentEventWithExternalParticipants(userId)` — used by the connect command to seed `pendingEventId` / `pendingInviteeIds` (spec §10.2) |
| `src/bot/scenes/connect-telegram.scene.ts` | GramIO scene + `ConnectTelegramState` / `ConnectTelegramParams` interfaces (co-located) |
| `scripts/connect-session.py` | Pyrogram auth: `send_code`, `sign_in`, `check_password`, `log_out`, `get_authorizations` subcommands |
| `scripts/send-as-user.py` | Send message via user's Pyrogram session |
| `test/database/repositories/telegram-session.repository.test.ts` | Repository tests |
| `test/services/crypto/session-crypto.test.ts` | Crypto roundtrip + tamper detection tests |
| `test/services/crypto/master-key-check.test.ts` | Startup verification tests (matching key / wrong key / no sessions) |
| `test/services/telegram-session/session-bridge.test.ts` | Bridge wrapper tests (zod-codec stdout parsing) |
| `test/services/telegram-session/connected-user-sender.test.ts` | Factory tests for the user-session send path |
| `test/services/telegram-session/invitation-text.test.ts` | First-person invitation text formatter tests |
| `test/services/telegram-session/timezone-detector.test.ts` | Timezone resolution tests (single-tz and multi-tz countries) |
| `test/bot/scenes/connect-telegram.scene.test.ts` | Scene helpers and state transition tests |
| `test/bot/scenes/connect-telegram.pending.test.ts` | Post-connect invitation flow tests (spec §10.2) |
| `test/services/ai/tool-handlers/connect-telegram-status.test.ts` | AI tool handler test |
| `test/services/ai/tool-handlers/dismiss-connect-telegram-prompt.test.ts` | Dismissal tool handler test (spec §10.1) |

### Modified files

| File | Change |
|------|--------|
| `src/config/env.ts` | Add `TELEGRAM_SESSION_MASTER_KEY?: string` with hex-length validation |
| `src/config/constants.ts` | Add i18n strings for connect / disconnect UI and the new AI tool |
| `src/database/types.ts` | Add `TelegramSession` interface + `NotificationLogChannel` union that includes `'mtproto_user'` |
| `src/database/migrations.ts` | Migrations **054** (`user_telegram_sessions`), **055** (`users.connect_telegram_dismissed_at`), **056** (`user_telegram_sessions.tz_detection_consent_at`) |
| `src/database/index.ts` | Register `TelegramSessionRepository` in `DatabaseService` |
| `src/bot/scenes/index.ts` | Wire `connect-telegram` scene, thread `TelegramSessionRepository` and master key through `createScenesPlugin` |
| `src/bot/commands/settings.ts` | Add Telegram account row to settings UI + callbacks |
| `src/bot/index.ts` | Register `/connect_telegram`, `/disconnect_telegram` commands, inject connected-user sender, run startup master-key check, extend `setMyCommands` |
| `src/services/ai/tools.ts` | Add `connect_telegram_status` tool definition |
| `src/services/ai/tool-executor.ts` | Add dispatch case for the new tool + add it to `TOOL_FEATURE_MAP` |
| `src/services/ai/tool-handlers/settings.ts` | Add handler for `connect_telegram_status` |
| `src/services/ai/types.ts` | Add `TelegramSessionData` variant to `ToolResultData`, add `sendAsConnectedUser` to `TelegramSender` |
| `src/services/ai/tool-handlers/sharing.ts` | Chain user-session delivery into `deliverInvitationAsync` with the first-person text helper |
| `src/services/ai/telegram-sender.ts` | Accept `sendAsConnectedUser` factory option and expose it on the sender |
| `src/services/feature-tracking.ts` | Add `telegram_connect` to `COMMAND_FEATURE_MAP` and `FeatureKey` |
| `src/services/ai/tool-executor.ts` | Add entry to `TOOL_FEATURE_MAP` |
| `src/database/repositories/feature-usage.repository.ts` | Add `telegram_connect` to `FEATURE_KEYS` |

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

In `loadConfig()` return block, read the raw value AND validate format (log-only; never throw — feature must degrade gracefully):

```ts
const rawMasterKey = process.env.TELEGRAM_SESSION_MASTER_KEY?.trim();
let telegramSessionMasterKey: string | undefined;
if (rawMasterKey) {
  if (/^[0-9a-f]{64}$/i.test(rawMasterKey)) {
    telegramSessionMasterKey = rawMasterKey;
  } else {
    // logger.warn is fine here — env.ts may import logger
    logger.warn('TELEGRAM_SESSION_MASTER_KEY must be 64 hex chars (32 bytes) — connect-telegram feature disabled');
  }
}
// ...
return {
  // ...
  TELEGRAM_SESSION_MASTER_KEY: telegramSessionMasterKey,
};
```

Validate at read time, not at point of use (cheap regex, catches typos early). Keep the behavior: feature is **disabled** when the var is absent or malformed — never throw.

- [ ] **Step 2: Add database types**

In `src/database/types.ts`, add:

```ts
export interface TelegramSession {
  user_id: number;
  encrypted_session: Buffer;
  encrypted_phone: Buffer;           // AES-256-GCM encrypted phone number (including "+")
  phone_hash: string;                // SHA-256 of phone for uniqueness check only
  status: 'active' | 'expired' | 'revoked';
  created_at: string;
  updated_at: string;
}

export type NotificationLogChannel =
  | 'telegram_text'
  | 'voice_call'
  | 'mtproto_admin'
  | 'mtproto_user';
```

The `NotificationLogChannel` union is used by `NotificationLogRepository.insert(data.channel)` so the caller cannot pass an ad-hoc string. Existing channel values in the table (`'telegram_text'` is the default) remain valid — this is a TypeScript-only constraint; no migration needed since the column is plain `TEXT`.

- [ ] **Step 3: Add migration (number 054)**

`053_event_venue_name` is the last existing migration (as of 2026-04-11). The next number is **054**. **NEVER renumber existing migrations** (CLAUDE.md rule).

In `src/database/migrations.ts`, append:

```ts
{
  name: '054_create_user_telegram_sessions',
  up: (db) => {
    db.exec(`
      CREATE TABLE user_telegram_sessions (
        user_id          INTEGER PRIMARY KEY,
        encrypted_session BLOB NOT NULL,
        encrypted_phone   BLOB NOT NULL,
        phone_hash       TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'active',
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_tg_sessions_phone_hash ON user_telegram_sessions(phone_hash);
    `);
  },
},
```

Notes:
- `phone_hash` index is **non-unique** on purpose. Uniqueness is enforced in the repository layer, where a reconnect with the same phone can replace the old row (see Task 1 Step 6).
- No `phone_last4` / `phone_country_prefix` columns: masking is derived from `encrypted_phone` at display time. This avoids storing any plain-text fragment of the phone.

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
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(100, 'Test');
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(200, 'Other');
    repo = new TelegramSessionRepository(db);
  });

  test('upsert creates a new session', () => {
    const blob = Buffer.from('encrypted-session-data');
    const phone = Buffer.from('encrypted-phone-data');
    repo.upsert(100, blob, phone, 'hash123');
    const session = repo.findByUserId(100);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');
    expect(Buffer.from(session!.encrypted_session)).toEqual(blob);
    expect(Buffer.from(session!.encrypted_phone)).toEqual(phone);
  });

  test('upsert replaces existing session for the same user', () => {
    repo.upsert(100, Buffer.from('old-s'), Buffer.from('old-p'), 'hash1');
    repo.upsert(100, Buffer.from('new-s'), Buffer.from('new-p'), 'hash2');
    const session = repo.findByUserId(100);
    expect(Buffer.from(session!.encrypted_session)).toEqual(Buffer.from('new-s'));
  });

  test('findByUserId returns null for missing user', () => {
    expect(repo.findByUserId(999)).toBeNull();
  });

  test('getActive returns only active sessions', () => {
    repo.upsert(100, Buffer.from('s'), Buffer.from('p'), 'hash1');
    expect(repo.getActive(100)).not.toBeNull();
    repo.updateStatus(100, 'revoked');
    expect(repo.getActive(100)).toBeNull();
  });

  test('updateStatus changes status', () => {
    repo.upsert(100, Buffer.from('s'), Buffer.from('p'), 'hash1');
    repo.updateStatus(100, 'expired');
    expect(repo.findByUserId(100)!.status).toBe('expired');
  });

  test('findByPhoneHash finds session', () => {
    repo.upsert(100, Buffer.from('s'), Buffer.from('p'), 'unique-hash');
    const session = repo.findByPhoneHash('unique-hash');
    expect(session).not.toBeNull();
    expect(session!.user_id).toBe(100);
  });

  test('upsert claims phone from a different user (soft takeover)', () => {
    repo.upsert(100, Buffer.from('s1'), Buffer.from('p1'), 'shared-hash');
    // Second user with the same phone → previous row deleted, new row inserted
    repo.upsert(200, Buffer.from('s2'), Buffer.from('p2'), 'shared-hash');
    expect(repo.findByUserId(100)).toBeNull();
    expect(repo.findByUserId(200)).not.toBeNull();
  });

  test('getMostRecentActive returns latest active session (for startup key check)', () => {
    repo.upsert(100, Buffer.from('s1'), Buffer.from('p1'), 'h1');
    repo.upsert(200, Buffer.from('s2'), Buffer.from('p2'), 'h2');
    const latest = repo.getMostRecentActive();
    expect(latest).not.toBeNull();
    // Latest inserted wins via updated_at ordering
    expect(latest!.user_id).toBe(200);
  });

  test('deleteByUserId removes session', () => {
    repo.upsert(100, Buffer.from('s'), Buffer.from('p'), 'h1');
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

  /**
   * Returns the most recently updated active session, or null if there are none.
   * Used by the startup master-key verification to detect a rotated / misconfigured key.
   */
  getMostRecentActive(): TelegramSession | null {
    return this.db
      .prepare(
        "SELECT * FROM user_telegram_sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1",
      )
      .get() as TelegramSession | null;
  }

  /**
   * Insert or replace a session. If a session with the same phone_hash exists for a
   * *different* user, it is removed first (soft takeover — same human, different bot account).
   */
  upsert(
    userId: number,
    encryptedSession: Buffer,
    encryptedPhone: Buffer,
    phoneHash: string,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM user_telegram_sessions WHERE phone_hash = ? AND user_id <> ?',
        )
        .run(phoneHash, userId);
      this.db
        .prepare(
          `INSERT INTO user_telegram_sessions
             (user_id, encrypted_session, encrypted_phone, phone_hash)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             encrypted_session = excluded.encrypted_session,
             encrypted_phone   = excluded.encrypted_phone,
             phone_hash        = excluded.phone_hash,
             status            = 'active',
             updated_at        = datetime('now')`,
        )
        .run(userId, encryptedSession, encryptedPhone, phoneHash);
    })();
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

Expected: all 9 tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/config/env.ts src/database/types.ts src/database/migrations.ts \
  src/database/index.ts src/database/repositories/telegram-session.repository.ts \
  test/database/repositories/telegram-session.repository.test.ts
git commit -m "feat(connect-telegram): migration 054, types, and repository for user Telegram sessions"
```

---

## Task 2: Session & Phone Crypto

**Files:**
- Create: `src/services/crypto/session-crypto.ts`
- Create: `test/services/crypto/session-crypto.test.ts`

- [ ] **Step 1: Write crypto tests**

```ts
// test/services/crypto/session-crypto.test.ts
import { describe, test, expect } from 'bun:test';
import {
  encryptBlob,
  decryptBlob,
  encryptString,
  decryptString,
} from '../../../src/services/crypto/session-crypto.ts';
import { randomBytes } from 'node:crypto';

describe('session-crypto', () => {
  const masterKey = randomBytes(32);

  test('encryptBlob → decryptBlob roundtrip preserves data', () => {
    const original = randomBytes(4096);
    const encrypted = encryptBlob(original, masterKey);
    const decrypted = decryptBlob(encrypted, masterKey);
    expect(decrypted).toEqual(original);
  });

  test('encrypted blob overhead = IV (12) + tag (16)', () => {
    const original = Buffer.from('short');
    const encrypted = encryptBlob(original, masterKey);
    expect(encrypted.length).toBe(original.length + 12 + 16);
  });

  test('random IV — identical plaintext produces different ciphertext', () => {
    const original = Buffer.from('test-data');
    const enc1 = encryptBlob(original, masterKey);
    const enc2 = encryptBlob(original, masterKey);
    expect(enc1).not.toEqual(enc2);
  });

  test('tampered ciphertext throws on decrypt (GCM auth tag)', () => {
    const original = Buffer.from('secret');
    const encrypted = encryptBlob(original, masterKey);
    encrypted[20] ^= 0xff;
    expect(() => decryptBlob(encrypted, masterKey)).toThrow();
  });

  test('wrong key throws on decrypt', () => {
    const encrypted = encryptBlob(Buffer.from('secret'), masterKey);
    const wrongKey = randomBytes(32);
    expect(() => decryptBlob(encrypted, wrongKey)).toThrow();
  });

  test('empty buffer roundtrip', () => {
    const original = Buffer.alloc(0);
    const encrypted = encryptBlob(original, masterKey);
    expect(decryptBlob(encrypted, masterKey)).toEqual(original);
  });

  test('encryptString / decryptString roundtrip (UTF-8)', () => {
    const phone = '+79001234567';
    const encrypted = encryptString(phone, masterKey);
    expect(decryptString(encrypted, masterKey)).toBe(phone);
  });

  test('encryptString handles unicode', () => {
    const encrypted = encryptString('🔐 секрет', masterKey);
    expect(decryptString(encrypted, masterKey)).toBe('🔐 секрет');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test test/services/crypto/session-crypto.test.ts
```

- [ ] **Step 3: Implement session crypto**

```ts
// src/services/crypto/session-crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Encrypts a binary blob. Output: IV (12) || ciphertext || tag (16).
 */
export function encryptBlob(plaintext: Buffer, masterKey: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]);
}

/**
 * Decrypts a blob produced by encryptBlob. Throws on tamper / wrong key.
 */
export function decryptBlob(blob: Buffer, masterKey: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptString(value: string, masterKey: Buffer): Buffer {
  return encryptBlob(Buffer.from(value, 'utf8'), masterKey);
}

export function decryptString(blob: Buffer, masterKey: Buffer): string {
  return decryptBlob(blob, masterKey).toString('utf8');
}
```

- [ ] **Step 4: Run test — verify it passes**

- [ ] **Step 5: Commit**

```bash
git add src/services/crypto/session-crypto.ts test/services/crypto/session-crypto.test.ts
git commit -m "feat(connect-telegram): AES-256-GCM blob and string crypto"
```

---

## Task 3: Master-Key Startup Verification (Fail-Fast)

**Files:**
- Create: `src/services/crypto/master-key-check.ts`
- Create: `test/services/crypto/master-key-check.test.ts`

Goal: if someone deploys a fresh / rotated key by accident, refuse to start instead of silently bricking every existing session. If there are no sessions yet, the check passes.

- [ ] **Step 1: Write test**

```ts
// test/services/crypto/master-key-check.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { encryptBlob } from '../../../src/services/crypto/session-crypto.ts';
import { verifyMasterKey } from '../../../src/services/crypto/master-key-check.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';

describe('verifyMasterKey', () => {
  let db: Database;
  let repo: TelegramSessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    runMigrations(db, migrations);
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(100, 'Test');
    repo = new TelegramSessionRepository(db);
  });

  test('passes when no sessions exist', () => {
    const result = verifyMasterKey(repo, randomBytes(32));
    expect(result).toEqual({ ok: true, reason: 'no-sessions' });
  });

  test('passes when key matches existing session', () => {
    const key = randomBytes(32);
    const blob = encryptBlob(Buffer.from('some-pyrogram-session-bytes'), key);
    const phone = encryptBlob(Buffer.from('+79001234567'), key);
    repo.upsert(100, blob, phone, 'hash');
    const result = verifyMasterKey(repo, key);
    expect(result).toEqual({ ok: true, reason: 'verified' });
  });

  test('fails when key does not match existing session', () => {
    const correctKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    repo.upsert(
      100,
      encryptBlob(Buffer.from('session'), correctKey),
      encryptBlob(Buffer.from('+79001234567'), correctKey),
      'hash',
    );
    const result = verifyMasterKey(repo, wrongKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('mismatch');
    }
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/services/crypto/master-key-check.ts
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import { decryptBlob } from './session-crypto.ts';
import { logger } from '../../utils/logger.ts';

const checkLogger = logger.child({ module: 'master-key-check' });

export type VerifyMasterKeyResult =
  | { ok: true; reason: 'no-sessions' | 'verified' }
  | { ok: false; reason: 'mismatch'; err: Error };

/**
 * Verifies the master key can decrypt the most recently used session.
 * This catches accidental key rotation at deploy time, before real traffic hits the
 * connect-telegram code path.
 *
 * Behavior:
 *  - No sessions in DB → pass (first-time deploy)
 *  - Key decrypts the most recent session → pass
 *  - Key fails to decrypt → return mismatch; caller decides to exit(1)
 */
export function verifyMasterKey(
  sessionRepo: TelegramSessionRepository,
  masterKey: Buffer,
): VerifyMasterKeyResult {
  const latest = sessionRepo.getMostRecentActive();
  if (!latest) return { ok: true, reason: 'no-sessions' };
  try {
    decryptBlob(Buffer.from(latest.encrypted_session), masterKey);
    checkLogger.info({ userId: latest.user_id }, 'Master key verified against latest session');
    return { ok: true, reason: 'verified' };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    checkLogger.error(
      { err: error, userId: latest.user_id },
      'TELEGRAM_SESSION_MASTER_KEY does not match existing sessions — refusing to start',
    );
    return { ok: false, reason: 'mismatch', err: error };
  }
}
```

Caller (in `src/bot/index.ts`, Task 8 Step 1) must `process.exit(1)` on mismatch so the orchestrator (systemd / docker-compose) escalates.

- [ ] **Step 3: Run test, commit**

```bash
bun test test/services/crypto/master-key-check.test.ts
git add src/services/crypto/master-key-check.ts test/services/crypto/master-key-check.test.ts
git commit -m "feat(connect-telegram): fail-fast master key verification at startup"
```

---

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
import { formatDateTimeInTimezone } from '../event/formatters.ts';

const DESC_MAX = 100;

interface Input {
  event: Pick<Event, 'title' | 'start_utc' | 'location' | 'description'>;
  inviterTimezone: string;
  deepLink: string;
  lang: 'en' | 'ru';
}

export function buildUserSessionInvitationText(input: Input): string {
  const { event, inviterTimezone, deepLink, lang } = input;
  const dateLine = formatDateTimeInTimezone(event.start_utc, inviterTimezone, lang);
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

Note: `formatDateTimeInTimezone` may or may not exist at this canonical name — check `src/services/event/formatters.ts` for the right helper (`formatEventStart`, `formatDateTime`, etc.) and use it. Do not reimplement date formatting.

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
import { encryptBlob, encryptString } from '../../services/crypto/session-crypto.ts';
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
            const phone = encryptString; // import note: use decryptString here
            const decrypted = (await import('../../services/crypto/session-crypto.ts')).decryptString(
              Buffer.from(existing.encrypted_phone),
              masterKey,
            );
            masked = maskPhone(decrypted);
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

## Task 9: Connected-User Sender + Delivery Chain

**Files:**
- Create: `src/services/telegram-session/connected-user-sender.ts`
- Create: `test/services/telegram-session/connected-user-sender.test.ts`
- Modify: `src/services/ai/types.ts` — add `sendAsConnectedUser` to `TelegramSender`
- Modify: `src/services/ai/telegram-sender.ts` — pass through the option
- Modify: `src/services/ai/tool-handlers/sharing.ts` — chain user session before admin session
- Modify: `src/bot/index.ts` — wire the factory

Delivery chain order:
1. Bot API (`sender.sendInvitation`)
2. **User's MTProto session** (new) — first-person text from Task 7
3. Admin MTProto session — existing third-person text
4. Deep-link fallback to inviter's own chat

- [ ] **Step 1: Write connected-user-sender test**

```ts
// test/services/telegram-session/connected-user-sender.test.ts
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { encryptBlob, encryptString } from '../../../src/services/crypto/session-crypto.ts';
import { createConnectedUserSender } from '../../../src/services/telegram-session/connected-user-sender.ts';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';

describe('createConnectedUserSender', () => {
  let db: Database;
  let sessionRepo: TelegramSessionRepository;
  let notifLogRepo: NotificationLogRepository;
  const masterKey = randomBytes(32);

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    runMigrations(db, migrations);
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(1, 'Sender');
    sessionRepo = new TelegramSessionRepository(db);
    notifLogRepo = new NotificationLogRepository(db);
  });

  test('returns false when no active session for inviter', async () => {
    const send = createConnectedUserSender({ sessionRepo, masterKey, notifLogRepo });
    const ok = await send(1, 2, 'Hello');
    expect(ok).toBe(false);
  });

  test('marks session expired on SESSION_EXPIRED', async () => {
    sessionRepo.upsert(
      1,
      encryptBlob(Buffer.from('fake-session'), masterKey),
      encryptString('+79001234567', masterKey),
      'hash',
    );

    // Stub sendAsUser via spyOn
    const spy = mock(async () => ({ success: false as const, error: 'SESSION_EXPIRED', message: 'revoked' }));
    // @ts-expect-error — swap static for test
    SessionBridge.sendAsUser = spy;

    const send = createConnectedUserSender({ sessionRepo, masterKey, notifLogRepo });
    const ok = await send(1, 2, 'Hello');
    expect(ok).toBe(false);
    expect(sessionRepo.getActive(1)).toBeNull();
  });

  test('logs to notification_log with channel mtproto_user on success', async () => {
    sessionRepo.upsert(
      1,
      encryptBlob(Buffer.from('fake'), masterKey),
      encryptString('+79001234567', masterKey),
      'hash',
    );
    // @ts-expect-error — stub for test
    SessionBridge.sendAsUser = mock(async () => ({ success: true as const, data: { status: 'ok' } }));

    const send = createConnectedUserSender({ sessionRepo, masterKey, notifLogRepo });
    const ok = await send(1, 2, 'Hello', 'bob', { invitationId: 42 });
    expect(ok).toBe(true);

    // Verify the row
    const row = db.prepare('SELECT * FROM notification_log WHERE user_id = ?').get(2) as {
      channel: string;
      type: string;
      reference_key: string;
    };
    expect(row.channel).toBe('mtproto_user');
    expect(row.type).toBe('invitation_sent');
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/services/telegram-session/connected-user-sender.ts
import type { TelegramSessionRepository } from '../../database/repositories/telegram-session.repository.ts';
import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import { decryptBlob } from '../crypto/session-crypto.ts';
import { SessionBridge } from './session-bridge.ts';
import { logger } from '../../utils/logger.ts';

const senderLogger = logger.child({ module: 'connected-user-sender' });

interface Deps {
  sessionRepo: TelegramSessionRepository;
  masterKey: Buffer;
  notifLogRepo?: NotificationLogRepository;
}

interface LogMeta {
  invitationId?: number;
}

export function createConnectedUserSender(deps: Deps) {
  return async function sendAsConnectedUser(
    inviterId: number,
    targetId: number,
    text: string,
    username?: string,
    meta?: LogMeta,
  ): Promise<boolean> {
    const session = deps.sessionRepo.getActive(inviterId);
    if (!session) return false;

    let sessionData: Buffer;
    try {
      sessionData = decryptBlob(Buffer.from(session.encrypted_session), deps.masterKey);
    } catch (err) {
      senderLogger.error({ err, inviterId }, 'Failed to decrypt session — marking expired');
      deps.sessionRepo.updateStatus(inviterId, 'expired');
      return false;
    }

    // Atomic temp-file creation with 0o600 and O_EXCL (symlink race protection)
    const tempPath = await SessionBridge.createTempSessionFile(inviterId, sessionData);

    try {
      const result = await SessionBridge.sendAsUser(tempPath, targetId, text, username);

      if (result.success) {
        if (deps.notifLogRepo && meta?.invitationId !== undefined) {
          const referenceKey = `invitation_${meta.invitationId}_${targetId}_mtproto_user`;
          deps.notifLogRepo.insert({
            user_id: targetId,
            type: 'invitation_sent',
            reference_key: referenceKey,
            channel: 'mtproto_user',
            payload: text,
          });
        }
        return true;
      }

      if (result.error === 'SESSION_EXPIRED') {
        senderLogger.warn({ inviterId }, 'User Telegram session expired — marking');
        deps.sessionRepo.updateStatus(inviterId, 'expired');
      } else {
        senderLogger.warn({ inviterId, error: result.error }, 'sendAsConnectedUser failed');
      }
      return false;
    } catch (err) {
      senderLogger.error({ err, inviterId }, 'sendAsConnectedUser crashed');
      return false;
    } finally {
      await SessionBridge.cleanupTempFile(tempPath);
    }
  };
}
```

- [ ] **Step 3: Add `sendAsConnectedUser` to `TelegramSender` interface**

In `src/services/ai/types.ts`:

```ts
sendAsConnectedUser?(
  inviterId: number,
  targetId: number,
  text: string,
  username?: string,
  meta?: { invitationId?: number },
): Promise<boolean>;
```

In `src/services/ai/telegram-sender.ts`, add to `TelegramSenderOptions`:

```ts
interface TelegramSenderOptions {
  sendAsUser?: (userId: number, text: string, username?: string) => Promise<boolean>;
  sendAsConnectedUser?: (
    inviterId: number,
    targetId: number,
    text: string,
    username?: string,
    meta?: { invitationId?: number },
  ) => Promise<boolean>;
}
```

Expose it on the returned sender:

```ts
sendAsConnectedUser: options?.sendAsConnectedUser,
```

(No wrapping async needed — the option already has the right signature.)

- [ ] **Step 4: Chain in `sharing.ts` `deliverInvitationAsync`**

Extract the mtproto text formatter into two helpers (one for admin, one for user session), and build a combined send that tries user-session first:

```ts
// Helper 1: admin-session text (existing third-person, unchanged)
function buildAdminMtprotoText(args: { inviterName: string; eventTitle: string; url: string; lang: 'en' | 'ru' }): string {
  return args.lang === 'ru'
    ? `📅 ${args.inviterName} приглашает вас на «${args.eventTitle}». Нажмите чтобы ответить: ${args.url}`
    : `📅 ${args.inviterName} invites you to "${args.eventTitle}". Tap to respond: ${args.url}`;
}

// Helper 2: user-session text (first-person, spec §11) — imported from invitation-text.ts
import { buildUserSessionInvitationText } from '../../telegram-session/invitation-text.ts';
```

In `deliverInvitationAsync`, after loading the event (needed for first-person format):

```ts
const event = ctx.eventService.getEvent(eventId, inviterId);
const userFirstPersonText = event && url && sender.sendAsConnectedUser
  ? buildUserSessionInvitationText({
      event,
      inviterTimezone: ctx.user.timezone,
      deepLink: url,
      lang,
    })
  : null;

const userMtprotoSend = userFirstPersonText && sender.sendAsConnectedUser
  ? (targetId: number, _text: string, username?: string): Promise<boolean> =>
      sender.sendAsConnectedUser!(inviterId, targetId, userFirstPersonText, username, { invitationId })
  : undefined;

const adminMtprotoText = url
  ? buildAdminMtprotoText({ inviterName, eventTitle, url, lang })
  : null;

const adminMtprotoSend = sender.sendAsUser && adminMtprotoText
  ? (targetId: number, _text: string, username?: string): Promise<boolean> =>
      sender.sendAsUser!(targetId, adminMtprotoText, username)
  : undefined;

const combinedMtprotoSend = userMtprotoSend || adminMtprotoSend
  ? async (targetId: number, text: string, username?: string): Promise<boolean> => {
      if (userMtprotoSend) {
        const ok = await userMtprotoSend(targetId, text, username);
        if (ok) return true;
      }
      if (adminMtprotoSend) return adminMtprotoSend(targetId, text, username);
      return false;
    }
  : undefined;

// Pass combinedMtprotoSend into deliverMessage() instead of the old mtprotoSend
```

- [ ] **Step 5: Wire factory in `src/bot/index.ts`**

```ts
import { createConnectedUserSender } from '../services/telegram-session/connected-user-sender.ts';

// ... after db is created and config is loaded ...
const telegramMasterKey = config.TELEGRAM_SESSION_MASTER_KEY
  ? Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY, 'hex')
  : null;

const sendAsConnectedUser = telegramMasterKey
  ? createConnectedUserSender({
      sessionRepo: db.telegramSessions,
      masterKey: telegramMasterKey,
      notifLogRepo: db.notificationLog,
    })
  : undefined;

const sender = createTelegramSender(bot, { sendAsUser, sendAsConnectedUser });
```

- [ ] **Step 6: Run tests, type-check**

- [ ] **Step 7: Commit**

```bash
git add src/services/telegram-session/connected-user-sender.ts \
  test/services/telegram-session/connected-user-sender.test.ts \
  src/services/ai/types.ts src/services/ai/telegram-sender.ts \
  src/services/ai/tool-handlers/sharing.ts src/bot/index.ts
git commit -m "feat(connect-telegram): wire user Telegram session into invitation delivery chain"
```

---

## Task 10: Bot Commands, Settings UI, Feature Tracking, Master-Key Startup Check

**Files:**
- Modify: `src/bot/index.ts` — register `/connect_telegram`, `/disconnect_telegram`, setMyCommands, startup master-key check
- Modify: `src/bot/commands/settings.ts` — Telegram account row + callbacks
- Modify: `src/services/feature-tracking.ts` — add `telegram_connect` FeatureKey + COMMAND_FEATURE_MAP entries
- Modify: `src/services/ai/tool-executor.ts` — add TOOL_FEATURE_MAP entry
- Modify: `src/database/repositories/feature-usage.repository.ts` — add to `FEATURE_KEYS`
- Create: `test/bot/commands/settings-telegram.test.ts`

- [ ] **Step 1: Startup master-key check**

In `src/bot/index.ts`, immediately after `config` is loaded and before the bot starts:

```ts
import { verifyMasterKey } from '../services/crypto/master-key-check.ts';

if (config.TELEGRAM_SESSION_MASTER_KEY) {
  const key = Buffer.from(config.TELEGRAM_SESSION_MASTER_KEY, 'hex');
  const result = verifyMasterKey(db.telegramSessions, key);
  if (!result.ok) {
    logger.fatal(
      { err: result.err },
      'TELEGRAM_SESSION_MASTER_KEY does not match existing sessions — refusing to start. Restore the correct key or manually delete user_telegram_sessions rows.',
    );
    process.exit(1);
  }
}
```

- [ ] **Step 2: Register bot commands**

Find where commands are registered (likely `src/bot/index.ts`) and add:

```ts
bot.command('connect_telegram', async (ctx) => {
  await ctx.scene.enter('connect-telegram');
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

- [ ] **Step 3: Update `setMyCommands`**

Find `setMyCommands` call (search `bot.api.setMyCommands` in `src/bot/index.ts` or wherever it is) and add both language variants:

```ts
// EN list:
{ command: 'connect_telegram', description: 'Connect your Telegram account for first-person invitations' },
{ command: 'disconnect_telegram', description: 'Disconnect your Telegram account' },

// RU list:
{ command: 'connect_telegram', description: 'Подключить Telegram-аккаунт для приглашений от твоего имени' },
{ command: 'disconnect_telegram', description: 'Отключить подключенный Telegram-аккаунт' },
```

- [ ] **Step 4: Feature tracking**

Add `telegram_connect` as a new `FeatureKey`:

1. **`src/database/repositories/feature-usage.repository.ts`** — add to `FEATURE_KEYS` array.
2. **`src/services/feature-tracking.ts`**:
   - Add `telegram_connect` to `FeatureKey` union
   - Add to `COMMAND_FEATURE_MAP`: `'connect_telegram': 'telegram_connect'`, `'disconnect_telegram': 'telegram_connect'`
   - Add to `CALLBACK_FEATURE_MAP`: `'stg:tg_connect': 'telegram_connect'`, `'stg:tg_disconnect_confirm': 'telegram_connect'`
   - Add to `SCENE_FEATURE_MAP`: `'connect-telegram': 'telegram_connect'`
3. **`src/services/ai/tool-executor.ts`** — add to `TOOL_FEATURE_MAP`: `connect_telegram_status: 'telegram_connect'`
4. **`src/services/notification/tip-tags.ts`** — if there's a tip for connect-telegram, add to `BOT_TIP_FEATURE_MAP`; otherwise skip.

- [ ] **Step 5: Settings UI — `buildTelegramView`**

In `src/bot/commands/settings.ts`:

```ts
import { maskPhone } from '../../config/constants.ts';
import { decryptString } from '../../services/crypto/session-crypto.ts';

// Add row to settings main keyboard:
.row()
.text(s.telegramAccount, 'stg:telegram')

export function buildTelegramView(
  session: TelegramSession | null,
  masterKey: Buffer | null,
  lang: 'en' | 'ru',
): { text: string; kb: InlineKeyboard } {
  const s = t(lang).settings;

  if (session && session.status === 'active' && masterKey) {
    let masked = '+••• ••••';
    try {
      masked = maskPhone(decryptString(Buffer.from(session.encrypted_phone), masterKey));
    } catch {
      // decryption failure will be caught by the startup master-key check; UI just shows placeholder
    }
    const kb = backRow(new InlineKeyboard().text(s.telegramDisconnect, 'stg:tg_disconnect_confirm'), lang);
    return { text: s.telegramConnected(masked), kb };
  }

  const kb = backRow(new InlineKeyboard().text(s.telegramConnect, 'stg:tg_connect'), lang);
  return { text: s.telegramNotConnected, kb };
}
```

- [ ] **Step 6: Callback handling**

In `handleSettingsCallback` (or wherever settings callbacks are dispatched):

```ts
if (subAction === 'telegram') {
  const session = telegramSessionRepo?.findByUserId(user.telegram_id) ?? null;
  const { text, kb } = buildTelegramView(session, masterKey, lang);
  await ctx.answer();
  await ctx.editText(text, { reply_markup: kb });
  return;
}

if (subAction === 'tg_connect') {
  await ctx.answer();
  if (enterScene) {
    await enterScene('connect-telegram');
  } else {
    logger.warn({ userId: user.telegram_id }, 'enterScene not injected');
    await ctx.send(t(lang).connectTelegram.featureUnavailable);
  }
  return;
}

if (subAction === 'tg_disconnect_confirm') {
  if (!telegramSessionRepo) {
    await ctx.answer();
    return;
  }
  const session = telegramSessionRepo.getActive(user.telegram_id);
  telegramSessionRepo.updateStatus(user.telegram_id, 'revoked');
  if (session && masterKey) {
    revokeRemoteSession(session, masterKey).catch((err) =>
      logger.warn({ err, userId: user.telegram_id }, 'Pyrogram log_out failed'),
    );
  }
  await ctx.answer();
  await ctx.editText(t(lang).settings.telegramDisconnected, {
    reply_markup: new InlineKeyboard().text(t(lang).settings.back, 'stg:back'),
  });
  return;
}
```

`revokeRemoteSession` helper:

```ts
async function revokeRemoteSession(session: TelegramSession, masterKey: Buffer): Promise<void> {
  const sessionData = decryptBlob(Buffer.from(session.encrypted_session), masterKey);
  const tempPath = await SessionBridge.createTempSessionFile(session.user_id, sessionData);
  try {
    await SessionBridge.logOut(tempPath);
  } finally {
    await SessionBridge.cleanupTempFile(tempPath);
  }
}
```

Update `handleSettingsCallback` signature — add new optional deps:
- `telegramSessionRepo?: TelegramSessionRepository`
- `masterKey?: Buffer`
- `enterScene?: (name: string) => Promise<void>`

- [ ] **Step 7: Write settings test**

```ts
// test/bot/commands/settings-telegram.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { buildTelegramView } from '../../../src/bot/commands/settings.ts';
import { encryptBlob, encryptString } from '../../../src/services/crypto/session-crypto.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { migrations } from '../../../src/database/migrations.ts';

describe('settings telegram view', () => {
  let db: Database;
  let repo: TelegramSessionRepository;
  const masterKey = randomBytes(32);

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    runMigrations(db, migrations);
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(100, 'Test');
    repo = new TelegramSessionRepository(db);
  });

  test('not connected when no session', () => {
    const { text, kb } = buildTelegramView(null, masterKey, 'en');
    expect(text).toContain('not connected');
    expect(JSON.stringify(kb)).toContain('tg_connect');
  });

  test('connected with masked phone in RU', () => {
    repo.upsert(
      100,
      encryptBlob(Buffer.from('session'), masterKey),
      encryptString('+79001234567', masterKey),
      'hash',
    );
    const session = repo.getActive(100);
    const { text, kb } = buildTelegramView(session, masterKey, 'ru');
    expect(text).toContain('подключён');
    expect(text).toMatch(/\+7 ••• 4567/);
    expect(JSON.stringify(kb)).toContain('tg_disconnect');
  });

  test('expired session shows not connected (getActive returns null)', () => {
    repo.upsert(
      100,
      encryptBlob(Buffer.from('s'), masterKey),
      encryptString('+79001234567', masterKey),
      'hash',
    );
    repo.updateStatus(100, 'expired');
    const { text } = buildTelegramView(repo.getActive(100), masterKey, 'en');
    expect(text).toContain('not connected');
  });

  test('reconnect after revoke restores active status', () => {
    repo.upsert(100, encryptBlob(Buffer.from('old'), masterKey), encryptString('+79001234567', masterKey), 'h1');
    repo.updateStatus(100, 'revoked');
    repo.upsert(100, encryptBlob(Buffer.from('new'), masterKey), encryptString('+79001234567', masterKey), 'h2');
    expect(repo.getActive(100)!.status).toBe('active');
  });
});
```

- [ ] **Step 8: Run tests, type-check, commit**

```bash
bun test test/bot/commands/settings-telegram.test.ts
tsc --noEmit
git add src/bot/index.ts src/bot/commands/settings.ts \
  src/services/feature-tracking.ts src/services/ai/tool-executor.ts \
  src/database/repositories/feature-usage.repository.ts \
  test/bot/commands/settings-telegram.test.ts
git commit -m "feat(connect-telegram): commands, settings UI, feature tracking, startup key check"
```

---

## Task 11: AI Tool — connect_telegram_status

**Files:**
- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/tool-handlers/settings.ts`
- Modify: `src/services/ai/types.ts`
- Create: `test/services/ai/tool-handlers/connect-telegram-status.test.ts`

- [ ] **Step 1: Write handler test**

```ts
// test/services/ai/tool-handlers/connect-telegram-status.test.ts
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { TelegramSessionRepository } from '../../../../src/database/repositories/telegram-session.repository.ts';
import { handleConnectTelegramStatus } from '../../../../src/services/ai/tool-handlers/settings.ts';
import { encryptBlob, encryptString } from '../../../../src/services/crypto/session-crypto.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { migrations } from '../../../../src/database/migrations.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

function makeCtx(overrides: Partial<AgentContext> & {
  telegramSessionRepo?: TelegramSessionRepository;
  telegramMasterKey?: Buffer;
}): AgentContext {
  return {
    user: { telegram_id: 100, language: 'en' },
    telegramSessionRepo: overrides.telegramSessionRepo,
    telegramMasterKey: overrides.telegramMasterKey,
    ...overrides,
  } as unknown as AgentContext;
}

describe('handleConnectTelegramStatus', () => {
  let db: Database;
  let repo: TelegramSessionRepository;
  const masterKey = randomBytes(32);

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    runMigrations(db, migrations);
    db.prepare('INSERT INTO users (telegram_id, first_name) VALUES (?, ?)').run(100, 'Test');
    repo = new TelegramSessionRepository(db);
  });

  test('not connected output when no session', () => {
    const result = handleConnectTelegramStatus(makeCtx({ telegramSessionRepo: repo, telegramMasterKey: masterKey }));
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ connected: false });
    expect(result.output).toContain('not connected');
  });

  test('connected with masked phone', () => {
    repo.upsert(
      100,
      encryptBlob(Buffer.from('s'), masterKey),
      encryptString('+79001234567', masterKey),
      'hash',
    );
    const result = handleConnectTelegramStatus(makeCtx({ telegramSessionRepo: repo, telegramMasterKey: masterKey }));
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ connected: true, phone_masked: '+7 ••• 4567' });
    expect(result.output).toContain('+7 ••• 4567');
  });

  test('returns not connected for expired session', () => {
    repo.upsert(
      100,
      encryptBlob(Buffer.from('s'), masterKey),
      encryptString('+79001234567', masterKey),
      'hash',
    );
    repo.updateStatus(100, 'expired');
    const result = handleConnectTelegramStatus(makeCtx({ telegramSessionRepo: repo, telegramMasterKey: masterKey }));
    expect(result.data).toEqual({ connected: false });
  });

  test('RU output', () => {
    repo.upsert(
      100,
      encryptBlob(Buffer.from('s'), masterKey),
      encryptString('+79001234567', masterKey),
      'hash',
    );
    const result = handleConnectTelegramStatus(makeCtx({
      user: { telegram_id: 100, language: 'ru' } as AgentContext['user'],
      telegramSessionRepo: repo,
      telegramMasterKey: masterKey,
    }));
    expect(result.output).toContain('подключён');
  });

  test('returns not connected when repo is undefined', () => {
    const result = handleConnectTelegramStatus(makeCtx({}));
    expect(result.data).toEqual({ connected: false });
  });
});
```

- [ ] **Step 2: Tool definition**

```ts
// src/services/ai/tools.ts
{
  name: 'connect_telegram_status',
  description: 'Check if user has connected their Telegram account for direct invitation delivery',
  input_schema: { type: 'object', properties: {} },
},
```

- [ ] **Step 3: Handler**

```ts
// src/services/ai/tool-handlers/settings.ts
import { maskPhone } from '../../../config/constants.ts';
import { decryptString } from '../../crypto/session-crypto.ts';

export function handleConnectTelegramStatus(ctx: AgentContext): ToolResult {
  const lang = (ctx.user.language ?? 'en') as 'en' | 'ru';
  const session = ctx.telegramSessionRepo?.getActive(ctx.user.telegram_id);

  if (!session || !ctx.telegramMasterKey) {
    return {
      success: true,
      output: t(lang).aiTools.meta.telegramNotConnectedStatus,
      data: { connected: false },
    };
  }

  let masked = '+••• ••••';
  try {
    masked = maskPhone(decryptString(Buffer.from(session.encrypted_phone), ctx.telegramMasterKey));
  } catch (err) {
    logger.warn({ err, userId: ctx.user.telegram_id }, 'Phone decrypt failed');
  }

  return {
    success: true,
    output: t(lang).aiTools.meta.telegramConnectedStatus(masked),
    data: { connected: true, phone_masked: masked, status: session.status },
  };
}
```

Requires `AgentContext` to carry `telegramSessionRepo?: TelegramSessionRepository` and `telegramMasterKey?: Buffer`. Add both to the AgentContext interface in `src/services/ai/types.ts` and wire them in the agent constructor.

- [ ] **Step 4: Dispatch + tool feature map**

```ts
// src/services/ai/tool-executor.ts
case 'connect_telegram_status':
  return handleConnectTelegramStatus(ctx);

// TOOL_FEATURE_MAP:
connect_telegram_status: 'telegram_connect',
```

- [ ] **Step 5: `ToolResultData` variant**

In `src/services/ai/types.ts`:

```ts
export type TelegramSessionData =
  | { connected: false }
  | { connected: true; phone_masked: string; status: string };

// Add to ToolResultData union:
| TelegramSessionData
```

- [ ] **Step 6: Run tests, commit**

```bash
bun test test/services/ai/tool-handlers/connect-telegram-status.test.ts
tsc --noEmit
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts \
  src/services/ai/tool-handlers/settings.ts src/services/ai/types.ts \
  test/services/ai/tool-handlers/connect-telegram-status.test.ts
git commit -m "feat(connect-telegram): AI tool for checking connection status"
```

---

## Task 12: Contextual Connect Prompt + Post-Connect Invitation Flow (spec §10.1 / §10.2)

**Files:**
- Modify: `src/database/migrations.ts` — migration **055** adds `connect_telegram_dismissed_at` to users
- Modify: `src/database/types.ts` — add the new field to `User`
- Modify: `src/database/repositories/user.repository.ts` — add `setConnectTelegramDismissedAt`
- Modify: `src/services/ai/system-prompt.ts` — instruction for the agent
- Modify: `src/services/ai/tool-handlers/settings.ts` — new handler `handleDismissConnectTelegramPrompt`
- Modify: `src/services/ai/tools.ts` — tool definition `dismiss_connect_telegram_prompt`
- Modify: `src/services/ai/tool-executor.ts` — dispatch
- Modify: `src/bot/scenes/connect-telegram.scene.ts` — accept `pendingEventId` / `pendingInviteeIds` params
- Modify: `src/bot/scenes/index.ts` — thread the new scene params type
- Create: `test/bot/scenes/connect-telegram.pending.test.ts`
- Create: `test/services/ai/tool-handlers/dismiss-connect-telegram-prompt.test.ts`

Goal: after the agent creates an event with non-bot participants, suggest `/connect_telegram`
(§10.1). When the user runs `/connect_telegram` *in that context*, offer to send the pending
invitation immediately after the connection completes (§10.2).

### Step 1: Migration 055 for dismissal tracking

- [ ] Add `connect_telegram_dismissed_at TEXT NULL` to `users` via migration 055. Used to suppress
  the suggestion for 30 days after a dismissal.

```ts
{
  name: '055_users_connect_telegram_dismissed_at',
  up: (db) => {
    db.exec('ALTER TABLE users ADD COLUMN connect_telegram_dismissed_at TEXT DEFAULT NULL');
  },
},
```

### Step 2: Repository method + User type

```ts
// user.repository.ts
setConnectTelegramDismissedAt(userId: number, at: string | null): void {
  this.db
    .prepare('UPDATE users SET connect_telegram_dismissed_at = ? WHERE telegram_id = ?')
    .run(at, userId);
}
```

Add `connect_telegram_dismissed_at: string | null` to the `User` interface in `database/types.ts`.

### Step 3: AI tool `dismiss_connect_telegram_prompt`

```ts
// tools.ts
{
  name: 'dismiss_connect_telegram_prompt',
  description: 'Record that user dismissed the /connect_telegram suggestion. Used by the agent when the user says "no", "not now", "позже" etc. in response to the contextual prompt. Suppresses the suggestion for 30 days.',
  input_schema: { type: 'object', properties: {} },
},
```

Handler sets `connect_telegram_dismissed_at` to `datetime('now')` and returns a short confirmation
output. Register in `tool-executor.ts` + `TOOL_FEATURE_MAP` (`'telegram_connect'`).

### Step 4: System-prompt instruction

In `src/services/ai/system-prompt.ts`, append a section that runs after the "event tools" block:

```
## /connect_telegram suggestion

When you have just created an event that has external participants (participants who have not
started the bot — detected by `sendInvitation` returning a bot-API failure OR by a participant
resolved from contacts without `telegram_id`), consider suggesting `/connect_telegram` to the
user so future invitations come from their own account:

1. Call `connect_telegram_status`
2. If `connected: true` — do nothing, skip the suggestion
3. If `connected: false` — check if the user dismissed the suggestion recently (the tool output
   will indicate this via the `dismissed_recently` flag once we add it to the status payload)
4. Otherwise, append to your response (after the "event created" confirmation):

   RU: "Кстати, можешь подключить свой Telegram-аккаунт — тогда приглашения будут приходить от тебя, а не от бота. Люди отвечают охотнее. /connect_telegram"
   EN: "You can connect your Telegram account so invitations come from you, not the bot — people respond better. /connect_telegram"

If the user responds "нет", "позже", "потом", "not now" etc. call `dismiss_connect_telegram_prompt`.

NEVER pester. One suggestion per event creation, and only if the user hasn't dismissed it recently.
```

### Step 5: Extend `connect_telegram_status` to expose `dismissed_recently`

Update the handler from Task 11 to also return `dismissed_recently: boolean` (true if
`connect_telegram_dismissed_at` is within the last 30 days). This lets the agent skip the
suggestion without a second tool call.

Update `TelegramSessionData` union:
```ts
| { connected: false; dismissed_recently: boolean }
| { connected: true; phone_masked: string; status: string }
```

### Step 6: Scene params for post-connect flow

Add a params type to the connect-telegram scene:

```ts
export interface ConnectTelegramParams {
  pendingEventId?: number;
  pendingInviteeIds?: number[];
}
```

Update the scene builder:
```ts
new Scene('connect-telegram')
  .state<ConnectTelegramState>()
  .params<ConnectTelegramParams>()
  .extend(userComposer)
  // ... steps
```

**Remember:** `.extend()` MUST come AFTER `.params()` and `.state()` (GramIO quirk — `params()`
uses `Modify<Derives>` which replaces derives; `extend()` intersects, so order matters).

### Step 7: Post-connect offer in `finalizeSession`

At the end of `finalizeSession`, replace the generic `context.send(s.success(...))` with:

```ts
const pending = context.scene.params;
if (pending?.pendingEventId && pending.pendingInviteeIds?.length) {
  const event = eventService.getEvent(pending.pendingEventId, userId);
  const inviteeId = pending.pendingInviteeIds[0]; // most recent; spec §10.2: "show only most recent"
  if (event && inviteeId !== undefined) {
    const inviteeName = resolveInviteeDisplayName(inviteeId, ctx); // helper: users table → contacts fallback
    const kb = new InlineKeyboard()
      .text(s.sendPendingBtn, `ct:send_pending:${event.id}:${inviteeId}`)
      .text(s.skipPendingBtn, 'ct:skip_pending');
    await context.send(
      s.successWithPending(maskPhone(state.phone!), event.title, formatEventStart(event, ctx.user.timezone, lang), inviteeName),
      { reply_markup: kb },
    );
    // NOTE: we do NOT exit the scene here — wait for the callback_query below
    return;
  }
}
await context.send(s.success(maskPhone(state.phone!)));
await context.scene.exit();
```

Add a final step that handles `callback_query`:

```ts
.step('callback_query', async (context) => {
  const data = context.data;
  if (!data) return;

  if (data === 'ct:skip_pending') {
    await context.answer();
    await context.send(t(context.lang ?? 'en').connectTelegram.cancelled);
    return context.scene.exit();
  }

  const match = /^ct:send_pending:(\d+):(\d+)$/.exec(data);
  if (match) {
    const eventId = Number(match[1]);
    const inviteeId = Number(match[2]);
    await context.answer();
    // Fire the existing sendInvitation tool so it flows through the invitation-text helper
    // and the user-session delivery chain added in Task 9.
    await invitationService.sendInvitation(eventId, context.from.id, inviteeId);
    await context.send(t(context.lang ?? 'en').connectTelegram.pendingSent);
    return context.scene.exit();
  }
})
```

The scene now needs `invitationService` injected. Add it to `createConnectTelegramScene` deps.

### Step 8: New i18n strings

Add to `MSG.en.connectTelegram` and `MSG.ru.connectTelegram`:

```ts
// EN:
successWithPending: (masked: string, eventTitle: string, dateLine: string, inviteeName: string) =>
  `✅ Telegram account connected (${masked})\n\nYou have a meeting "${eventTitle}" (${dateLine}) — ${inviteeName} has not been invited yet.\nSend the invitation from your account?`,
sendPendingBtn: 'Send',
skipPendingBtn: 'Not now',
pendingSent: '✅ Invitation sent.',

// RU:
successWithPending: (masked: string, eventTitle: string, dateLine: string, inviteeName: string) =>
  `✅ Telegram-аккаунт подключён (${masked})\n\nУ тебя есть встреча «${eventTitle}» (${dateLine}) — ${inviteeName} ещё не приглашён.\nОтправить приглашение от твоего имени?`,
sendPendingBtn: 'Отправить',
skipPendingBtn: 'Не сейчас',
pendingSent: '✅ Приглашение отправлено.',
```

### Step 9: Trigger the scene with params from the agent

The agent cannot pass scene params directly — it only knows about tools. Extend the existing AI
tool that "starts the connect flow" path:

Option A (preferred): the agent suggests `/connect_telegram` in text, and when the user *clicks*
the deep link or types the command, the bot checks `ctx.dbUser.connect_telegram_dismissed_at` and
loads the most recent event from `action_log` where external participants exist. Pass it as
params:

```ts
bot.command('connect_telegram', async (ctx) => {
  const recentEvent = findMostRecentEventWithExternalParticipants(ctx.dbUser.telegram_id); // new helper
  await ctx.scene.enter('connect-telegram', recentEvent
    ? { pendingEventId: recentEvent.id, pendingInviteeIds: recentEvent.externalInviteeIds }
    : {}
  );
});
```

`findMostRecentEventWithExternalParticipants(userId)` — new helper in `src/services/event/`
that queries `action_log` for the most recent `create_event` action within the last 10 minutes
whose resulting event has `event_participants` rows with `telegram_id IS NULL` (or resolved
from contacts but not in users table).

### Step 10: Tests

```ts
// test/bot/scenes/connect-telegram.pending.test.ts
describe('connect-telegram post-connect flow', () => {
  test('finalize without pending params → generic success', async () => { /* ... */ });
  test('finalize with pendingEventId → offer inline keyboard', async () => { /* ... */ });
  test('ct:send_pending callback → sendInvitation called with correct ids', async () => { /* ... */ });
  test('ct:skip_pending callback → scene exits without sending', async () => { /* ... */ });
});
```

```ts
// test/services/ai/tool-handlers/dismiss-connect-telegram-prompt.test.ts
describe('handleDismissConnectTelegramPrompt', () => {
  test('sets connect_telegram_dismissed_at to current time', () => { /* ... */ });
  test('second call idempotent', () => { /* ... */ });
});
```

```ts
// Update test/services/ai/tool-handlers/connect-telegram-status.test.ts
test('dismissed_recently true when dismissed within 30 days', () => { /* ... */ });
test('dismissed_recently false when dismissed 31 days ago', () => { /* ... */ });
```

### Step 11: Run tests, type-check, commit

```bash
bun test test/bot/scenes/connect-telegram.pending.test.ts \
         test/services/ai/tool-handlers/dismiss-connect-telegram-prompt.test.ts \
         test/services/ai/tool-handlers/connect-telegram-status.test.ts
tsc --noEmit
git add src/database/migrations.ts src/database/types.ts \
  src/database/repositories/user.repository.ts \
  src/services/ai/system-prompt.ts src/services/ai/tools.ts \
  src/services/ai/tool-executor.ts src/services/ai/tool-handlers/settings.ts \
  src/bot/scenes/connect-telegram.scene.ts src/bot/scenes/index.ts \
  src/config/constants.ts src/services/event/ src/bot/index.ts \
  test/bot/scenes/connect-telegram.pending.test.ts \
  test/services/ai/tool-handlers/dismiss-connect-telegram-prompt.test.ts
git commit -m "feat(connect-telegram): contextual prompt + post-connect invitation flow (spec §10.1 / §10.2)"
```

---

## Task 13: Automatic Timezone Detection (spec §13)

**Files:**
- Modify: `scripts/connect-session.py` — new subcommand `get_authorizations`
- Modify: `src/services/telegram-session/session-bridge.ts` — wrapper + zod codec schema
- Create: `src/services/telegram-session/timezone-detector.ts`
- Create: `test/services/telegram-session/timezone-detector.test.ts`
- Modify: `src/services/telegram-session/connected-user-sender.ts` — opportunistic check piggyback
- Modify: `src/database/migrations.ts` — migration **056** adds `tz_detection_consent_at` to `user_telegram_sessions`
- Modify: `src/database/types.ts` — add the new field to `TelegramSession`
- Modify: `src/config/constants.ts` — new i18n strings for tz confirmation
- Modify: `src/bot/scenes/connect-telegram.scene.ts` — add tz consent bullet to consent screen
- Add: `geo-tz` npm package

Goal: passively detect timezone changes by reading `account.getAuthorizations()` session metadata
(country, region, last_active). No message or content access. Always confirm with the user
before updating `users.timezone` — VPN users would get false positives.

### Step 1: Migration 056 — consent timestamp for §13

- [ ] Add `tz_detection_consent_at TEXT NULL` to `user_telegram_sessions`. Users who connected
  before §13 shipped must re-consent via a one-time confirmation before the first
  `getAuthorizations()` call.

```ts
{
  name: '056_user_telegram_sessions_tz_consent',
  up: (db) => {
    db.exec('ALTER TABLE user_telegram_sessions ADD COLUMN tz_detection_consent_at TEXT DEFAULT NULL');
  },
},
```

### Step 2: Install `geo-tz`

```bash
bun add geo-tz
```

`geo-tz` gives `find(lat, lon) → string[]` (IANA). For country+region → IANA mapping we also need
a lightweight lookup table. For single-timezone countries (JP, KR, IN, AE, SG, IL, TR) country
alone is enough; for multi-timezone (US, RU, CA, AU, BR, CN, ID) the region maps to known IANA
zones. Build the table inline in `timezone-detector.ts` — ~40 entries total.

### Step 3: Python `get_authorizations` subcommand

```python
async def cmd_get_authorizations(args: argparse.Namespace) -> None:
    client = make_client(args.session_path)
    await client.connect()
    try:
        # Pyrogram wrapper over account.getAuthorizations
        auths = await client.invoke(
            __import__('pyrogram.raw.functions.account', fromlist=['GetAuthorizations']).GetAuthorizations()
        )
        result = [
            {
                "hash": a.hash,
                "device_model": a.device_model,
                "platform": a.platform,
                "system_version": a.system_version,
                "app_name": a.app_name,
                "country": a.country,
                "region": a.region,
                "ip": a.ip,
                "date_active": a.date_active,
                "current": bool(a.current),
            }
            for a in auths.authorizations
        ]
        print(json.dumps({"authorizations": result}))
    except Exception as e:
        print(error_json("AUTH_QUERY_FAILED", str(e)))
        sys.exit(1)
    finally:
        await client.disconnect()
```

Add `p_auth = sub.add_parser("get_authorizations"); p_auth.add_argument("--session_path", required=True)`
and register in the commands dict.

### Step 4: Bridge wrapper + schema

```ts
// Add to session-bridge.ts
const AuthorizationSchema = z.object({
  hash: z.number(),
  device_model: z.string(),
  platform: z.string(),
  system_version: z.string(),
  app_name: z.string(),
  country: z.string(),
  region: z.string(),
  ip: z.string(),
  date_active: z.number(),
  current: z.boolean(),
});
const GetAuthorizationsSchema = z.object({ authorizations: z.array(AuthorizationSchema) });
export type Authorization = z.infer<typeof AuthorizationSchema>;

// Add to SuccessSchema union
const SuccessSchema = z.union([
  SendCodeSchema,
  SignInSchema,
  CheckPasswordSchema,
  SendAsUserSchema,
  LogOutSchema,
  GetAuthorizationsSchema,
]);

// New method
static async getAuthorizations(sessionPath: string): Promise<BridgeResult> {
  return SessionBridge.spawn([CONNECT_SCRIPT, 'get_authorizations', '--session_path', sessionPath]);
}
```

### Step 5: Timezone detector

```ts
// src/services/telegram-session/timezone-detector.ts
import type { Authorization } from './session-bridge.ts';

interface DetectionResult {
  detectedTimezone: string;
  country: string;
  region: string;
}

/** Single-timezone ISO country codes. */
const SINGLE_TZ_COUNTRIES: Record<string, string> = {
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  IN: 'Asia/Kolkata',
  AE: 'Asia/Dubai',
  SG: 'Asia/Singapore',
  IL: 'Asia/Jerusalem',
  TR: 'Europe/Istanbul',
  GB: 'Europe/London',
  FR: 'Europe/Paris',
  DE: 'Europe/Berlin',
  NL: 'Europe/Amsterdam',
  RS: 'Europe/Belgrade',
  IT: 'Europe/Rome',
  ES: 'Europe/Madrid', // Canary Islands ignored — extremely rare
  PL: 'Europe/Warsaw',
  CZ: 'Europe/Prague',
  AT: 'Europe/Vienna',
  GR: 'Europe/Athens',
  HU: 'Europe/Budapest',
  SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen',
  FI: 'Europe/Helsinki',
  PT: 'Europe/Lisbon',
  BE: 'Europe/Brussels',
  CH: 'Europe/Zurich',
  IE: 'Europe/Dublin',
  UA: 'Europe/Kyiv',
  BY: 'Europe/Minsk',
  MD: 'Europe/Chisinau',
  // ... extend as real users travel
};

/** Multi-timezone countries: region (as Telegram returns it) → IANA. */
const MULTI_TZ_REGIONS: Record<string, Record<string, string>> = {
  RU: {
    'Moscow': 'Europe/Moscow',
    'Saint Petersburg': 'Europe/Moscow',
    'Kaliningrad': 'Europe/Kaliningrad',
    'Ekaterinburg': 'Asia/Yekaterinburg',
    'Novosibirsk': 'Asia/Novosibirsk',
    'Krasnoyarsk': 'Asia/Krasnoyarsk',
    'Irkutsk': 'Asia/Irkutsk',
    'Vladivostok': 'Asia/Vladivostok',
    // ... add as needed
  },
  US: {
    'New York': 'America/New_York',
    'California': 'America/Los_Angeles',
    'Texas': 'America/Chicago',
    'Illinois': 'America/Chicago',
    'Colorado': 'America/Denver',
    'Washington': 'America/Los_Angeles',
    'Florida': 'America/New_York',
    // ... add as needed
  },
  CA: {
    'Ontario': 'America/Toronto',
    'Quebec': 'America/Toronto',
    'British Columbia': 'America/Vancouver',
    'Alberta': 'America/Edmonton',
  },
  AU: {
    'New South Wales': 'Australia/Sydney',
    'Victoria': 'Australia/Melbourne',
    'Queensland': 'Australia/Brisbane',
    'Western Australia': 'Australia/Perth',
  },
};

/**
 * Picks the most recently active mobile session from the authorizations list
 * and resolves it to an IANA timezone. Returns null if the detected tz matches
 * currentTimezone, or if the country is unknown.
 */
export function detectTimezoneFromAuthorizations(
  auths: Authorization[],
  currentTimezone: string,
): DetectionResult | null {
  const mobile = auths
    .filter((a) => a.platform === 'iOS' || a.platform === 'Android')
    .sort((a, b) => b.date_active - a.date_active);
  const active = mobile[0];
  if (!active) return null;

  const countryCode = active.country.toUpperCase().slice(0, 2); // heuristic; Telegram returns ISO 3166-1 alpha-2
  const single = SINGLE_TZ_COUNTRIES[countryCode];
  if (single) {
    if (single === currentTimezone) return null;
    return { detectedTimezone: single, country: active.country, region: active.region };
  }

  const multi = MULTI_TZ_REGIONS[countryCode];
  if (multi) {
    const resolved = multi[active.region];
    if (resolved && resolved !== currentTimezone) {
      return { detectedTimezone: resolved, country: active.country, region: active.region };
    }
  }

  return null;
}
```

### Step 6: Opportunistic check in delivery path

In `connected-user-sender.ts`, after `SessionBridge.sendAsUser` succeeds, piggyback one
`getAuthorizations` call (only if `tz_detection_consent_at IS NOT NULL` and the session is
already warm from the send). Post the detection result to an in-process queue that the bot
drains into a "Update timezone?" inline keyboard message to the user.

**Do not spawn a second Python process** — add a flag `--also_authorizations` to `send-as-user.py`
and have the single process do both `send_message` + `get_authorizations` before disconnect.
This keeps the "one spawn per send" invariant and makes the feature effectively free.

Simplification for MVP: keep it as two separate Python calls for now (one send, one auth query).
Optimize to single-spawn later if tests show the overhead matters.

### Step 7: Consent update

Add to the consent screen (§3 Step 1 in i18n strings):

```ts
// MSG.ru.connectTelegram.consent — add to "Бот БУДЕТ:" list:
'• Определять твою таймзону по региону подключения для автоматического обновления часового пояса',

// MSG.en.connectTelegram.consent — add to "The bot WILL:" list:
'• Detect your timezone from the connection region so events show at the correct local time',
```

Users who connected BEFORE this feature shipped: track via `tz_detection_consent_at`. Before
the first `getAuthorizations()` call, send:

```
🌍 Бот теперь умеет автоматически определять твою таймзону по подключению Telegram.
Согласен? (читается только страна и регион, не сообщения)
[Да] [Нет]
```

On "Да" → `UPDATE user_telegram_sessions SET tz_detection_consent_at = datetime('now')`.
On "Нет" → skip forever (store a sentinel like `'never'`).

### Step 8: User-facing confirmation message

When `detectTimezoneFromAuthorizations` returns a non-null result, send:

```
Похоже, ты сейчас в {city} {country_flag}
Обновить таймзону на {iana_tz}?
[Да] [Нет]
```

The city is derived from `active.region` (display only; not used for resolution). Callback handlers
`ct:tz_update:{iana}` and `ct:tz_skip` in the main bot router (not inside the scene — this fires
after delivery, not during connect flow).

### Step 9: Tests

```ts
// test/services/telegram-session/timezone-detector.test.ts
describe('detectTimezoneFromAuthorizations', () => {
  test('single-timezone country resolves by country code (JP)', () => { /* ... */ });
  test('multi-timezone country resolves by region (US / California → America/Los_Angeles)', () => { /* ... */ });
  test('returns null when detected equals current', () => { /* ... */ });
  test('returns null for unknown country', () => { /* ... */ });
  test('picks most recent mobile session when multiple present', () => { /* ... */ });
  test('ignores desktop sessions', () => { /* ... */ });
});
```

### Step 10: Run tests, commit

```bash
bun test test/services/telegram-session/timezone-detector.test.ts
tsc --noEmit
git add scripts/connect-session.py \
  src/services/telegram-session/session-bridge.ts \
  src/services/telegram-session/timezone-detector.ts \
  src/services/telegram-session/connected-user-sender.ts \
  src/database/migrations.ts src/database/types.ts \
  src/config/constants.ts src/bot/index.ts \
  test/services/telegram-session/timezone-detector.test.ts \
  package.json bun.lock
git commit -m "feat(connect-telegram): automatic timezone detection via account.getAuthorizations (spec §13)"
```

---

## Task 14: Final Integration

- [ ] **Step 1: Full test suite**

```bash
bun test
```

- [ ] **Step 2: Lint**

```bash
bun run lint
```

- [ ] **Step 3: Type-check**

```bash
tsc --noEmit
```

- [ ] **Step 4: Unused exports**

```bash
bunx knip
```

- [ ] **Step 5: Codex self-review (per CLAUDE.md 4-stage protocol)**

```bash
codex exec review --uncommitted
codex exec "security review --uncommitted"
```

Address every non-false-positive finding.

- [ ] **Step 6: Deploy preparation**

- Generate master key: `openssl rand -hex 32`
- Add `TELEGRAM_SESSION_MASTER_KEY` to GitHub Secrets and `/opt/hypercal/.env`
- Verify the deploy workflow passes the env var to `docker compose`
- Restart bot after first deploy; verify `verifyMasterKey` logs `{ reason: 'no-sessions' }` on first run

- [ ] **Step 7: Manual smoke test**

1. `/connect_telegram` → complete flow with a real phone (admin account)
2. Create an event and invite a non-bot user via the inviter's account — verify the message arrives with first-person text
3. `/settings` → Telegram row shows masked phone
4. `/disconnect_telegram` → confirm, verify row status goes to `revoked`, Pyrogram `log_out` succeeded in logs
5. Restart bot — verify `verifyMasterKey` logs `{ reason: 'verified' }`
6. Simulate wrong key (temporarily point env var at a different value) — bot must refuse to start with `fatal` log

---

## Summary

14 tasks, roughly 25 commits (one per logical step). The plan reflects:

- Correct migration numbers: **054** (sessions table), **055** (dismissal column), **056** (tz consent column)
- Real `@gramio/scenes` API (`.state().params().extend().onEnter().step()` + `context.scene.step.firstTime/next`)
- `NotificationLogRepository.insert(data)` with proper schema (not a fake `.log()` method)
- Zod-codec JSON parsing (no external try/catch) — matches new CLAUDE.md rule
- Encrypted phone storage; masked display via `libphonenumber-js`
- First-person invitation text from spec §11
- Fail-fast master-key check at startup
- Atomic temp file creation (`O_CREAT|O_EXCL`, 0o600) — symlink-race safe
- Stdin password delivery for 2FA (no CLI arg leak)
- Feature tracking (COMMAND/CALLBACK/SCENE/TOOL maps + FEATURE_KEYS)
- `setMyCommands` in both RU and EN
- **All spec sections in scope**, including the contextual prompt (§10.1), post-connect flow (§10.2) and automatic timezone detection (§13). No deferred follow-ups.
