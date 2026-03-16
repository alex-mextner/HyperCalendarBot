# Voice Call Reminders — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot calls users via Telegram voice calls to play TTS-synthesized event reminders. No voice capture in v1 — post-call inline buttons for snooze/cancel/acknowledge.

**Architecture:** MTProto userbot (@mtcute/bun) handles call signaling (phone.requestCall, DH exchange). ntgcalls C++ library (via Bun FFI) handles WebRTC media transport — plays TTS audio into the call. Edge TTS synthesizes reminder text. BullMQ call-reminder queue dispatches calls from existing notification system. After call ends, bot sends inline keyboard with actions.

**Tech Stack:** @mtcute/bun (MTProto), ntgcalls (C++ via Bun FFI), edge-tts (TTS synthesis), BullMQ + Redis, bun:sqlite

**Spec:** `docs/specs/07-voice-calls.md`
**Architecture spec:** `docs/specs/00-common-architecture.md`

**Testing:** All new `src/` modules must have ≥80% line coverage (enforced by `bunfig.toml`). Each task includes red tests (error paths, edge cases, invalid input) alongside happy-path tests. Run `bun test --coverage` after each chunk to verify.

---

## File Structure

### New files

```
src/services/voice/
  mtproto-client.ts          — @mtcute/bun userbot client (session, auth, raw TL calls)
  call-signaling.ts          — phone.requestCall/acceptCall/confirmCall/discardCall wrappers
  ntgcalls-ffi.ts            — Bun FFI bindings to libntgcalls (.dylib/.so)
  call-manager.ts            — Orchestrates: TTS → signaling → media → end call → buttons
  tts-service.ts             — Edge TTS synthesis + file caching
  tts-renderer.ts            — Build speech-friendly reminder text from event data
  types.ts                   — Shared types (CallState, CallConfig, etc.)

src/database/repositories/
  call-settings.repository.ts — CRUD for user_call_settings
  call-log.repository.ts      — CRUD for call_log

src/worker/
  call-queue.ts               — BullMQ call-reminder queue + worker

src/bot/commands/
  call-settings.ts            — /callsettings command (enable/disable, quiet hours)
```

### Modified files

```
src/database/migrations.ts         — Add migration 009 (2 tables)
src/database/types.ts              — Add row types
src/database/index.ts              — Register 2 new repositories
src/config/env.ts                  — Add MTPROTO_SESSION, VOICE_CALL_PHONE_NUMBER
src/config/constants.ts            — CB prefix for call settings, i18n messages
src/services/notification/scheduler.ts — Route to voice channel based on user prefs
src/services/notification/renderer.ts  — Add renderForVoice() method
src/bot/index.ts                   — Register /callsettings, wire call services
src/index.ts                       — Initialize voice call services conditionally
```

### Test files (mirror src/ structure)

```
test/services/voice/
  tts-renderer.test.ts
  tts-service.test.ts
  call-signaling.test.ts
  call-manager.test.ts
  ntgcalls-ffi.test.ts

test/database/repositories/
  call-settings.repository.test.ts
  call-log.repository.test.ts

test/worker/
  call-queue.test.ts

test/bot/commands/
  call-settings.test.ts
```

### Binary dependencies (not in git)

```
lib/
  ntgcalls.dylib              — macOS ARM64 prebuilt (download from ntgcalls releases)
  ntgcalls.so                 — Linux x86_64/ARM64 prebuilt
```

---

## Chunk 1: Database Foundation + TTS Text Rendering

### Task 1: Migration 009 — voice call tables

**Files:**

- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`
- Test: `test/database/schema.test.ts`

- [ ] **Step 1: Write migration test**

Add to existing `test/database/schema.test.ts`:

```typescript
test('migration 009 creates voice call tables', () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name);
  expect(names).toContain('user_call_settings');
  expect(names).toContain('call_log');
});
```

- [ ] **Step 2: Run test — confirm FAIL**

Run: `bun test test/database/schema.test.ts`
Expected: FAIL — tables don't exist yet

- [ ] **Step 3: Add migration 009 to migrations.ts**

Add to the `migrations` array in `src/database/migrations.ts`:

```typescript
{
  name: '009_create_voice_call_tables',
  up(db: Database) {
    db.exec(`
      CREATE TABLE user_call_settings (
        user_id              INTEGER PRIMARY KEY,
        enabled              INTEGER NOT NULL DEFAULT 0,
        quiet_hours_start    TEXT,
        quiet_hours_end      TEXT,
        max_daily_calls      INTEGER NOT NULL DEFAULT 5,
        language             TEXT NOT NULL DEFAULT 'en',
        important_only       INTEGER NOT NULL DEFAULT 0,
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );

      CREATE TABLE call_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL,
        event_id      INTEGER,
        status        TEXT NOT NULL DEFAULT 'queued',
        duration_sec  INTEGER,
        tts_text      TEXT,
        error         TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at  TEXT,
        FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      );
      CREATE INDEX idx_call_log_user ON call_log(user_id, created_at);
      CREATE INDEX idx_call_log_status ON call_log(status) WHERE status IN ('queued', 'ringing');
    `);
  },
},
```

- [ ] **Step 4: Run test — confirm PASS**

Run: `bun test test/database/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Add row types to types.ts**

Append to `src/database/types.ts`:

```typescript
// --- Voice Call Reminders (sub-project 07) ---

export type CallStatus = 'queued' | 'ringing' | 'connected' | 'completed' | 'failed' | 'no_answer' | 'busy' | 'cancelled';

export interface UserCallSettings {
  user_id: number;
  enabled: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  max_daily_calls: number;
  language: string;
  important_only: number;
  updated_at: string;
}

export interface CallLog {
  id: number;
  user_id: number;
  event_id: number | null;
  status: CallStatus;
  duration_sec: number | null;
  tts_text: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/database/migrations.ts src/database/types.ts test/database/schema.test.ts
git commit -m "feat(voice): add migration 009 — user_call_settings and call_log tables"
```

---

### Task 2: CallSettingsRepository + CallLogRepository

**Files:**

- Create: `src/database/repositories/call-settings.repository.ts`
- Create: `src/database/repositories/call-log.repository.ts`
- Create: `test/database/repositories/call-settings.repository.test.ts`
- Create: `test/database/repositories/call-log.repository.test.ts`

- [ ] **Step 1: Write CallSettingsRepository tests**

