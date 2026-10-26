> Part 2 of 4 of [Notifications Implementation Plan](../2026-03-13-notifications.md) — previous: [01-tasks-1-5.md](01-tasks-1-5.md) · next: [03-tasks-10-12.md](03-tasks-10-12.md)

## Chunk 2: Core Services

### Task 6: Timezone Utilities for Notifications

**Files:**
- Create: `src/services/notification/timezone.ts`
- Create: `test/services/notification/timezone.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/services/notification/timezone.test.ts
import { describe, test, expect } from 'bun:test';
import {
  getUserLocalTime,
  isTimeMatch,
  localTimeToUtcHHMM,
  isQuietHours,
} from '../../../src/services/notification/timezone.ts';

describe('timezone utilities', () => {
  describe('getUserLocalTime', () => {
    test('converts UTC to Moscow time (+3)', () => {
      const utc = new Date('2026-03-15T05:30:00Z');
      const local = getUserLocalTime(utc, 'Europe/Moscow');
      expect(local.hours).toBe(8);
      expect(local.minutes).toBe(30);
    });

    test('converts UTC to NY time (-4 in DST)', () => {
      const utc = new Date('2026-07-15T14:00:00Z');
      const local = getUserLocalTime(utc, 'America/New_York');
      expect(local.hours).toBe(10);
      expect(local.minutes).toBe(0);
    });
  });

  describe('isTimeMatch', () => {
    test('matches when local time equals target', () => {
      // Moscow is UTC+3, so 05:00 UTC = 08:00 Moscow
      const utc = new Date('2026-03-15T05:00:00Z');
      expect(isTimeMatch(utc, 'Europe/Moscow', '08:00')).toBe(true);
    });

    test('does not match different time', () => {
      const utc = new Date('2026-03-15T05:00:00Z');
      expect(isTimeMatch(utc, 'Europe/Moscow', '09:00')).toBe(false);
    });
  });

  describe('localTimeToUtcHHMM', () => {
    test('converts Moscow 08:00 to UTC 05:00', () => {
      expect(localTimeToUtcHHMM('08:00', 'Europe/Moscow')).toBe('05:00');
    });

    test('handles UTC+0 timezone', () => {
      expect(localTimeToUtcHHMM('08:00', 'UTC')).toBe('08:00');
    });

    test('handles wrap-around past midnight', () => {
      // Tokyo is UTC+9, so 02:00 local = 17:00 UTC (previous day)
      expect(localTimeToUtcHHMM('02:00', 'Asia/Tokyo')).toBe('17:00');
    });
  });

  describe('isQuietHours', () => {
    test('returns false when quiet hours disabled', () => {
      const result = isQuietHours(
        { enabled: false, start: null, end: null },
        new Date('2026-03-15T02:00:00Z'),
        'UTC',
      );
      expect(result).toBe(false);
    });

    test('detects quiet hours same-day range', () => {
      // 13:00–15:00 UTC, current time 14:00 UTC
      const result = isQuietHours(
        { enabled: true, start: '13:00', end: '15:00' },
        new Date('2026-03-15T14:00:00Z'),
        'UTC',
      );
      expect(result).toBe(true);
    });

    test('detects quiet hours midnight-spanning range', () => {
      // 23:00–07:00 local, current time 02:00 local (02:00 UTC for UTC tz)
      const result = isQuietHours(
        { enabled: true, start: '23:00', end: '07:00' },
        new Date('2026-03-15T02:00:00Z'),
        'UTC',
      );
      expect(result).toBe(true);
    });

    test('returns false outside quiet hours', () => {
      const result = isQuietHours(
        { enabled: true, start: '23:00', end: '07:00' },
        new Date('2026-03-15T12:00:00Z'),
        'UTC',
      );
      expect(result).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/services/notification/timezone.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement timezone utilities**

```typescript
// src/services/notification/timezone.ts
import { TZDate } from '@date-fns/tz';

export function getUserLocalTime(
  utcNow: Date,
  timezone: string,
): { hours: number; minutes: number } {
  const local = new TZDate(utcNow, timezone);
  return { hours: local.getHours(), minutes: local.getMinutes() };
}

export function isTimeMatch(
  utcNow: Date,
  timezone: string,
  targetHHMM: string,
): boolean {
  const local = getUserLocalTime(utcNow, timezone);
  const [targetH, targetM] = targetHHMM.split(':').map(Number);
  return local.hours === targetH && local.minutes === targetM;
}

