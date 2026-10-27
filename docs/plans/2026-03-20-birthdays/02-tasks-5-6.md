> Part 2 of 3 of [Birthday Events Implementation Plan](../2026-03-20-birthdays.md) — previous: [01-overview-tasks-1-4.md](01-overview-tasks-1-4.md) · next: [03-tasks-7-9.md](03-tasks-7-9.md)

## Task 5: BirthdayService

**Files:**
- Create: `src/services/birthday/birthday-service.ts`
- Create: `test/services/birthday/birthday-service.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/birthday/birthday-service.test.ts
import { test, expect, beforeEach } from 'bun:test';
import Database from 'bun:sqlite';
import { runMigrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { BirthdayMetadataRepository } from '../../../src/database/repositories/birthday-metadata.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { BirthdayService } from '../../../src/services/birthday/birthday-service.ts';

let db: Database;
let service: BirthdayService;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO users (telegram_id, first_name, language, timezone) VALUES (1, 'Alice', 'ru', 'UTC')").run();
  db.prepare("INSERT INTO users (telegram_id, first_name, username, language, timezone) VALUES (42, 'Ivan', 'ivan_t', 'ru', 'UTC')").run();

  service = new BirthdayService(
    new EventRepository(db),
    new BirthdayMetadataRepository(db),
    new EventReminderRepository(db),
    new NotificationPreferencesRepository(db),
  );
});

test('getDisplayTitle RU with birth_year uses ruPlural for age', () => {
  expect(service.getDisplayTitle('Д/р Иван', 1996, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван — 30 лет');
  expect(service.getDisplayTitle('Д/р Иван', 1995, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван — 31 год');
  expect(service.getDisplayTitle('Д/р Иван', 2004, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван — 22 года');
});

test('getDisplayTitle EN with birth_year', () => {
  expect(service.getDisplayTitle('Bday Ivan', 1996, new Date('2026-05-10'), 'en')).toBe('🎁 Bday Ivan — turns 30');
});

test('getDisplayTitle without birth_year omits age', () => {
  expect(service.getDisplayTitle('Д/р Иван', null, new Date('2026-05-10'), 'ru')).toBe('🎁 Д/р Иван');
});

test('upsertBirthdayEvent creates event with correct fields and 2 reminders', () => {
  service.upsertBirthdayEvent({
    ownerId: 1, celebrantId: 42, celebrantName: 'Иван',
    day: 10, month: 5, year: 1996, lang: 'ru', timezone: 'UTC', autoCreated: true,
  });

  const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all() as { title: string; recurrence_rule: string; all_day: number }[];
  expect(events.length).toBe(1);
  expect(events[0]!.title).toBe('Д/р Иван');
  expect(events[0]!.recurrence_rule).toBe('FREQ=YEARLY');
  expect(events[0]!.all_day).toBe(1);

  const reminders = db.prepare('SELECT * FROM event_reminders').all();
  expect(reminders.length).toBeGreaterThanOrEqual(1); // at least day-of (7-days may be past)
});

test('shouldSkipSync returns true when recently synced', () => {
  const metaRepo = new BirthdayMetadataRepository(db);
  metaRepo.upsertSyncState(1, new Date().toISOString());
  expect(service.shouldSkipSync(1)).toBe(true);
});

test('shouldSkipSync returns false when never synced', () => {
  expect(service.shouldSkipSync(1)).toBe(false);
});

test('findExistingBirthday returns existing personal calendar entry', () => {
  service.upsertBirthdayEvent({ ownerId: 1, celebrantId: 42, celebrantName: 'Иван', day: 10, month: 5, year: null, lang: 'ru', timezone: 'UTC', autoCreated: false });
  const result = service.findExistingBirthday(42, 1);
  expect(result).not.toBeNull();
  expect(result!.celebrant_id).toBe(42);
});

test('getBirthdaysForDisplay returns personal entries sorted by next occurrence', () => {
  service.upsertBirthdayEvent({ ownerId: 1, celebrantId: 42, celebrantName: 'Иван', day: 10, month: 5, year: null, lang: 'ru', timezone: 'UTC', autoCreated: false });
  const { personal } = service.getBirthdaysForDisplay(1, 'ru', []);
  expect(personal.length).toBe(1);
  expect(personal[0]!.event.title).toBe('Д/р Иван');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test test/services/birthday/birthday-service.test.ts
```