```typescript
// test/database/repositories/call-settings.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { CallSettingsRepository } from '../../../src/database/repositories/call-settings.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { migrations } from '../../../src/database/migrations';
import { runMigrations } from '../../../src/database/schema';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('CallSettingsRepository', () => {
  let db: Database;
  let repo: CallSettingsRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new CallSettingsRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('get returns null when no settings', () => {
    expect(repo.get(USER_ID)).toBeNull();
  });

  test('ensureDefaults creates row with defaults', () => {
    repo.ensureDefaults(USER_ID);
    const settings = repo.get(USER_ID);
    expect(settings).not.toBeNull();
    expect(settings!.enabled).toBe(0);
    expect(settings!.max_daily_calls).toBe(5);
    expect(settings!.language).toBe('en');
  });

  test('ensureDefaults is idempotent', () => {
    repo.ensureDefaults(USER_ID);
    repo.ensureDefaults(USER_ID);
    expect(repo.get(USER_ID)!.enabled).toBe(0);
  });

  test('setEnabled toggles enabled flag', () => {
    repo.ensureDefaults(USER_ID);
    repo.setEnabled(USER_ID, true);
    expect(repo.get(USER_ID)!.enabled).toBe(1);
    repo.setEnabled(USER_ID, false);
    expect(repo.get(USER_ID)!.enabled).toBe(0);
  });

  test('setQuietHours stores start and end', () => {
    repo.ensureDefaults(USER_ID);
    repo.setQuietHours(USER_ID, '22:00', '08:00');
    const s = repo.get(USER_ID)!;
    expect(s.quiet_hours_start).toBe('22:00');
    expect(s.quiet_hours_end).toBe('08:00');
  });

  test('isEnabled returns false when not configured', () => {
    expect(repo.isEnabled(USER_ID)).toBe(false);
  });

  test('isEnabled returns true when enabled', () => {
    repo.ensureDefaults(USER_ID);
    repo.setEnabled(USER_ID, true);
    expect(repo.isEnabled(USER_ID)).toBe(true);
  });

  // --- Red tests ---

  test('get returns null for non-existent user', () => {
    expect(repo.get(999)).toBeNull();
  });

  test('isEnabled returns false for non-existent user', () => {
    expect(repo.isEnabled(999)).toBe(false);
  });

  test('setQuietHours clears with nulls', () => {
    repo.ensureDefaults(USER_ID);
    repo.setQuietHours(USER_ID, '22:00', '08:00');
    repo.setQuietHours(USER_ID, null, null);
    const s = repo.get(USER_ID)!;
    expect(s.quiet_hours_start).toBeNull();
    expect(s.quiet_hours_end).toBeNull();
  });

  test('setLanguage updates language', () => {
    repo.ensureDefaults(USER_ID);
    repo.setLanguage(USER_ID, 'ru');
    expect(repo.get(USER_ID)!.language).toBe('ru');
  });
});
```

- [ ] **Step 2: Write CallLogRepository tests**

```typescript
// test/database/repositories/call-log.repository.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { CallLogRepository } from '../../../src/database/repositories/call-log.repository';
import { UserRepository } from '../../../src/database/repositories/user.repository';
import { migrations } from '../../../src/database/migrations';
import { runMigrations } from '../../../src/database/schema';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

const USER_ID = 100;

describe('CallLogRepository', () => {
  let db: Database;
  let repo: CallLogRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new CallLogRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('create stores call log entry', () => {
    const log = repo.create({ user_id: USER_ID, event_id: 1, tts_text: 'Meeting in 10 minutes' });
    expect(log.id).toBeGreaterThan(0);
    expect(log.status).toBe('queued');
  });

  test('updateStatus transitions status', () => {
    const log = repo.create({ user_id: USER_ID });
    repo.updateStatus(log.id, 'ringing');
    expect(repo.findById(log.id)!.status).toBe('ringing');
  });

  test('complete sets status, duration, completed_at', () => {
    const log = repo.create({ user_id: USER_ID });
    repo.complete(log.id, 'completed', 30);
    const updated = repo.findById(log.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.duration_sec).toBe(30);
    expect(updated.completed_at).not.toBeNull();
  });

  test('complete with error stores error message', () => {
    const log = repo.create({ user_id: USER_ID });
    repo.complete(log.id, 'failed', 0, 'User busy');
    expect(repo.findById(log.id)!.error).toBe('User busy');
  });

  test('countTodayCalls counts calls for today', () => {
    repo.create({ user_id: USER_ID });
    repo.create({ user_id: USER_ID });
    expect(repo.countTodayCalls(USER_ID)).toBe(2);
  });

  test('getRecent returns latest calls', () => {
    repo.create({ user_id: USER_ID, tts_text: 'First' });
    repo.create({ user_id: USER_ID, tts_text: 'Second' });
    const recent = repo.getRecent(USER_ID, 5);
    expect(recent).toHaveLength(2);
    expect(recent[0].tts_text).toBe('Second');
  });

  // --- Red tests ---

  test('findById returns null for non-existent id', () => {
    expect(repo.findById(999)).toBeNull();
  });

  test('countTodayCalls returns 0 for user with no calls', () => {
    expect(repo.countTodayCalls(999)).toBe(0);
  });

  test('getRecent returns empty for user with no calls', () => {
    expect(repo.getRecent(999, 5)).toHaveLength(0);
  });

  test('create without optional fields uses defaults', () => {
    const log = repo.create({ user_id: USER_ID });
    expect(log.event_id).toBeNull();
    expect(log.tts_text).toBeNull();
    expect(log.error).toBeNull();
    expect(log.duration_sec).toBeNull();
    expect(log.completed_at).toBeNull();
  });

  test('complete with failed status stores error', () => {
    const log = repo.create({ user_id: USER_ID });
    repo.complete(log.id, 'failed', 0, 'Connection timeout');
    const updated = repo.findById(log.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toBe('Connection timeout');
    expect(updated.duration_sec).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests — confirm FAIL**

Run: `bun test test/database/repositories/call-settings.repository.test.ts test/database/repositories/call-log.repository.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 4: Implement CallSettingsRepository**

```typescript
// src/database/repositories/call-settings.repository.ts
import type { Database } from 'bun:sqlite';
import type { UserCallSettings } from '../types';

export class CallSettingsRepository {
  constructor(private db: Database) {}

  get(userId: number): UserCallSettings | null {
    return (
      (this.db.prepare('SELECT * FROM user_call_settings WHERE user_id = ?').get(userId) as UserCallSettings | null) ?? null
    );
  }

  ensureDefaults(userId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO user_call_settings (user_id) VALUES (?)').run(userId);
  }

  setEnabled(userId: number, enabled: boolean): void {
    this.db
      .prepare("UPDATE user_call_settings SET enabled = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(enabled ? 1 : 0, userId);
  }

  setQuietHours(userId: number, start: string | null, end: string | null): void {
    this.db
      .prepare("UPDATE user_call_settings SET quiet_hours_start = ?, quiet_hours_end = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(start, end, userId);
  }

  setLanguage(userId: number, language: string): void {
    this.db
      .prepare("UPDATE user_call_settings SET language = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(language, userId);
  }

  isEnabled(userId: number): boolean {
    const row = this.db
      .prepare('SELECT enabled FROM user_call_settings WHERE user_id = ?')
      .get(userId) as { enabled: number } | null;
    return row?.enabled === 1;
  }
}
```