export function localTimeToUtcHHMM(localHHMM: string, timezone: string): string {
  const [h, m] = localHHMM.split(':').map(Number);
  // Use a reference date to compute the offset
  const refDate = new Date('2026-06-15T12:00:00Z');
  const localDate = new TZDate(refDate, timezone);
  const offsetMs = localDate.getTimezoneOffset() * -60_000;
  // Convert local HH:MM to UTC
  const localMinutes = h! * 60 + m!;
  const offsetMinutes = offsetMs / 60_000;
  let utcMinutes = localMinutes - offsetMinutes;
  if (utcMinutes < 0) utcMinutes += 1440;
  if (utcMinutes >= 1440) utcMinutes -= 1440;
  const utcH = Math.floor(utcMinutes / 60);
  const utcM = utcMinutes % 60;
  return `${String(utcH).padStart(2, '0')}:${String(utcM).padStart(2, '0')}`;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string | null;
  end: string | null;
}

export function isQuietHours(
  config: QuietHoursConfig,
  utcNow: Date,
  timezone: string,
): boolean {
  if (!config.enabled || !config.start || !config.end) return false;

  const local = getUserLocalTime(utcNow, timezone);
  const currentMinutes = local.hours * 60 + local.minutes;

  const [startH, startM] = config.start.split(':').map(Number);
  const [endH, endM] = config.end.split(':').map(Number);
  const startMinutes = startH! * 60 + startM!;
  const endMinutes = endH! * 60 + endM!;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Spans midnight
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/services/notification/timezone.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notification/timezone.ts test/services/notification/timezone.test.ts
git commit -m "feat: add notification timezone utilities"
```

---

### Task 7: NotificationPreferencesService

**Files:**
- Create: `src/services/notification/preferences.ts`
- Create: `test/services/notification/preferences.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/services/notification/preferences.test.ts
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach } from 'bun:test';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';

