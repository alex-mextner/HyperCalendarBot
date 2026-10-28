> Part 1 of 3 of [Voice Call Reminders — Implementation Plan](../2026-03-16-voice-call-reminders.md) — next: [02-tasks-5-6.md](02-tasks-5-6.md)

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