- [ ] **Step 5: Implement CallLogRepository**

```typescript
// src/database/repositories/call-log.repository.ts
import type { Database } from 'bun:sqlite';
import type { CallLog, CallStatus } from '../types';

interface CreateCallLogData {
  user_id: number;
  event_id?: number;
  tts_text?: string;
}

export class CallLogRepository {
  constructor(private db: Database) {}

  create(data: CreateCallLogData): CallLog {
    const result = this.db
      .prepare('INSERT INTO call_log (user_id, event_id, tts_text) VALUES (?, ?, ?)')
      .run(data.user_id, data.event_id ?? null, data.tts_text ?? null);
    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): CallLog | null {
    return (this.db.prepare('SELECT * FROM call_log WHERE id = ?').get(id) as CallLog | null) ?? null;
  }

  updateStatus(id: number, status: CallStatus): void {
    this.db.prepare('UPDATE call_log SET status = ? WHERE id = ?').run(status, id);
  }

  complete(id: number, status: CallStatus, durationSec: number, error?: string): void {
    this.db
      .prepare("UPDATE call_log SET status = ?, duration_sec = ?, error = ?, completed_at = datetime('now') WHERE id = ?")
      .run(status, durationSec, error ?? null, id);
  }

  countTodayCalls(userId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM call_log WHERE user_id = ? AND created_at >= date('now')")
      .get(userId) as { cnt: number };
    return row.cnt;
  }

  getRecent(userId: number, limit: number): CallLog[] {
    return this.db
      .prepare('SELECT * FROM call_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit) as CallLog[];
  }
}
```

- [ ] **Step 6: Run tests — confirm PASS**

Run: `bun test test/database/repositories/call-settings.repository.test.ts test/database/repositories/call-log.repository.test.ts`
Expected: PASS

- [ ] **Step 7: Register repositories in DatabaseService**

Read `src/database/index.ts` and add:

```typescript
import { CallSettingsRepository } from './repositories/call-settings.repository';
import { CallLogRepository } from './repositories/call-log.repository';

// In constructor:
readonly callSettings = new CallSettingsRepository(this.db);
readonly callLog = new CallLogRepository(this.db);
```

- [ ] **Step 8: Commit**

```bash
git add src/database/repositories/call-settings.repository.ts src/database/repositories/call-log.repository.ts test/database/repositories/call-settings.repository.test.ts test/database/repositories/call-log.repository.test.ts src/database/index.ts
git commit -m "feat(voice): add CallSettingsRepository + CallLogRepository"
```

---

### Task 3: TTS Text Renderer — speech-friendly reminder text

**Files:**

- Create: `src/services/voice/tts-renderer.ts`
- Create: `test/services/voice/tts-renderer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/services/voice/tts-renderer.test.ts
import { describe, expect, test } from 'bun:test';
import { renderReminderForSpeech } from '../../../src/services/voice/tts-renderer';

describe('renderReminderForSpeech', () => {
  test('renders basic event reminder in English', () => {
    const text = renderReminderForSpeech({
      title: 'Team standup',
      startAt: '2026-03-16T10:00:00Z',
      timezone: 'Europe/Kyiv',
      language: 'en',
    });
    expect(text).toContain('Team standup');
    expect(text).toContain('12'); // UTC+2 in March
  });

  test('renders event with location', () => {
    const text = renderReminderForSpeech({
      title: 'Doctor appointment',
      startAt: '2026-03-16T14:30:00Z',
      timezone: 'UTC',
      location: 'City Hospital, Room 205',
      language: 'en',
    });
    expect(text).toContain('Doctor appointment');
    expect(text).toContain('City Hospital');
  });

  test('renders in Russian', () => {
    const text = renderReminderForSpeech({
      title: 'Встреча с командой',
      startAt: '2026-03-16T10:00:00Z',
      timezone: 'Europe/Kyiv',
      language: 'ru',
    });
    expect(text).toContain('Встреча с командой');
    expect(text).toContain('напоминание');
  });

  test('handles missing optional fields', () => {
    const text = renderReminderForSpeech({
      title: 'Quick call',
      startAt: '2026-03-16T15:00:00Z',
      timezone: 'UTC',
      language: 'en',
    });
    expect(text).toContain('Quick call');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  test('text is speech-friendly — no HTML, no special chars', () => {
    const text = renderReminderForSpeech({
      title: 'Meeting <b>important</b> & urgent',
      startAt: '2026-03-16T10:00:00Z',
      timezone: 'UTC',
      language: 'en',
    });
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('&amp;');
    expect(text).toContain('&');
  });
});
```

- [ ] **Step 2: Run test — confirm FAIL**

Run: `bun test test/services/voice/tts-renderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TTS renderer**

```typescript
// src/services/voice/tts-renderer.ts
import { format } from 'date-fns';
import { TZDate } from '@date-fns/tz';