describe('NotificationPreferencesService', () => {
  let db: Database;
  let repo: NotificationPreferencesRepository;
  let service: NotificationPreferencesService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE notification_preferences (
      user_id INTEGER PRIMARY KEY,
      morning_agenda_enabled INTEGER NOT NULL DEFAULT 1,
      morning_agenda_time TEXT NOT NULL DEFAULT '08:00',
      morning_agenda_utc TEXT,
      morning_agenda_format TEXT NOT NULL DEFAULT 'text',
      default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
      evening_review_enabled INTEGER NOT NULL DEFAULT 0,
      evening_review_time TEXT NOT NULL DEFAULT '21:00',
      evening_review_utc TEXT,
      evening_review_format TEXT NOT NULL DEFAULT 'text',
      quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
      quiet_hours_start TEXT,
      quiet_hours_end TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id, timezone) VALUES (42, 'Europe/Moscow')");
    repo = new NotificationPreferencesRepository(db);
    service = new NotificationPreferencesService(repo);
  });

  test('getOrCreate creates defaults and returns them', () => {
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_enabled).toBe(1);
    expect(prefs.morning_agenda_time).toBe('08:00');
  });

  test('getOrCreate returns existing prefs on second call', () => {
    service.getOrCreate(42);
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_enabled).toBe(1);
  });

  test('resolveDefaultIntervals parses JSON', () => {
    service.getOrCreate(42);
    const intervals = service.resolveDefaultIntervals(42);
    expect(intervals).toEqual([15]);
  });

  test('updateMorningTime updates time and recomputes UTC', () => {
    service.getOrCreate(42);
    service.updateMorningTime(42, '09:00', 'Europe/Moscow');
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_time).toBe('09:00');
    expect(prefs.morning_agenda_utc).toBe('06:00');
  });

  test('toggleMorningAgenda flips enabled flag', () => {
    service.getOrCreate(42);
    service.toggleMorningAgenda(42);
    const prefs = service.getOrCreate(42);
    expect(prefs.morning_agenda_enabled).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/notification/preferences.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the service**

```typescript
// src/services/notification/preferences.ts
import type {
  NotificationPreferencesRepository,
  NotificationPreferencesRow,
} from '../../database/repositories/notification-preferences.repository.ts';
import { localTimeToUtcHHMM } from './timezone.ts';

export class NotificationPreferencesService {
  constructor(private repo: NotificationPreferencesRepository) {}

  getOrCreate(userId: number): NotificationPreferencesRow {
    this.repo.ensureDefaults(userId);
    return this.repo.get(userId)!;
  }

  resolveDefaultIntervals(userId: number): number[] {
    const prefs = this.getOrCreate(userId);
    return JSON.parse(prefs.default_reminder_intervals) as number[];
  }

  updateMorningTime(userId: number, time: string, timezone: string): void {
    const utc = localTimeToUtcHHMM(time, timezone);
    this.repo.update(userId, { morning_agenda_time: time, morning_agenda_utc: utc });
  }

  updateEveningTime(userId: number, time: string, timezone: string): void {
    const utc = localTimeToUtcHHMM(time, timezone);
    this.repo.update(userId, { evening_review_time: time, evening_review_utc: utc });
  }

  toggleMorningAgenda(userId: number): void {
    const prefs = this.getOrCreate(userId);
    this.repo.update(userId, { morning_agenda_enabled: prefs.morning_agenda_enabled ? 0 : 1 });
  }

  toggleEveningReview(userId: number): void {
    const prefs = this.getOrCreate(userId);
    this.repo.update(userId, { evening_review_enabled: prefs.evening_review_enabled ? 0 : 1 });
  }

  toggleQuietHours(userId: number): void {
    const prefs = this.getOrCreate(userId);
    this.repo.update(userId, { quiet_hours_enabled: prefs.quiet_hours_enabled ? 0 : 1 });
  }

  updateQuietHoursStart(userId: number, time: string): void {
    this.repo.update(userId, { quiet_hours_start: time });
  }

  updateQuietHoursEnd(userId: number, time: string): void {
    this.repo.update(userId, { quiet_hours_end: time });
  }

  updateDefaultIntervals(userId: number, intervals: number[]): void {
    this.repo.update(userId, { default_reminder_intervals: JSON.stringify(intervals) });
  }

  recomputeUtcTimes(userId: number, timezone: string): void {
    const prefs = this.getOrCreate(userId);
    const morningUtc = localTimeToUtcHHMM(prefs.morning_agenda_time, timezone);
    const eveningUtc = localTimeToUtcHHMM(prefs.evening_review_time, timezone);
    this.repo.update(userId, { morning_agenda_utc: morningUtc, evening_review_utc: eveningUtc });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/notification/preferences.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notification/preferences.ts test/services/notification/preferences.test.ts
git commit -m "feat: add NotificationPreferencesService"
```

---

### Task 8: ReminderMaterializer

**Files:**
- Create: `src/services/notification/materializer.ts`
- Create: `test/services/notification/materializer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/services/notification/materializer.test.ts
import { Database } from 'bun:sqlite';
import { describe, test, expect, beforeEach } from 'bun:test';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { ReminderMaterializer } from '../../../src/services/notification/materializer.ts';

describe('ReminderMaterializer', () => {
  let db: Database;
  let reminderRepo: EventReminderRepository;
  let prefsRepo: NotificationPreferencesRepository;
  let materializer: ReminderMaterializer;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      start_at TEXT NOT NULL,
      reminder_overrides TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      all_day INTEGER NOT NULL DEFAULT 0,
      is_cancelled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE notification_preferences (
      user_id INTEGER PRIMARY KEY,
      morning_agenda_enabled INTEGER NOT NULL DEFAULT 1,
      morning_agenda_time TEXT NOT NULL DEFAULT '08:00',
      morning_agenda_utc TEXT,
      morning_agenda_format TEXT NOT NULL DEFAULT 'text',
      default_reminder_intervals TEXT NOT NULL DEFAULT '[15]',
      evening_review_enabled INTEGER NOT NULL DEFAULT 0,
      evening_review_time TEXT NOT NULL DEFAULT '21:00',
      evening_review_utc TEXT,
      evening_review_format TEXT NOT NULL DEFAULT 'text',
      quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
      quiet_hours_start TEXT,
      quiet_hours_end TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run(`CREATE TABLE event_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      remind_at_utc TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      interval_label TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
    )`);
    db.run("INSERT INTO users (telegram_id) VALUES (42)");
    reminderRepo = new EventReminderRepository(db);
    prefsRepo = new NotificationPreferencesRepository(db);
    prefsRepo.ensureDefaults(42);
    materializer = new ReminderMaterializer(reminderRepo, prefsRepo);
  });

  test('materializes reminders using default intervals', () => {
    // Event in the future
    db.run(
      "INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2099-03-15T10:00:00Z')",
    );
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: null },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interval_minutes).toBe(15);
    expect(rows[0]!.remind_at_utc).toBe('2099-03-15T09:45:00.000Z');
  });

  test('uses event-level overrides when present', () => {
    db.run(
      "INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2099-03-15T10:00:00Z')",
    );
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: '[5, 60]' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(2);
    const minutes = rows.map((r) => r.interval_minutes).sort((a, b) => a - b);
    expect(minutes).toEqual([5, 60]);
  });

  test('skips reminders in the past', () => {
    db.run(
      "INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Old', '2020-01-01T10:00:00Z')",
    );
    materializer.materialize(
      { id: 1, start_at: '2020-01-01T10:00:00Z', reminder_overrides: null },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(0);
  });

  test('re-materializing replaces old reminders', () => {
    db.run(
      "INSERT INTO events (id, user_id, title, start_at) VALUES (1, 42, 'Meeting', '2099-03-15T10:00:00Z')",
    );
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: null },
      42,
    );
    materializer.materialize(
      { id: 1, start_at: '2099-03-15T10:00:00Z', reminder_overrides: '[5]' },
      42,
    );
    const rows = reminderRepo.getForEvent(1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interval_minutes).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/notification/materializer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the materializer**

```typescript
// src/services/notification/materializer.ts
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';

const INTERVAL_LABELS: Record<number, string> = {
  5: '5 minutes',
  10: '10 minutes',
  15: '15 minutes',
  30: '30 minutes',
  60: '1 hour',
  120: '2 hours',
  1440: '1 day',
};

function formatIntervalLabel(minutes: number): string {
  return INTERVAL_LABELS[minutes] ?? `${minutes} min`;
}

function truncateToMinute(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

export interface MaterializeEventData {
  id: number;
  start_at: string;
  reminder_overrides: string | null;
}

export class ReminderMaterializer {
  constructor(
    private reminderRepo: EventReminderRepository,
    private prefsRepo: NotificationPreferencesRepository,
  ) {}

  materialize(event: MaterializeEventData, userId: number): void {
    this.reminderRepo.deleteForEvent(event.id);

    const overrides = event.reminder_overrides
      ? (JSON.parse(event.reminder_overrides) as number[])
      : null;

    let intervals: number[];
    if (overrides) {
      intervals = overrides;
    } else {
      const prefs = this.prefsRepo.get(userId);
      intervals = prefs
        ? (JSON.parse(prefs.default_reminder_intervals) as number[])
        : [15];
    }

    const eventStart = new Date(event.start_at);
    const now = Date.now();

    for (const minutes of intervals) {
      const remindAt = truncateToMinute(new Date(eventStart.getTime() - minutes * 60_000));
      if (remindAt.getTime() < now) continue;

      this.reminderRepo.insert({
        event_id: event.id,
        user_id: userId,
        remind_at_utc: remindAt.toISOString(),
        interval_minutes: minutes,
        interval_label: formatIntervalLabel(minutes),
      });
    }
  }

  deleteForEvent(eventId: number): void {
    this.reminderRepo.deleteForEvent(eventId);
  }

  rematerializeAllForUser(userId: number, getEvents: () => MaterializeEventData[]): void {
    this.reminderRepo.deleteUnsentForUser(userId);
    const events = getEvents();
    for (const event of events) {
      this.materialize(event, userId);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/notification/materializer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notification/materializer.ts test/services/notification/materializer.test.ts
git commit -m "feat: add ReminderMaterializer"
```

---

### Task 9: NotificationRenderer

**Files:**
- Create: `src/services/notification/renderer.ts`
- Create: `test/services/notification/renderer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/services/notification/renderer.test.ts
import { describe, test, expect } from 'bun:test';
import { NotificationRenderer } from '../../../src/services/notification/renderer.ts';

describe('NotificationRenderer', () => {
  const renderer = new NotificationRenderer();

  describe('renderMorningAgenda', () => {
    test('renders agenda with events', () => {
      const result = renderer.renderMorningAgenda('en', 'Tuesday, March 15', [
        { title: 'Standup', startTime: '09:00', endTime: '09:30', location: 'Zoom', duration: '30min' },
        { title: 'Lunch', startTime: '13:00', endTime: '14:00', location: null, duration: '1hr' },
      ]);
      expect(result.channel).toBe('telegram_text');
      expect(result.text).toContain('Standup');
      expect(result.text).toContain('09:00');
      expect(result.text).toContain('Zoom');
    });
  });

  describe('renderEventReminder', () => {
    test('renders reminder with interval', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Meeting',
        startTime: '14:00',
        endTime: '15:00',
        location: 'Room B',
        intervalLabel: '15 minutes',
      });
      expect(result.channel).toBe('telegram_text');
      expect(result.text).toContain('Meeting');
      expect(result.text).toContain('15 minutes');
      expect(result.text).toContain('Room B');
    });

    test('renders without location', () => {
      const result = renderer.renderEventReminder('en', {
        title: 'Call',
        startTime: '10:00',
        endTime: '10:30',
        location: null,
        intervalLabel: '5 minutes',
      });
      expect(result.text).toContain('Call');
      expect(result.text).not.toContain('📍');
    });
  });

  describe('renderEveningReview', () => {
    test('renders tomorrow schedule', () => {
      const result = renderer.renderEveningReview('en', 'Wednesday, March 16', [
        { title: 'Review', startTime: '16:00', endTime: '17:00', location: null, duration: '1hr' },
      ]);
      expect(result.channel).toBe('telegram_text');
      expect(result.text).toContain('Review');
      expect(result.text).toContain('Wednesday');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/notification/renderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the renderer**

```typescript
// src/services/notification/renderer.ts
export interface RenderedNotification {
  channel: 'telegram_text';
  text: string;
}

export interface AgendaEvent {
  title: string;
  startTime: string;
  endTime: string;
  location: string | null;
  duration: string;
}

export interface ReminderData {
  title: string;
  startTime: string;
  endTime: string;
  location: string | null;
  intervalLabel: string;
}

const LABELS = {
  en: {
    morning: "Good morning! Here's your day:",
    evening: "Tomorrow's schedule:",
    reminder: 'Reminder:',
    inLabel: 'in',
    eventsCount: (n: number) => `${n} event${n === 1 ? '' : 's'}`,
    goodNight: 'Good night!',
    haveADay: 'Have a productive day!',
  },
  ru: {
    morning: 'Доброе утро! Ваш день:',
    evening: 'Расписание на завтра:',
    reminder: 'Напоминание:',
    inLabel: 'через',
    eventsCount: (n: number) => {
      if (n === 1) return '1 событие';
      if (n >= 2 && n <= 4) return `${n} события`;
      return `${n} событий`;
    },
    goodNight: 'Спокойной ночи!',
    haveADay: 'Продуктивного дня!',
  },
};

export class NotificationRenderer {
  renderMorningAgenda(
    lang: string,
    dateLabel: string,
    events: AgendaEvent[],
  ): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const lines: string[] = [];
    lines.push(`☀️ ${l.morning}`);
    lines.push('');
    lines.push(`📅 ${dateLabel}`);
    lines.push('');
    for (const e of events) {
      let line = `${e.startTime} — ${e.title} (${e.duration})`;
      if (e.location) line += `\n        📍 ${e.location}`;
      lines.push(line);
    }
    lines.push('');
    lines.push(l.haveADay);
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderEventReminder(lang: string, data: ReminderData): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const lines: string[] = [];
    lines.push(`⏰ ${l.reminder} ${data.title} ${l.inLabel} ${data.intervalLabel}`);
    lines.push('');
    lines.push(`🕐 ${data.startTime} — ${data.endTime}`);
    if (data.location) {
      lines.push(`📍 ${data.location}`);
    }
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderEveningReview(
    lang: string,
    dateLabel: string,
    events: AgendaEvent[],
  ): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const lines: string[] = [];
    lines.push(`🌙 ${l.evening}`);
    lines.push('');
    lines.push(`📅 ${dateLabel}`);
    lines.push('');
    for (const e of events) {
      let line = `${e.startTime} — ${e.title} (${e.duration})`;
      if (e.location) line += `\n        📍 ${e.location}`;
      lines.push(line);
    }
    lines.push('');
    lines.push(`${l.eventsCount(events.length)} tomorrow. ${l.goodNight}`);
    return { channel: 'telegram_text', text: lines.join('\n') };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/notification/renderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/notification/renderer.ts test/services/notification/renderer.test.ts
git commit -m "feat: add NotificationRenderer"
```

---