- [ ] **Step 3: Create `src/services/birthday/birthday-service.ts`**

```ts
import { TZDate } from '@date-fns/tz';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { BirthdayMetadataRepository } from '../../database/repositories/birthday-metadata.repository.ts';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';
import type { BirthEventMetadata, CalendarEvent } from '../../database/types.ts';
import { ruPlural } from '../event/formatters.ts';
import { logger } from '../../utils/logger.ts';

const birthdayLogger = logger.child({ module: 'birthday-service' });

const SYNC_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ALL_DAY_TIME = '09:00';

function allDayReminderUtc(dateStr: string, localTime: string, timezone: string): Date {
  const [h, m] = localTime.split(':').map(Number);
  const local = new TZDate(new Date(dateStr), timezone);
  local.setHours(h!, m!, 0, 0);
  return new Date(local.getTime());
}

export interface UpsertBirthdayParams {
  ownerId: number;
  celebrantId: number | null;
  celebrantName: string;
  day: number;
  month: number;
  year: number | null;
  lang: 'en' | 'ru';
  timezone: string;
  autoCreated: boolean;
  groupId?: number;
}

export interface BirthdayDisplayItem {
  event: CalendarEvent;
  celebrantId: number | null;
  birthYear: number | null;
  username: string | null;
}

export interface BirthdaysForDisplay {
  personal: BirthdayDisplayItem[];
  groups: { groupId: number; title: string; items: BirthdayDisplayItem[] }[];
}

export class BirthdayService {
  constructor(
    private eventRepo: EventRepository,
    private metaRepo: BirthdayMetadataRepository,
    private reminderRepo: EventReminderRepository,
    private prefsRepo: NotificationPreferencesRepository,
    private fetchScriptPath = 'scripts/fetch-birthdays.py',
  ) {}

  getDisplayTitle(title: string, birthYear: number | null, eventDate: Date, lang: 'en' | 'ru'): string {
    const prefix = '🎁 ';
    if (birthYear === null) return prefix + title;
    const age = eventDate.getFullYear() - birthYear;
    const suffix =
      lang === 'ru'
        ? ` — ${age} ${ruPlural(age, 'год', 'года', 'лет')}`
        : ` — turns ${age}`;
    return prefix + title + suffix;
  }

  shouldSkipSync(userId: number): boolean {
    const state = this.metaRepo.getSyncState(userId);
    if (!state) return false;
    return Date.now() - new Date(state.synced_at).getTime() < SYNC_THROTTLE_MS;
  }

  findExistingBirthday(celebrantId: number, ownerId: number): (BirthEventMetadata & { start_at: string; title: string }) | null {
    return this.metaRepo.findByCelebrantAndOwner(celebrantId, ownerId);
  }

  upsertBirthdayEvent(params: UpsertBirthdayParams): void {
    const titlePrefix = params.lang === 'ru' ? 'Д/р ' : 'Bday ';
    const title = titlePrefix + params.celebrantName;

    const now = new Date();
    let year = now.getFullYear();
    const thisYearDate = new Date(year, params.month - 1, params.day);
    if (thisYearDate < now) year += 1;

    const startDateStr = `${year}-${String(params.month).padStart(2, '0')}-${String(params.day).padStart(2, '0')}`;
    const startAt = `${startDateStr}T00:00:00Z`;

    const existing = params.celebrantId
      ? this.metaRepo.findByCelebrantAndOwner(params.celebrantId, params.ownerId)
      : null;

    let eventId: number;
    if (existing) {
      const existingMonth = new Date(existing.start_at).getUTCMonth() + 1;
      const existingDay = new Date(existing.start_at).getUTCDate();
      if (existingMonth !== params.month || existingDay !== params.day) {
        this.eventRepo.update(existing.event_id, params.ownerId, { start_at: startAt });
        this.reminderRepo.deleteForEvent(existing.event_id);
        birthdayLogger.info({ eventId: existing.event_id }, 'Birthday date updated');
      }
      eventId = existing.event_id;
    } else {
      const event = this.eventRepo.create({
        user_id: params.ownerId,
        title,
        start_at: startAt,
        all_day: true,
        timezone: params.timezone,
        recurrence_rule: 'FREQ=YEARLY',
        event_type: 'birthday',
        owner_type: params.groupId ? 'group' : 'user',
        group_id: params.groupId ?? null,
      });
      eventId = event.id;
    }

    this.metaRepo.upsertMetadata({
      event_id: eventId,
      celebrant_id: params.celebrantId ?? null,
      birth_year: params.year ?? null,
      auto_created: params.autoCreated ? 1 : 0,
    });

    // Always delete stale reminders before recreating — prevents duplicates on repeated upserts
    this.reminderRepo.deleteForEvent(eventId);
    this.createBirthdayReminders(eventId, params.ownerId, startDateStr, params.timezone);
  }

  private createBirthdayReminders(eventId: number, userId: number, startDateStr: string, timezone: string): void {
    const prefs = this.prefsRepo.get(userId);
    const localTime = prefs?.morning_agenda_time ?? DEFAULT_ALL_DAY_TIME;
    const now = Date.now();

    // 7 days before
    const [y, mo, d] = startDateStr.split('-').map(Number);
    const sevenBefore = new Date(Date.UTC(y!, mo! - 1, d! - 7)).toISOString().substring(0, 10);
    const sevenBeforeUtc = allDayReminderUtc(`${sevenBefore}T00:00:00Z`, localTime, timezone);
    if (sevenBeforeUtc.getTime() > now) {
      this.reminderRepo.insert({
        event_id: eventId,
        user_id: userId,
        remind_at_utc: sevenBeforeUtc.toISOString(),
        interval_minutes: 7 * 24 * 60,
        interval_label: '7 days before',
      });
    }

    // Day of
    const dayOfUtc = allDayReminderUtc(`${startDateStr}T00:00:00Z`, localTime, timezone);
    if (dayOfUtc.getTime() > now) {
      this.reminderRepo.insert({
        event_id: eventId,
        user_id: userId,
        remind_at_utc: dayOfUtc.toISOString(),
        interval_minutes: 0,
        interval_label: 'day of',
      });
    }
  }

  async fetchAndSyncUser(
    userId: number,
    firstName: string,
    ownerId: number,
    lang: 'en' | 'ru',
    timezone: string,
  ): Promise<void> {
    if (this.shouldSkipSync(userId)) return;

    let result: Record<string, { day: number; month: number; year?: number } | null>;
    try {
      const proc = Bun.spawn(['venv/bin/python', this.fetchScriptPath], {
        stdin: JSON.stringify([userId]),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      this.metaRepo.upsertSyncState(userId, new Date().toISOString());

      if (exitCode !== 0) {
        const err = await new Response(proc.stderr).text();
        birthdayLogger.warn({ userId, err }, 'fetch-birthdays.py failed');
        return;
      }
      const stdout = await new Response(proc.stdout).text();
      result = JSON.parse(stdout);
    } catch (err) {
      birthdayLogger.error({ userId, err }, 'Failed to spawn fetch-birthdays.py');
      return;
    }

    const birthday = result[String(userId)];
    if (!birthday) return;

    this.upsertBirthdayEvent({
      ownerId,
      celebrantId: userId,
      celebrantName: firstName,
      day: birthday.day,
      month: birthday.month,
      year: birthday.year ?? null,
      lang,
      timezone,
      autoCreated: true,
    });
  }

  async runBatchSync(
    users: { telegram_id: number; first_name: string | null; language: string; timezone: string }[],
  ): Promise<void> {
    const ids = users.map((u) => u.telegram_id);
    if (ids.length === 0) return;

    let result: Record<string, { day: number; month: number; year?: number } | null>;
    try {
      const proc = Bun.spawn(['venv/bin/python', this.fetchScriptPath], {
        stdin: JSON.stringify(ids),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const now = new Date().toISOString();
      for (const u of users) this.metaRepo.upsertSyncState(u.telegram_id, now);

      if (exitCode !== 0) {
        const err = await new Response(proc.stderr).text();
        birthdayLogger.warn({ err }, 'Batch fetch-birthdays.py failed');
        return;
      }
      const stdout = await new Response(proc.stdout).text();
      result = JSON.parse(stdout);
    } catch (err) {
      birthdayLogger.error({ err }, 'Failed to spawn batch fetch-birthdays.py');
      return;
    }

    for (const user of users) {
      const birthday = result[String(user.telegram_id)];
      if (!birthday) continue;
      this.upsertBirthdayEvent({
        ownerId: user.telegram_id,
        celebrantId: user.telegram_id,
        celebrantName: user.first_name ?? String(user.telegram_id),
        day: birthday.day,
        month: birthday.month,
        year: birthday.year ?? null,
        lang: (user.language as 'en' | 'ru') ?? 'en',
        timezone: user.timezone,
        autoCreated: true,
      });
    }
  }

  getBirthdaysForDisplay(
    userId: number,
    lang: 'en' | 'ru',
    groupCalendars: { groupId: number; title: string }[],
  ): BirthdaysForDisplay {
    const personalEvents = this.eventRepo.getBirthdays(userId);
    const personalCelebrantIds = new Set<number>();

    const personal: BirthdayDisplayItem[] = personalEvents.map((e) => {
      const meta = this.metaRepo.findByEventId(e.id);
      if (meta?.celebrant_id != null) personalCelebrantIds.add(meta.celebrant_id);
      return { event: e, celebrantId: meta?.celebrant_id ?? null, birthYear: meta?.birth_year ?? null, username: null };
    });

    const groups = groupCalendars.map(({ groupId, title }) => {
      const groupEvents = this.eventRepo.getBirthdaysForGroup(groupId);
      const items: BirthdayDisplayItem[] = groupEvents
        .filter((e) => {
          const meta = this.metaRepo.findByEventId(e.id);
          return meta?.celebrant_id == null || !personalCelebrantIds.has(meta.celebrant_id);
        })
        .map((e) => {
          const meta = this.metaRepo.findByEventId(e.id);
          return { event: e, celebrantId: meta?.celebrant_id ?? null, birthYear: meta?.birth_year ?? null, username: null };
        });
      return { groupId, title, items };
    });

    const sortByNext = (a: BirthdayDisplayItem, b: BirthdayDisplayItem) =>
      nextOccurrenceTs(a.event.start_at) - nextOccurrenceTs(b.event.start_at);

    personal.sort(sortByNext);
    for (const g of groups) g.items.sort(sortByNext);

    return { personal, groups };
  }
}

function nextOccurrenceTs(startAt: string): number {
  const d = new Date(startAt);
  const now = new Date();
  const thisYear = new Date(now.getFullYear(), d.getUTCMonth(), d.getUTCDate());
  return thisYear >= now
    ? thisYear.getTime()
    : new Date(now.getFullYear() + 1, d.getUTCMonth(), d.getUTCDate()).getTime();
}
```