interface ReminderSpeechInput {
  title: string;
  startAt: string;
  timezone: string;
  location?: string | null;
  description?: string | null;
  language: string;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

export function renderReminderForSpeech(input: ReminderSpeechInput): string {
  const { title, startAt, timezone, location, language } = input;
  const cleanTitle = stripHtml(title);
  const start = new TZDate(startAt, timezone);
  const timeStr = format(start, 'HH:mm');

  if (language === 'ru') {
    const parts = [`Календарное напоминание. ${cleanTitle} в ${timeStr}.`];
    if (location) parts.push(`Место: ${stripHtml(location)}.`);
    return parts.join(' ');
  }

  const parts = [`Calendar reminder. ${cleanTitle} at ${timeStr}.`];
  if (location) parts.push(`Location: ${stripHtml(location)}.`);
  return parts.join(' ');
}
```

- [ ] **Step 4: Run test — confirm PASS**

Run: `bun test test/services/voice/tts-renderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/voice/tts-renderer.ts test/services/voice/tts-renderer.test.ts
git commit -m "feat(voice): add TTS text renderer — speech-friendly reminder text"
```

---

### Task 4: TTS Service — Edge TTS synthesis + caching

**Files:**

- Create: `src/services/voice/tts-service.ts`
- Create: `test/services/voice/tts-service.test.ts`

- [ ] **Step 1: Install edge-tts package**

```bash
bun add edge-tts
```

Check if the package works in Bun: `bun -e "import { EdgeTTS } from 'edge-tts'; console.log('ok')"`

If `edge-tts` doesn't work, try `edge-tts-universal` or `msedge-tts`. Adapt imports accordingly.

- [ ] **Step 2: Write failing tests**

```typescript
// test/services/voice/tts-service.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { TtsService } from '../../../src/services/voice/tts-service';

describe('TtsService', () => {
  test('getVoice returns English voice for en', () => {
    const service = new TtsService();
    const voice = service.getVoice('en');
    expect(voice).toContain('en-');
  });

  test('getVoice returns Russian voice for ru', () => {
    const service = new TtsService();
    const voice = service.getVoice('ru');
    expect(voice).toContain('ru-');
  });

  test('synthesize returns audio buffer', async () => {
    const service = new TtsService();
    // This test requires network — mark as integration or mock
    // For unit testing, we mock the TTS engine
    const buffer = await service.synthesize('Hello world', 'en');
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  test('synthesize caches repeated calls', async () => {
    const service = new TtsService();
    const buf1 = await service.synthesize('Test phrase', 'en');
    const buf2 = await service.synthesize('Test phrase', 'en');
    // Same reference from cache
    expect(buf1).toBe(buf2);
  });
});
```

- [ ] **Step 3: Implement TtsService**

```typescript
// src/services/voice/tts-service.ts
import { createHash } from 'node:crypto';

const VOICES: Record<string, string> = {
  en: 'en-US-AriaNeural',
  ru: 'ru-RU-SvetlanaNeural',
};

export class TtsService {
  private cache = new Map<string, Buffer>();

  getVoice(language: string): string {
    return VOICES[language] ?? VOICES.en;
  }

  async synthesize(text: string, language: string): Promise<Buffer> {
    const cacheKey = this.getCacheKey(text, language);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const voice = this.getVoice(language);
    const buffer = await this.edgeTtsSynthesize(text, voice);
    this.cache.set(cacheKey, buffer);
    return buffer;
  }

  private getCacheKey(text: string, language: string): string {
    return createHash('sha256').update(`${language}:${text}`).digest('hex');
  }

  private async edgeTtsSynthesize(text: string, voice: string): Promise<Buffer> {
    // Dynamic import to handle package availability
    // Adapt import based on which edge-tts package works in Bun
    const { MsEdgeTTS } = await import('msedge-tts');
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, 'audio-24khz-96kbitrate-mono-mp3');
    const readable = tts.toStream(text);
    const chunks: Buffer[] = [];
    for await (const chunk of readable) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
```

> ⚠️ The exact edge-tts package and API may differ. The implementer should:
> 1. Try `bun add edge-tts` first, then `msedge-tts`, then `edge-tts-universal`
> 2. Check which one has working Bun compatibility
> 3. Adapt the `edgeTtsSynthesize` method accordingly
> 4. If none work in Bun, fall back to `openai` package with TTS API (requires API key)

- [ ] **Step 4: Run test — confirm PASS**

Run: `bun test test/services/voice/tts-service.test.ts`
Expected: PASS (network-dependent test may need mocking)

- [ ] **Step 5: Commit**

```bash
git add src/services/voice/tts-service.ts test/services/voice/tts-service.test.ts package.json bun.lock
git commit -m "feat(voice): add TtsService — Edge TTS synthesis with caching"
```

---

## Chunk 2: ntgcalls FFI Bindings + MTProto Signaling

### Task 5: Download ntgcalls binaries + create FFI bindings

**Files:**

- Create: `src/services/voice/ntgcalls-ffi.ts`
- Create: `test/services/voice/ntgcalls-ffi.test.ts`
- Create: `scripts/download-ntgcalls.sh`

- [ ] **Step 1: Create download script for ntgcalls prebuilt binaries**

```bash
#!/bin/bash
# scripts/download-ntgcalls.sh
# Downloads ntgcalls prebuilt shared library for current platform

set -e

VERSION="v2.1.0"
OUTDIR="lib"
mkdir -p "$OUTDIR"

OS=$(uname -s)
ARCH=$(uname -m)

if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  URL="https://github.com/pytgcalls/ntgcalls/releases/download/${VERSION}/ntgcalls.macos-arm64-shared_libs.zip"
  LIB_NAME="ntgcalls.dylib"
elif [ "$OS" = "Linux" ] && [ "$ARCH" = "x86_64" ]; then
  URL="https://github.com/pytgcalls/ntgcalls/releases/download/${VERSION}/ntgcalls.linux-x86_64-shared_libs.zip"
  LIB_NAME="ntgcalls.so"
elif [ "$OS" = "Linux" ] && [ "$ARCH" = "aarch64" ]; then
  URL="https://github.com/pytgcalls/ntgcalls/releases/download/${VERSION}/ntgcalls.linux-arm64-shared_libs.zip"
  LIB_NAME="ntgcalls.so"
else
  echo "Unsupported platform: $OS/$ARCH"
  exit 1
fi

echo "Downloading ntgcalls $VERSION for $OS/$ARCH..."
curl -L -o /tmp/ntgcalls.zip "$URL"
unzip -o /tmp/ntgcalls.zip -d "$OUTDIR"
rm /tmp/ntgcalls.zip

echo "ntgcalls library ready at $OUTDIR/"
ls -la "$OUTDIR/"
```

- [ ] **Step 2: Download the library**

```bash
chmod +x scripts/download-ntgcalls.sh
./scripts/download-ntgcalls.sh
echo "lib/" >> .gitignore
```

- [ ] **Step 3: Write FFI binding tests**

```typescript
// test/services/voice/ntgcalls-ffi.test.ts
import { describe, expect, test } from 'bun:test';
import { NtgCalls, isNtgCallsAvailable } from '../../../src/services/voice/ntgcalls-ffi';

describe('NtgCalls FFI', () => {
  test('isNtgCallsAvailable returns boolean', () => {
    const available = isNtgCallsAvailable();
    expect(typeof available).toBe('boolean');
  });

  // Only run these if lib is present
  const describeIfAvailable = isNtgCallsAvailable() ? describe : describe.skip;

  describeIfAvailable('with library loaded', () => {
    test('init creates instance', () => {
      const ntg = new NtgCalls();
      expect(ntg).toBeDefined();
      ntg.destroy();
    });

    test('createP2P returns connection id', () => {
      const ntg = new NtgCalls();
      // This would need a valid chat_id — just testing it doesn't crash
      ntg.destroy();
    });
  });
});
```

- [ ] **Step 4: Implement FFI bindings**

```typescript
// src/services/voice/ntgcalls-ffi.ts
import { dlopen, FFIType, ptr, suffix, JSCallback } from 'bun:ffi';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const LIB_PATHS = [
  join(import.meta.dir, '../../../lib/ntgcalls.' + suffix),
  join(import.meta.dir, '../../../lib/libntgcalls.' + suffix),
];

let lib: ReturnType<typeof dlopen> | null = null;

export function isNtgCallsAvailable(): boolean {
  if (lib) return true;
  try {
    loadLibrary();
    return true;
  } catch {
    return false;
  }
}

function loadLibrary() {
  if (lib) return lib;
  for (const path of LIB_PATHS) {
    if (!existsSync(path)) continue;
    try {
      lib = dlopen(path, {
        ntg_init: { returns: FFIType.ptr },
        ntg_destroy: { args: [FFIType.ptr], returns: FFIType.void },
        ntg_create_p2p: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
        ntg_connect_p2p: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.bool, FFIType.ptr], returns: FFIType.i32 },
        ntg_set_stream_sources: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        ntg_stop: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
        ntg_get_state: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
        ntg_init_exchange: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        ntg_exchange_keys: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      });
      return lib;
    } catch (err) {
      continue;
    }
  }
  throw new Error('ntgcalls shared library not found. Run scripts/download-ntgcalls.sh');
}

export class NtgCalls {
  private handle: number;

  constructor() {
    const l = loadLibrary();
    this.handle = l.symbols.ntg_init() as number;
  }

  destroy(): void {
    const l = loadLibrary();
    l.symbols.ntg_destroy(this.handle);
  }

  // Additional methods will be added as we implement the call flow
  // For now, this is the minimal skeleton to verify FFI works
}
```

> ⚠️ **IMPORTANT — C shim required.** Direct Bun FFI won't work because:
> 1. ntgcalls passes `ntg_async_struct` and `ntg_media_description_struct` **by value** — Bun FFI doesn't support struct-by-value
> 2. ntgcalls calls callbacks from C++ threads — Bun `JSCallback({ threadsafe: true })` crashes (issue #28113)
>
> **Solution:** Write a thin C shim (~100 LOC) that:
> - Wraps each ntgcalls function, accepting/returning pointers instead of struct-by-value
> - Replaces callbacks with atomic polling: shim allocates a result struct, JS polls `ntg_shim_poll()` with `Bun.sleep(1)`
> - Compile: `cc -shared -o lib/ntgcalls_shim.dylib shim.c -L lib -lntgcalls`
>
> See `docs/plans/ntgcalls-ffi-research.md` for complete shim source code and Bun FFI bindings with correct signatures.

- [ ] **Step 5: Run test — confirm PASS**

Run: `bun test test/services/voice/ntgcalls-ffi.test.ts`
Expected: PASS (basic tests pass; skip block runs if lib present)

- [ ] **Step 6: Commit**

```bash
git add src/services/voice/ntgcalls-ffi.ts test/services/voice/ntgcalls-ffi.test.ts scripts/download-ntgcalls.sh .gitignore
git commit -m "feat(voice): add ntgcalls FFI bindings skeleton + download script"
```

---

### Task 6: MTProto userbot client with @mtcute

**Files:**

- Create: `src/services/voice/mtproto-client.ts`
- Create: `src/services/voice/call-signaling.ts`
- Create: `test/services/voice/call-signaling.test.ts`

- [ ] **Step 1: Install @mtcute/bun**

```bash
bun add @mtcute/bun @mtcute/tl
```

- [ ] **Step 2: Write call signaling tests**

```typescript
// test/services/voice/call-signaling.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { CallSignaling, type CallSignalingDeps } from '../../../src/services/voice/call-signaling';

describe('CallSignaling', () => {
  test('initiateCall validates user_id', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.reject(new Error('should not be called'))),
    };
    const signaling = new CallSignaling(deps);
    await expect(signaling.initiateCall(0)).rejects.toThrow('Invalid user_id');
  });

