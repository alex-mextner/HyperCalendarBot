> Part 1 of 5 of [Connect Telegram Account — Implementation Plan](../2026-03-25-connect-telegram.md) — next: [02-tasks-4-6.md](02-tasks-4-6.md)

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
| `src/services/ai/tool-executor.ts` | Add dispatch case for `connect_telegram_status` + `dismiss_connect_telegram_prompt`, add both to `TOOL_FEATURE_MAP` |
| `src/services/ai/tool-handlers/settings.ts` | Add handlers for `connect_telegram_status` and `dismiss_connect_telegram_prompt` |
| `src/services/ai/types.ts` | Add `TelegramSessionData` variant to `ToolResultData`, add `sendAsConnectedUser` to `TelegramSender`, add `telegramSessionRepo` / `telegramMasterKey` to `AgentContext` |
| `src/services/ai/tool-handlers/sharing.ts` | Chain user-session delivery into `deliverInvitationAsync` with the first-person text helper |
| `src/services/ai/telegram-sender.ts` | Accept `sendAsConnectedUser` factory option and expose it on the sender |
| `src/services/ai/system-prompt.ts` | Add `/connect_telegram` suggestion instruction (spec §10.1) |
| `src/services/feature-tracking.ts` | Add `telegram_connect` to `FeatureKey` union, `COMMAND_FEATURE_MAP`, `CALLBACK_FEATURE_MAP`, `SCENE_FEATURE_MAP` |
| `src/database/repositories/feature-usage.repository.ts` | Add `telegram_connect` to `FEATURE_KEYS` |
| `src/database/repositories/user.repository.ts` | Add `setConnectTelegramDismissedAt` method |

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