- [ ] **Step 4: Add `searchWithEventType` to `EventService` in `src/services/event/event-service.ts`**

```ts
searchWithEventType(userId: number, query: string | null, eventType: string | null): CalendarEvent[] {
  return this.eventRepo.searchWithEventType(userId, query, eventType);
}
```

- [ ] **Step 5: Run tests**

```bash
bun test test/services/birthday/birthday-service.test.ts
```

- [ ] **Step 6: Full suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/services/birthday/birthday-service.ts src/services/event/event-service.ts \
  test/services/birthday/birthday-service.test.ts
git commit -m "feat(birthday): BirthdayService — display, upsert, reminders, dedup, batch sync"
```

---

## Task 6: Cron Job + Message Handler Hook

**Files:**
- Modify: `src/worker/bot-tasks-queue.ts`
- Modify: `src/bot/handlers/message.handler.ts`
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Write failing tests for cron setup**

```ts
// test/worker/bot-tasks-queue.test.ts — add to existing or create
import { test, expect } from 'bun:test';

test('BotTaskJobType includes cron-birthday-sync', async () => {
  const { setupBirthdaySyncCron } = await import('../../src/worker/bot-tasks-queue.ts');
  expect(typeof setupBirthdaySyncCron).toBe('function');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test test/worker/bot-tasks-queue.test.ts -t 'cron-birthday-sync'
```

- [ ] **Step 3: Update `src/worker/bot-tasks-queue.ts`**

In `BotTaskJobType` union, add `'cron-birthday-sync'`.

In `BotTasksQueueDeps`, add:
```ts
onBirthdaySync?: () => Promise<void>;
```

In the worker handler, add:
```ts
if (job.data.type === 'cron-birthday-sync') {
  if (deps.onBirthdaySync) await deps.onBirthdaySync();
  return;
}
```

Add exported function:
```ts
export async function setupBirthdaySyncCron(queue: Queue<BotTaskJobData>): Promise<void> {
  await queue.add(
    'birthday-sync-tick',
    { type: 'cron-birthday-sync' },
    { repeat: { every: 24 * 60 * 60_000 }, removeOnComplete: true, jobId: 'birthday-sync-tick' },
  );
  botTasksLogger.info('Birthday sync cron scheduled (daily)');
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
bun test test/worker/bot-tasks-queue.test.ts -t 'cron-birthday-sync'
```

- [ ] **Step 5: Update `src/bot/handlers/message.handler.ts`**

Add `BirthdayService` to deps type:
```ts
import type { BirthdayService } from '../../services/birthday/birthday-service.ts';
// In deps interface:
birthdayService?: BirthdayService;
```

After the `groupMemberRepo.upsert(...)` call (around line 822), add:
```ts
if (deps.birthdayService) {
  deps.birthdayService
    .fetchAndSyncUser(user.telegram_id, user.first_name ?? '', user.telegram_id, user.language as 'en' | 'ru', user.timezone)
    .catch((err) => logger.error({ err, userId: user.telegram_id }, 'Birthday sync failed'));
}
```

- [ ] **Step 6: Add `findAll()` to `src/database/repositories/user.repository.ts`**

```ts
findAll(): User[] {
  return this.db.prepare('SELECT * FROM users').all() as User[];
}
```

- [ ] **Step 7: Wire everything in `src/bot/index.ts`**

```ts
import { BirthdayService } from '../services/birthday/birthday-service.ts';
import { setupBirthdaySyncCron } from '../worker/bot-tasks-queue.ts';

// After db init (note: db.notificationPreferences — not notificationPrefs):
const birthdayService = new BirthdayService(
  db.events, db.birthdayMeta, db.eventReminders, db.notificationPreferences
);

// In botTasksQueue deps, add:
onBirthdaySync: async () => {
  const BATCH = 100;
  const needingIds = new Set(db.birthdayMeta.getUsersNeedingSync(7 * 24 * 60 * 60 * 1000));
  const allUsers = db.users.findAll().filter(u => needingIds.has(u.telegram_id));
  for (let i = 0; i < allUsers.length; i += BATCH) {
    await birthdayService.runBatchSync(allUsers.slice(i, i + BATCH));
  }
},

// In message handler deps object, add:
birthdayService,
```

- [ ] **Step 8: Run full suite**

```bash
bun test
```

- [ ] **Step 9: Commit**

```bash
git add src/worker/bot-tasks-queue.ts src/bot/handlers/message.handler.ts src/bot/index.ts \
  src/database/repositories/user.repository.ts test/worker/bot-tasks-queue.test.ts
git commit -m "feat(birthday): cron job + group message hook for birthday discovery"
```

---