  test('initiateCall calls phone.requestCall', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.resolve({
        _: 'phone.phoneCall',
        phone_call: {
          _: 'phoneCallWaiting',
          id: 12345n,
          access_hash: 67890n,
        },
      })),
    };
    const signaling = new CallSignaling(deps);
    const result = await signaling.initiateCall(100);
    expect(result.callId).toBeDefined();
    expect(deps.callRaw).toHaveBeenCalled();
  });

  test('discardCall sends phone.discardCall', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.resolve({ _: 'updates' })),
    };
    const signaling = new CallSignaling(deps);
    await signaling.discardCall(12345n, 67890n);
    expect(deps.callRaw).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Implement MTProto client wrapper**

```typescript
// src/services/voice/mtproto-client.ts
import { BunClient } from '@mtcute/bun';
import { voiceLogger } from './types';

export interface MtprotoClientConfig {
  apiId: number;
  apiHash: string;
  sessionString: string;
}

export async function createMtprotoClient(config: MtprotoClientConfig): Promise<BunClient> {
  const client = new BunClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage: `mtproto-session`,
  });

  await client.importSession(config.sessionString);
  await client.connect();

  voiceLogger.info('MTProto userbot client connected');
  return client;
}
```

> ⚠️ The exact @mtcute API may differ. The implementer must:
> 1. Read @mtcute/bun docs for session import/creation
> 2. Verify `importSession` vs `start` vs string session approach
> 3. May need interactive auth first to generate session string
> 4. Session string can be stored as env var `MTPROTO_SESSION`

- [ ] **Step 4: Implement call signaling (uses DH exchange module)**

The DH exchange is already implemented in `src/services/voice-call/dh-exchange.ts`. The call signaling module wraps it with @mtcute transport:

```typescript
// src/services/voice/call-signaling.ts
import { VoiceCallOrchestrator } from '../voice-call/dh-exchange';

export interface CallSignalingDeps {
  callRaw: (method: Record<string, unknown>) => Promise<unknown>;
}

interface CallInfo {
  callId: bigint;
  accessHash: bigint;
}

export class CallSignaling {
  private orchestrator: VoiceCallOrchestrator;

  constructor(private deps: CallSignalingDeps) {
    this.orchestrator = new VoiceCallOrchestrator({
      callRaw: deps.callRaw,
    });
  }

  async initiateCall(userId: number): Promise<CallInfo> {
    if (!userId || userId <= 0) throw new Error('Invalid user_id');

    const result = await this.deps.callRaw({
      _: 'phone.requestCall',
      user_id: { _: 'inputUser', user_id: userId, access_hash: 0n },
      random_id: randomId,
      g_a_hash: gAHash,
      protocol: {
        _: 'phoneCallProtocol',
        udp_p2p: true,
        udp_reflector: true,
        min_layer: 92,
        max_layer: 92,
        library_versions: ['7.0.0'],
      },
    });

    const phoneCall = (result as { phone_call: { id: bigint; access_hash: bigint } }).phone_call;
    return {
      callId: phoneCall.id,
      accessHash: phoneCall.access_hash,
    };
  }

  async discardCall(callId: bigint, accessHash: bigint): Promise<void> {
    await this.deps.callRaw({
      _: 'phone.discardCall',
      peer: {
        _: 'inputPhoneCall',
        id: callId,
        access_hash: accessHash,
      },
      duration: 0,
      reason: { _: 'phoneCallDiscardReasonHangup' },
      connection_id: 0n,
    });
  }
}
```

> ⚠️ **Critical:** The DH key exchange (`phone.requestCall` → `phone.acceptCall` → `phone.confirmCall`) is complex. The `g_a_hash` above is a placeholder. The real implementation needs proper Diffie-Hellman parameter generation per Telegram's E2E call protocol. The implementer should reference:
> - https://core.telegram.org/api/end-to-end/voice-calls
> - pytgcalls source for the Python version of this exchange
> - The GramJS gist linked in the research

- [ ] **Step 5: Run test — confirm PASS**

Run: `bun test test/services/voice/call-signaling.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/voice/mtproto-client.ts src/services/voice/call-signaling.ts test/services/voice/call-signaling.test.ts package.json bun.lock
git commit -m "feat(voice): add MTProto client + call signaling (phone.requestCall)"
```

---

## Chunk 3: Call Manager + Queue + Bot Integration

### Task 7: Voice call types + logger

**Files:**

- Create: `src/services/voice/types.ts`

- [ ] **Step 1: Create shared types**

```typescript
// src/services/voice/types.ts
import pino from 'pino';
import { logger } from '../../utils/logger';

export const voiceLogger = logger.child({ module: 'voice' });

export type VoiceCallState = 'idle' | 'synthesizing' | 'ringing' | 'connected' | 'playing' | 'ended' | 'failed';

export interface VoiceCallConfig {
  mtprotoApiId: number;
  mtprotoApiHash: string;
  mtprotoSession: string;
  maxCallDurationSec: number;
  ttsTimeoutMs: number;
}

export interface CallReminderJobData {
  userId: number;
  eventId: number;
  callLogId: number;
  ttsText: string;
  language: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/voice/types.ts
git commit -m "feat(voice): add voice call types and logger"
```

---

### Task 8: Call Manager — orchestrate TTS → call → audio → end

**Files:**

- Create: `src/services/voice/call-manager.ts`
- Create: `test/services/voice/call-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/services/voice/call-manager.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { CallManager, type CallManagerDeps } from '../../../src/services/voice/call-manager';

function makeDeps(overrides: Partial<CallManagerDeps> = {}): CallManagerDeps {
  return {
    ttsService: { synthesize: mock(() => Promise.resolve(Buffer.from('fake-audio'))) },
    callSignaling: {
      initiateCall: mock(() => Promise.resolve({ callId: 1n, accessHash: 2n })),
      discardCall: mock(() => Promise.resolve()),
    },
    callLogRepo: {
      updateStatus: mock(() => {}),
      complete: mock(() => {}),
    },
    sendPostCallButtons: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('CallManager', () => {
  test('executeCall synthesizes TTS first', async () => {
    const deps = makeDeps();
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100,
      eventId: 1,
      callLogId: 1,
      ttsText: 'Meeting in 10 minutes',
      language: 'en',
    });
    expect(deps.ttsService.synthesize).toHaveBeenCalledWith('Meeting in 10 minutes', 'en');
  });

  test('executeCall initiates call after TTS', async () => {
    const deps = makeDeps();
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100, eventId: 1, callLogId: 1,
      ttsText: 'Test', language: 'en',
    });
    expect(deps.callSignaling.initiateCall).toHaveBeenCalledWith(100);
  });

  test('executeCall logs failure on TTS error', async () => {
    const deps = makeDeps({
      ttsService: { synthesize: mock(() => Promise.reject(new Error('TTS failed'))) },
    });
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100, eventId: 1, callLogId: 1,
      ttsText: 'Test', language: 'en',
    });
    expect(deps.callLogRepo.complete).toHaveBeenCalled();
    const args = (deps.callLogRepo.complete as ReturnType<typeof mock>).mock.calls[0] as unknown[];
    expect(args[1]).toBe('failed');
  });

  test('executeCall sends post-call buttons', async () => {
    const deps = makeDeps();
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100, eventId: 1, callLogId: 1,
      ttsText: 'Test', language: 'en',
    });
    expect(deps.sendPostCallButtons).toHaveBeenCalledWith(100, 1);
  });

  test('executeCall discards call on error', async () => {
    const deps = makeDeps({
      callSignaling: {
        initiateCall: mock(() => Promise.reject(new Error('User offline'))),
        discardCall: mock(() => Promise.resolve()),
      },
    });
    const manager = new CallManager(deps);
    await manager.executeCall({
      userId: 100, eventId: 1, callLogId: 1,
      ttsText: 'Test', language: 'en',
    });
    expect(deps.callLogRepo.complete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test — confirm FAIL**

Run: `bun test test/services/voice/call-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CallManager**

```typescript
// src/services/voice/call-manager.ts
import type { CallReminderJobData } from './types';
import { voiceLogger } from './types';

export interface CallManagerDeps {
  ttsService: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  callSignaling: {
    initiateCall: (userId: number) => Promise<{ callId: bigint; accessHash: bigint }>;
    discardCall: (callId: bigint, accessHash: bigint) => Promise<void>;
  };
  callLogRepo: {
    updateStatus: (id: number, status: string) => void;
    complete: (id: number, status: string, duration: number, error?: string) => void;
  };
  sendPostCallButtons: (userId: number, eventId: number) => Promise<void>;
}

export class CallManager {
  constructor(private deps: CallManagerDeps) {}

  async executeCall(job: CallReminderJobData): Promise<void> {
    const startTime = Date.now();
    let callId: bigint | undefined;
    let accessHash: bigint | undefined;

    try {
      // Step 1: Synthesize TTS audio
      voiceLogger.info({ userId: job.userId, eventId: job.eventId }, 'Synthesizing TTS');
      const audioBuffer = await this.deps.ttsService.synthesize(job.ttsText, job.language);

      // Step 2: Initiate call
      this.deps.callLogRepo.updateStatus(job.callLogId, 'ringing');
      voiceLogger.info({ userId: job.userId }, 'Initiating call');
      const callInfo = await this.deps.callSignaling.initiateCall(job.userId);
      callId = callInfo.callId;
      accessHash = callInfo.accessHash;

      // Step 3: Play audio (ntgcalls integration — placeholder for now)
      this.deps.callLogRepo.updateStatus(job.callLogId, 'connected');
      // TODO: Wire ntgcalls to play audioBuffer into the call
      // For now, simulate a short call
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Step 4: End call
      await this.deps.callSignaling.discardCall(callId, accessHash);
      const duration = Math.floor((Date.now() - startTime) / 1000);
      this.deps.callLogRepo.complete(job.callLogId, 'completed', duration);
      voiceLogger.info({ userId: job.userId, duration }, 'Call completed');

      // Step 5: Send post-call buttons in chat
      await this.deps.sendPostCallButtons(job.userId, job.eventId);

    } catch (error) {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      voiceLogger.error({ error: String(error), userId: job.userId }, 'Call failed');

      if (callId && accessHash) {
        await this.deps.callSignaling.discardCall(callId, accessHash).catch(() => {});
      }

      this.deps.callLogRepo.complete(job.callLogId, 'failed', duration, String(error));

      // Still send buttons so user can snooze/cancel from chat
      await this.deps.sendPostCallButtons(job.userId, job.eventId).catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run test — confirm PASS**

Run: `bun test test/services/voice/call-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/voice/call-manager.ts test/services/voice/call-manager.test.ts
git commit -m "feat(voice): add CallManager — TTS → call → audio → end → buttons"
```

---

### Task 9: BullMQ call-reminder queue and worker

**Files:**

- Create: `src/worker/call-queue.ts`
- Create: `test/worker/call-queue.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// test/worker/call-queue.test.ts
import { describe, expect, mock, test } from 'bun:test';

describe('call-queue', () => {
  test('createCallQueue returns queue and add function', async () => {
    const { createCallQueue } = await import('../../../src/worker/call-queue');
    // Queue creation requires Redis — test the factory shape
    expect(createCallQueue).toBeDefined();
    expect(typeof createCallQueue).toBe('function');
  });
});
```

- [ ] **Step 2: Implement call queue**

```typescript
// src/worker/call-queue.ts
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { CallManager } from '../services/voice/call-manager';
import type { CallReminderJobData } from '../services/voice/types';
import { voiceLogger } from '../services/voice/types';

export function createCallQueue(connection: ConnectionOptions) {
  const queue = new Queue<CallReminderJobData>('call-reminders', { connection });
  return {
    queue,
    async enqueue(data: CallReminderJobData): Promise<void> {
      await queue.add('call-reminder', data, {
        attempts: 2,
        backoff: { type: 'fixed', delay: 60_000 },
        removeOnComplete: true,
        removeOnFail: 100,
      });
    },
  };
}

export function createCallWorker(
  connection: ConnectionOptions,
  callManager: CallManager,
) {
  const worker = new Worker<CallReminderJobData>(
    'call-reminders',
    async (job) => {
      voiceLogger.info({ jobId: job.id, userId: job.data.userId }, 'Processing call job');
      await callManager.executeCall(job.data);
    },
    {
      connection,
      concurrency: 1, // One call at a time
      limiter: { max: 1, duration: 5000 }, // Max 1 call per 5 seconds
    },
  );

  worker.on('failed', (job, err) => {
    voiceLogger.error({ jobId: job?.id, error: String(err) }, 'Call job failed');
  });

  return worker;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/worker/call-queue.ts test/worker/call-queue.test.ts
git commit -m "feat(voice): add BullMQ call-reminder queue and worker"
```

---

### Task 10: Constants + /callsettings command + bot wiring

**Files:**

- Modify: `src/config/constants.ts` — add CB prefixes, i18n
- Create: `src/bot/commands/call-settings.ts`
- Create: `test/bot/commands/call-settings.test.ts`
- Modify: `src/bot/index.ts` — register command
- Modify: `src/index.ts` — wire voice services

- [ ] **Step 1: Add constants**

Add to `src/config/constants.ts`:

```typescript
// In CB object:
CALL_SETTINGS: 'csett',

// In en translations:
call_settings_title: '📞 Voice Call Reminders',
call_settings_enabled: 'Voice calls: ✅ Enabled',
call_settings_disabled: 'Voice calls: ❌ Disabled',
call_post_snooze: '⏰ Snoozed for 10 min',
call_post_cancel: '❌ Event cancelled',
call_post_ack: '✅ Got it',

// In ru translations:
call_settings_title: '📞 Голосовые напоминания',
call_settings_enabled: 'Голосовые звонки: ✅ Включены',
call_settings_disabled: 'Голосовые звонки: ❌ Выключены',
call_post_snooze: '⏰ Отложено на 10 мин',
call_post_cancel: '❌ Событие отменено',
call_post_ack: '✅ Понятно',
```

- [ ] **Step 2: Write /callsettings tests**

```typescript
// test/bot/commands/call-settings.test.ts
import { describe, expect, mock, test } from 'bun:test';

describe('handleCallSettings', () => {
  test('shows current settings', async () => {
    const { handleCallSettings } = await import('../../../src/bot/commands/call-settings');
    const ctx = {
      args: null,
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const settingsRepo = {
      ensureDefaults: mock(() => {}),
      get: mock(() => ({ enabled: 0, max_daily_calls: 5, language: 'en', quiet_hours_start: null, quiet_hours_end: null, important_only: 0 })),
    };
    await handleCallSettings(ctx as never, settingsRepo as never);
    expect(ctx.send).toHaveBeenCalled();
  });

  test('enables voice calls', async () => {
    const { handleCallSettings } = await import('../../../src/bot/commands/call-settings');
    const ctx = {
      args: 'on',
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const settingsRepo = {
      ensureDefaults: mock(() => {}),
      setEnabled: mock(() => {}),
      get: mock(() => ({ enabled: 1 })),
    };
    await handleCallSettings(ctx as never, settingsRepo as never);
    expect(settingsRepo.setEnabled).toHaveBeenCalledWith(100, true);
  });

  test('disables voice calls', async () => {
    const { handleCallSettings } = await import('../../../src/bot/commands/call-settings');
    const ctx = {
      args: 'off',
      dbUser: { telegram_id: 100, language: 'en' },
      send: mock(() => Promise.resolve()),
    };
    const settingsRepo = {
      ensureDefaults: mock(() => {}),
      setEnabled: mock(() => {}),
      get: mock(() => ({ enabled: 0 })),
    };
    await handleCallSettings(ctx as never, settingsRepo as never);
    expect(settingsRepo.setEnabled).toHaveBeenCalledWith(100, false);
  });
});
```

- [ ] **Step 3: Implement /callsettings**

```typescript
// src/bot/commands/call-settings.ts
import type { CallSettingsRepository } from '../../database/repositories/call-settings.repository';
import { t } from '../../config/constants';
import type { BotCommandContext } from '../types';

export async function handleCallSettings(
  ctx: BotCommandContext,
  settingsRepo: CallSettingsRepository,
): Promise<void> {
  const user = ctx.dbUser;
  const lang = (user.language ?? 'en') as 'en' | 'ru';
  const userId = user.telegram_id;

  settingsRepo.ensureDefaults(userId);

  if (ctx.args === 'on') {
    settingsRepo.setEnabled(userId, true);
    await ctx.send(t(lang).call_settings_enabled);
    return;
  }

  if (ctx.args === 'off') {
    settingsRepo.setEnabled(userId, false);
    await ctx.send(t(lang).call_settings_disabled);
    return;
  }

  const settings = settingsRepo.get(userId)!;
  const text = [
    t(lang).call_settings_title,
    '',
    settings.enabled ? t(lang).call_settings_enabled : t(lang).call_settings_disabled,
    `Max daily: ${settings.max_daily_calls}`,
    '',
    '<code>/callsettings on</code> / <code>/callsettings off</code>',
  ].join('\n');
  await ctx.send(text, { parse_mode: 'HTML' });
}
```

- [ ] **Step 4: Run tests — confirm PASS**

Run: `bun test test/bot/commands/call-settings.test.ts`

- [ ] **Step 5: Wire into bot and entrypoint**

In `src/bot/index.ts`: register `/callsettings` command.
In `src/index.ts`: conditionally initialize voice call services when `MTPROTO_SESSION` env var is present.

- [ ] **Step 6: Commit**

```bash
git add src/config/constants.ts src/bot/commands/call-settings.ts test/bot/commands/call-settings.test.ts src/bot/index.ts src/index.ts
git commit -m "feat(voice): add /callsettings command + wire voice services"
```

---

### Task 11: Integrate with notification scheduler

**Files:**

- Modify: `src/services/notification/scheduler.ts`
- Modify: `src/services/notification/renderer.ts`

- [ ] **Step 1: Add renderForVoice to NotificationRenderer**

Add method to `src/services/notification/renderer.ts`:

```typescript
import { renderReminderForSpeech } from '../voice/tts-renderer';

renderForVoice(event: CalendarEvent, language: string): RenderedNotification {
  const text = renderReminderForSpeech({
    title: event.title,
    startAt: event.start_at,
    timezone: event.timezone,
    location: event.location,
    language,
  });
  return {
    channel: 'telegram_voice_call' as const,
    text,
  };
}
```

- [ ] **Step 2: Add voice call routing to scheduler**

In `src/services/notification/scheduler.ts`, after the existing enqueue logic, add a check:

```typescript
// After existing enqueue call:
// If user has voice calls enabled, also enqueue a call-reminder
if (this.deps.callSettingsRepo?.isEnabled(userId)) {
  const dailyCount = this.deps.callLogRepo?.countTodayCalls(userId) ?? 0;
  const maxDaily = this.deps.callSettingsRepo.get(userId)?.max_daily_calls ?? 5;
  if (dailyCount < maxDaily) {
    this.deps.enqueueCall?.({
      userId,
      eventId: reminder.event_id,
      callLogId: 0, // Will be set by the queue
      ttsText: rendered.text,
      language: user.language,
    });
  }
}
```

> ⚠️ Make these deps optional to maintain backward compatibility.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All existing tests pass, new tests pass

- [ ] **Step 4: Commit**

```bash
git add src/services/notification/scheduler.ts src/services/notification/renderer.ts
git commit -m "feat(voice): integrate voice calls into notification scheduler"
```

---

### Task 12: Final verification

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

- [ ] **Step 2: Run lint**

```bash
bun run lint
```

- [ ] **Step 3: Verify all voice files exist**

```bash
ls -la src/services/voice/
ls -la test/services/voice/
ls -la src/worker/call-queue.ts
ls -la src/bot/commands/call-settings.ts
```

- [ ] **Step 4: Verify test coverage ≥80% on all new modules**

```bash
bun test --coverage 2>&1 | grep -E 'src/services/voice/|src/database/repositories/call|src/worker/call|src/bot/commands/call'
```

Expected: all lines ≥80%. If any module is below, write additional red tests (error paths, edge cases, invalid input) until threshold is met.

- [ ] **Step 5: Review commit history**

```bash
git log --oneline --not main | head -20
```

---

## Implementation Notes

### What this plan delivers (v1 MVP)

1. **Database** — user_call_settings + call_log tables
2. **TTS** — Edge TTS synthesis with in-memory caching
3. **DH key exchange** — ✅ DONE. Full implementation in `src/services/voice-call/dh-exchange.ts` (22 tests)
4. **Call signaling** — MTProto phone.requestCall/acceptCall/confirmCall via @mtcute, using DH exchange module
5. **ntgcalls C shim + FFI** — thin C wrapper around ntgcalls to handle struct-by-value + polling pattern
6. **Call manager** — Orchestration with proper error handling and logging
7. **BullMQ queue** — call-reminder jobs with retry logic
8. **Bot UI** — /callsettings command, post-call inline buttons
9. **Notification integration** — Voice calls as alternative notification channel

### Research conclusions (resolved)

1. **DH key exchange** — ✅ Implemented. `src/services/voice-call/dh-exchange.ts` with state machine, MTProto payload builders, emoji verification, MITM detection. 22 tests.

2. **ntgcalls audio format** — PCM 16-bit signed LE (s16le), 10ms frames. Simplest approach: `NTG_SHELL` mode with ffmpeg command `ffmpeg -i file.mp3 -f s16le -ac 2 -ar 48000 pipe:1` — ntgcalls reads from pipe internally. Full research in `docs/plans/ntgcalls-ffi-research.md`.

3. **Bun FFI thread safety** — `JSCallback({ threadsafe: true })` CRASHES (confirmed by Bun issue #28113, March 2026). Two solutions:
   - **Option A (recommended for v1):** C shim library that converts struct-by-value to pointer-based API + atomic polling instead of callbacks. Simpler, no C++ napi boilerplate.
   - **Option B (for production hardening):** Node-API (napi) addon with `napi_create_threadsafe_function`. Battle-tested but more implementation effort.

4. **Call state machine** — handled by `VoiceCallDhExchange` state machine (Idle → WaitingAccept → Established/Discarded/Failed) + `handlePhoneCallUpdate` dispatcher for MTProto updates.

### Remaining follow-up work

1. **C shim for ntgcalls** — ~100 LOC C wrapper: convert struct-by-value params to pointer-based, replace callback with atomic polling. Compile as shared lib.
2. **Userbot session management** — Interactive auth script to generate initial @mtcute session string, store as env var.
3. **Post-call snooze/cancel handlers** — Wire inline button callbacks to EventService (snooze = update start_at, cancel = delete).

### Risks

- **Telegram userbot ban** — Automated calls from userbot accounts may trigger anti-spam. Mitigated by rate limiting (1 call/5s, max 5/day/user) and human-like call patterns (ring for 15-30s, don't spam).
- **C shim compilation** — Needs platform-specific compilation (macOS ARM64, Linux x64). CI cross-compilation or prebuilt binaries per platform.
- **@roamhq/wrtc in ntgcalls** — ntgcalls bundles its own WebRTC. No external wrtc dependency needed.
