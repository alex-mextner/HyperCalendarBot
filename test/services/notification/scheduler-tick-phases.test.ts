/**
 * Characterization tests for NotificationScheduler.tick phases and pickBotTip branches.
 *
 * They pin behaviour that the main scheduler tests leave implicit (quiet-hours skips,
 * dedup of batches, voice-call payloads, weather degradation, phase ordering and
 * deterministic tip selection) so that decomposing `tick` into per-phase helpers
 * cannot silently change what is enqueued, in which order, or with which payload.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, type Mock, mock, spyOn, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { CallLogRepository } from '../../../src/database/repositories/call-log.repository.ts';
import { CallSettingsRepository } from '../../../src/database/repositories/call-settings.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationLogRepository } from '../../../src/database/repositories/notification-log.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { EventOccurrence, NotificationLogRow } from '../../../src/database/types.ts';
import {
  type EnqueueCallData,
  NotificationScheduler,
  pickBotTip,
  type TipContext,
} from '../../../src/services/notification/scheduler.ts';
import { BOT_TIP_FEATURE_MAP } from '../../../src/services/notification/tip-tags.ts';
import { WeatherService } from '../../../src/services/weather/weather-service.ts';

function setupDb(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function wrapGetEventsInRange(
  eventRepo: EventRepository,
): (userId: number, startUtc: string, endUtc: string) => EventOccurrence[] {
  return (userId, startUtc, endUtc) =>
    eventRepo.getInRange(userId, startUtc, endUtc).map((event) => ({
      event,
      occurrence_start: event.start_at,
      occurrence_end: event.end_at,
      is_exception: false,
    }));
}

interface Enqueued {
  type: string;
  userId: number;
  logId: number;
  payload: string;
}

interface Harness {
  db: Database;
  scheduler: NotificationScheduler;
  enqueued: Enqueued[];
  calls: EnqueueCallData[];
  logRepo: NotificationLogRepository;
}

type WeatherServiceMethods = Pick<WeatherService, 'getDayWeather' | 'getWeekWeather' | 'getForecastAt'>;

const unexpectedWeatherCall = (method: string) => () => {
  throw new Error(`unexpected WeatherService.${method} call`);
};

/** A real WeatherService whose every public method is replaced, so an unstubbed call fails loudly instead of fetching. */
function makeWeatherService(stubs: Partial<WeatherServiceMethods>): WeatherService {
  return Object.assign(new WeatherService({ apiKey: 'test' }), {
    getDayWeather: unexpectedWeatherCall('getDayWeather'),
    getWeekWeather: unexpectedWeatherCall('getWeekWeather'),
    getForecastAt: unexpectedWeatherCall('getForecastAt'),
    ...stubs,
  });
}

function makeHarness(options: { weatherService?: Partial<WeatherServiceMethods>; withCalls?: boolean } = {}): Harness {
  const db = setupDb();
  const enqueued: Enqueued[] = [];
  const calls: EnqueueCallData[] = [];
  const logRepo = new NotificationLogRepository(db);
  const callDeps = options.withCalls
    ? {
        callSettingsRepo: new CallSettingsRepository(db),
        callLogRepo: new CallLogRepository(db),
        enqueueCall: (data: EnqueueCallData) => {
          calls.push(data);
        },
      }
    : {};
  const scheduler = new NotificationScheduler({
    prefsRepo: new NotificationPreferencesRepository(db),
    reminderRepo: new EventReminderRepository(db),
    logRepo,
    userRepo: new UserRepository(db),
    getEventsInRange: wrapGetEventsInRange(new EventRepository(db)),
    enqueue: (type, userId, logId, payload) => {
      enqueued.push({ type, userId, logId, payload });
    },
    ...callDeps,
    ...(options.weatherService ? { weatherService: makeWeatherService(options.weatherService) } : {}),
  });
  return { db, scheduler, enqueued, calls, logRepo };
}

function enableCalls(db: Database, userId: number): void {
  const settings = new CallSettingsRepository(db);
  settings.ensureDefaults(userId);
  settings.setEnabled(userId, true);
}

function addUser(db: Database, id: number, tz = 'UTC', lang = 'en'): void {
  db.run('INSERT INTO users (telegram_id, timezone, language) VALUES (?, ?, ?)', [id, tz, lang]);
}

function addReminder(db: Database, eventId: number, userId: number, startAt: string, remindAt: string, label: string) {
  db.run("INSERT INTO events (id, user_id, title, start_at, timezone) VALUES (?, ?, ?, ?, 'UTC')", [
    eventId,
    userId,
    `Event ${eventId}`,
    startAt,
  ]);
  db.run(
    'INSERT INTO event_reminders (event_id, user_id, remind_at_utc, interval_minutes, interval_label) VALUES (?, ?, ?, 15, ?)',
    [eventId, userId, remindAt, label],
  );
}

function sentFlags(db: Database): number[] {
  return (db.query('SELECT sent FROM event_reminders ORDER BY id').all() as { sent: number }[]).map((r) => r.sent);
}

describe('tick – event reminder phase', () => {
  test('user quiet hours skip the reminder without marking it sent', async () => {
    const h = makeHarness();
    addUser(h.db, 42);
    h.db.run(
      "INSERT INTO notification_preferences (user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end) VALUES (42, 1, '22:00', '08:00')",
    );
    addReminder(h.db, 1, 42, '2026-03-15T00:00:00Z', '2026-03-15T23:45:00Z', '15 minutes');
    await h.scheduler.tick(new Date('2026-03-15T23:45:30Z'));
    expect(h.enqueued).toEqual([]);
    expect(sentFlags(h.db)).toEqual([0]);
  });

  test('reminder outside user quiet hours is enqueued and marked sent', async () => {
    const h = makeHarness();
    addUser(h.db, 42);
    h.db.run(
      "INSERT INTO notification_preferences (user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end) VALUES (42, 1, '22:00', '08:00')",
    );
    addReminder(h.db, 1, 42, '2026-03-15T14:00:00Z', '2026-03-15T13:45:00Z', '15 minutes');
    await h.scheduler.tick(new Date('2026-03-15T13:45:30Z'));
    expect(h.enqueued.map((e) => e.type)).toEqual(['event_reminder']);
    expect(sentFlags(h.db)).toEqual([1]);
  });

  test('single reminder: log ref key, payload shape and voice call carry the event id', async () => {
    const h = makeHarness({ withCalls: true });
    addUser(h.db, 42, 'UTC', 'ru');
    enableCalls(h.db, 42);
    addReminder(h.db, 7, 42, '2026-03-15T14:00:00Z', '2026-03-15T13:45:00Z', '15 минут');
    await h.scheduler.tick(new Date('2026-03-15T13:45:30Z'));
    expect(h.enqueued).toHaveLength(1);
    const log = h.logRepo.getById(h.enqueued[0]!.logId) as NotificationLogRow;
    expect(log.reference_key).toBe('er:1');
    expect(log.type).toBe('event_reminder');
    expect(log.channel).toBe('telegram_text');
    expect(JSON.parse(h.enqueued[0]!.payload)).toMatchObject({ event_id: 7 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ userId: 42, eventId: 7, language: 'ru' });
    expect(h.calls[0]!.ttsText).toContain('Event 7');
  });

  test('batch: ref key, event_ids payload, every reminder marked sent, one batch voice call', async () => {
    const h = makeHarness({ withCalls: true });
    addUser(h.db, 42, 'UTC', 'en');
    enableCalls(h.db, 42);
    addReminder(h.db, 1, 42, '2026-03-15T14:00:00Z', '2026-03-15T13:45:00Z', '15 minutes');
    addReminder(h.db, 2, 42, '2026-03-15T14:30:00Z', '2026-03-15T13:45:00Z', '15 minutes');
    await h.scheduler.tick(new Date('2026-03-15T13:45:30Z'));
    expect(h.enqueued.map((e) => e.type)).toEqual(['event_reminder_batch']);
    const log = h.logRepo.getById(h.enqueued[0]!.logId) as NotificationLogRow;
    expect(log.reference_key).toBe('erb:42:2026-03-15T13:45:00Z');
    expect(JSON.parse(h.enqueued[0]!.payload).event_ids).toEqual([1, 2]);
    expect(sentFlags(h.db)).toEqual([1, 1]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ userId: 42, language: 'en' });
    expect(h.calls[0]!.eventId).toBeUndefined();
  });

  test('batch whose log row already exists is skipped: nothing enqueued, reminders stay unsent', async () => {
    const h = makeHarness({ withCalls: true });
    addUser(h.db, 42);
    enableCalls(h.db, 42);
    addReminder(h.db, 1, 42, '2026-03-15T14:00:00Z', '2026-03-15T13:45:00Z', '15 minutes');
    addReminder(h.db, 2, 42, '2026-03-15T14:30:00Z', '2026-03-15T13:45:00Z', '15 minutes');
    h.logRepo.insert({
      user_id: 42,
      type: 'event_reminder_batch',
      reference_key: 'erb:42:2026-03-15T13:45:00Z',
      channel: 'telegram_text',
      payload: '{}',
    });
    await h.scheduler.tick(new Date('2026-03-15T13:45:30Z'));
    expect(h.enqueued).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(sentFlags(h.db)).toEqual([0, 0]);
  });

  test('single reminder whose log row already exists is skipped and stays unsent', async () => {
    const h = makeHarness();
    addUser(h.db, 42);
    addReminder(h.db, 1, 42, '2026-03-15T14:00:00Z', '2026-03-15T13:45:00Z', '15 minutes');
    h.logRepo.insert({
      user_id: 42,
      type: 'event_reminder',
      reference_key: 'er:1',
      channel: 'telegram_text',
      payload: '{}',
    });
    await h.scheduler.tick(new Date('2026-03-15T13:45:30Z'));
    expect(h.enqueued).toEqual([]);
    expect(sentFlags(h.db)).toEqual([0]);
  });

  test('batch forecasts are fetched once per reminder with the all-day flag', async () => {
    const getForecastAt = mock(() => Promise.resolve(null));
    const h = makeHarness({ weatherService: { getForecastAt } });
    addUser(h.db, 42, 'UTC', 'ru');
    addReminder(h.db, 1, 42, '2026-03-15T14:00:00Z', '2026-03-15T13:45:00Z', '15 минут');
    addReminder(h.db, 2, 42, '2026-03-16T00:00:00Z', '2026-03-15T13:45:00Z', 'день');
    h.db.run('UPDATE event_reminders SET interval_minutes = -1 WHERE event_id = 2');
    await h.scheduler.tick(new Date('2026-03-15T13:45:30Z'));
    expect(getForecastAt).toHaveBeenCalledTimes(2);
    const args = getForecastAt.mock.calls as unknown as [string, number, string, { allDay?: boolean }][];
    expect(args[0]![2]).toBe('ru');
    expect(args[0]![3]).toEqual({ allDay: false });
    expect(args[1]![3]).toEqual({ allDay: true });
  });
});

describe('tick – morning agenda phase', () => {
  test('quiet hours skip the morning agenda', async () => {
    const h = makeHarness();
    addUser(h.db, 42);
    h.db.run(
      "INSERT INTO notification_preferences (user_id, morning_agenda_time, quiet_hours_enabled, quiet_hours_start, quiet_hours_end) VALUES (42, '08:00', 1, '07:00', '09:00')",
    );
    await h.scheduler.tick(new Date('2026-03-15T08:00:30Z'));
    expect(h.enqueued).toEqual([]);
  });

  test('morning agenda uses the ma:<user>:<local date> ref key and enqueues a voice call', async () => {
    const h = makeHarness({ withCalls: true });
    addUser(h.db, 42, 'Europe/Berlin', 'ru');
    enableCalls(h.db, 42);
    h.db.run("INSERT INTO notification_preferences (user_id, morning_agenda_time) VALUES (42, '08:00')");
    await h.scheduler.tick(new Date('2026-03-16T07:00:30Z'));
    expect(h.enqueued.map((e) => e.type)).toEqual(['morning_agenda']);
    const log = h.logRepo.getById(h.enqueued[0]!.logId) as NotificationLogRow;
    expect(log.reference_key).toBe('ma:42:2026-03-16');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ userId: 42, language: 'ru' });
  });

  test('morning agenda deduplicates by ref key and then enqueues no voice call', async () => {
    const h = makeHarness({ withCalls: true });
    addUser(h.db, 42);
    enableCalls(h.db, 42);
    h.db.run("INSERT INTO notification_preferences (user_id, morning_agenda_time) VALUES (42, '08:00')");
    await h.scheduler.tick(new Date('2026-03-15T08:00:30Z'));
    await h.scheduler.tick(new Date('2026-03-15T08:00:45Z'));
    expect(h.enqueued).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
  });

  test('a duplicate standalone clock-change log suppresses a second enqueue', async () => {
    const h = makeHarness();
    addUser(h.db, 42, 'Europe/Berlin', 'en');
    // 2026-03-29 is the EU spring-forward day
    await h.scheduler.tick(new Date('2026-03-29T06:00:30Z'));
    await h.scheduler.tick(new Date('2026-03-29T06:01:30Z'));
    expect(h.enqueued.map((e) => e.type)).toEqual(['clock_change']);
    const log = h.logRepo.getById(h.enqueued[0]!.logId) as NotificationLogRow;
    expect(log.reference_key).toBe('cc:42:2026-03-29');
  });
});

describe('tick – evening review phase', () => {
  const tomorrowWeather = {
    tempMin: 1,
    tempMax: 9,
    conditionCode: 500,
    description: 'drizzle test',
    windSpeed: 2,
  };

  test('evening review picks the local-tomorrow day from the week forecast', async () => {
    const getWeekWeather = mock(() =>
      Promise.resolve({
        days: [
          { date: '2026-03-15', ...tomorrowWeather, description: 'wrong day' },
          { date: '2026-03-16', ...tomorrowWeather },
        ],
        hours: [],
      }),
    );
    const h = makeHarness({ weatherService: { getWeekWeather } });
    addUser(h.db, 42, 'UTC', 'en');
    h.db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    await h.scheduler.tick(new Date('2026-03-15T21:00:30Z'));
    const evening = h.enqueued.find((e) => e.type === 'evening_review')!;
    expect(evening.payload).toContain('drizzle test');
    expect(evening.payload).not.toContain('wrong day');
    const log = h.logRepo.getById(evening.logId) as NotificationLogRow;
    expect(log.reference_key).toBe('ev:42:2026-03-16');
  });

  test('evening review still goes out when the week forecast fails', async () => {
    const getWeekWeather = mock(() => Promise.reject(new Error('API down')));
    const h = makeHarness({ weatherService: { getWeekWeather } });
    addUser(h.db, 42);
    h.db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    await h.scheduler.tick(new Date('2026-03-15T21:00:30Z'));
    expect(h.enqueued.some((e) => e.type === 'evening_review')).toBe(true);
  });

  test('evening review without a matching forecast day carries no weather', async () => {
    const getWeekWeather = mock(() =>
      Promise.resolve({ days: [{ date: '2030-01-01', ...tomorrowWeather }], hours: [] }),
    );
    const h = makeHarness({ weatherService: { getWeekWeather } });
    addUser(h.db, 42);
    h.db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    await h.scheduler.tick(new Date('2026-03-15T21:00:30Z'));
    const evening = h.enqueued.find((e) => e.type === 'evening_review')!;
    expect(evening.payload).not.toContain('drizzle test');
  });

  test('quiet hours skip the evening review', async () => {
    const h = makeHarness();
    addUser(h.db, 42);
    h.db.run(
      "INSERT INTO notification_preferences (user_id, evening_review_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end) VALUES (42, 1, 1, '20:00', '22:00')",
    );
    // Monday: the Sunday weekly digest (which ignores quiet hours) is not in play
    await h.scheduler.tick(new Date('2026-03-16T21:00:30Z'));
    expect(h.enqueued).toEqual([]);
  });

  test('evening review enqueues a voice call', async () => {
    const h = makeHarness({ withCalls: true });
    addUser(h.db, 42, 'UTC', 'ru');
    enableCalls(h.db, 42);
    h.db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    await h.scheduler.tick(new Date('2026-03-16T21:00:30Z'));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ userId: 42, language: 'ru' });
  });
});

describe('tick – weekly digest phase', () => {
  const week = (date: string, description: string) => ({
    date,
    tempMin: 1,
    tempMax: 2,
    conditionCode: 800,
    description,
    windSpeed: 1,
  });
  const SUNDAY_21H = new Date('2026-03-22T21:00:30Z');

  test('digest includes week weather by date and enqueues a digest voice call', async () => {
    const getWeekWeather = mock(() => Promise.resolve({ days: [week('2026-03-23', 'clear')], hours: [] }));
    const h = makeHarness({ weatherService: { getWeekWeather }, withCalls: true });
    addUser(h.db, 42, 'UTC', 'en');
    enableCalls(h.db, 42);
    h.db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    h.db.run(
      "INSERT INTO events (id, user_id, title, start_at, end_at, timezone) VALUES (1, 42, 'Standup', '2026-03-23T10:00:00Z', '2026-03-23T10:30:00Z', 'UTC')",
    );
    await h.scheduler.tick(SUNDAY_21H);
    const digest = h.enqueued.find((e) => e.type === 'weekly_digest')!;
    expect(digest.payload).toContain('Standup');
    expect(digest.payload).toContain('1..2°');
    expect(digest.payload).toContain('☀️');
    expect(h.calls.filter((c) => c.userId === 42)).toHaveLength(2);
    expect(h.calls.at(-1)!.ttsText).toContain('Standup');
  });

  test('digest still goes out when the week forecast fails', async () => {
    const getWeekWeather = mock(() => Promise.reject(new Error('API down')));
    const h = makeHarness({ weatherService: { getWeekWeather } });
    addUser(h.db, 42);
    h.db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    await h.scheduler.tick(SUNDAY_21H);
    expect(h.enqueued.some((e) => e.type === 'weekly_digest')).toBe(true);
  });

  test('digest week range spans a month boundary with both month names', async () => {
    const h = makeHarness();
    addUser(h.db, 42, 'UTC', 'en');
    h.db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (42, 1)');
    // Next week is Mon 2026-03-30 .. Sun 2026-04-05
    await h.scheduler.tick(new Date('2026-03-29T21:00:30Z'));
    const digest = h.enqueued.find((e) => e.type === 'weekly_digest')!;
    expect(digest.payload).toContain('30 Mar–5 Apr');
    const log = h.logRepo.getById(digest.logId) as NotificationLogRow;
    expect(log.reference_key).toBe('wd:42:2026-W14');
  });
});

describe('tick – phase order', () => {
  test('Sunday tick enqueues reminders, morning, evening, then weekly digest in that order', async () => {
    const h = makeHarness();
    addUser(h.db, 1);
    addUser(h.db, 2);
    addUser(h.db, 3);
    addReminder(h.db, 1, 1, '2026-03-22T21:15:00Z', '2026-03-22T21:00:00Z', '15 minutes');
    h.db.run("INSERT INTO notification_preferences (user_id, morning_agenda_time) VALUES (2, '21:00')");
    h.db.run('INSERT INTO notification_preferences (user_id, evening_review_enabled) VALUES (3, 1)');
    await h.scheduler.tick(new Date('2026-03-22T21:00:30Z'));
    expect(h.enqueued.map((e) => `${e.type}:${e.userId}`)).toEqual([
      'event_reminder:1',
      'morning_agenda:2',
      'evening_review:3',
      'weekly_digest:3',
    ]);
  });

  test('cleanup runs before reminders on Sunday 03:00 UTC', async () => {
    const h = makeHarness();
    addUser(h.db, 42);
    addReminder(h.db, 1, 42, '2026-03-22T03:15:00Z', '2026-03-22T03:00:00Z', '15 minutes');
    h.db.run(
      "INSERT INTO notification_log (user_id, type, reference_key, channel, status, created_at) VALUES (42, 'x', 'old', 'telegram_text', 'sent', datetime('now', '-90 days'))",
    );
    await h.scheduler.tick(new Date('2026-03-22T03:00:30Z'));
    const old = h.db.query("SELECT COUNT(*) AS n FROM notification_log WHERE reference_key = 'old'").get() as {
      n: number;
    };
    expect(old.n).toBe(0);
    expect(h.enqueued.map((e) => e.type)).toEqual(['event_reminder']);
  });
});

describe('pickBotTip – deterministic branches', () => {
  let randomSpy: Mock<() => number>;
  const l = t('en');

  function feedRandom(values: number[]): void {
    let i = 0;
    randomSpy = spyOn(Math, 'random').mockImplementation(() => {
      const v = values[i];
      i++;
      if (v === undefined) throw new Error(`Math.random called ${i} times, only ${values.length} values fed`);
      return v;
    });
  }

  beforeEach(() => {
    randomSpy = spyOn(Math, 'random');
  });
  afterEach(() => {
    randomSpy.mockRestore();
  });

  const noFeatures: TipContext = {
    hasMorningAgenda: false,
    hasEveningReview: false,
    hasQuietHours: false,
    hasGoogle: false,
    hasCountry: false,
    hasVoiceCalls: false,
  };
  const allFeatures: TipContext = {
    hasMorningAgenda: true,
    hasEveningReview: true,
    hasQuietHours: true,
    hasGoogle: true,
    hasCountry: true,
    hasVoiceCalls: true,
  };

  test('returns null when the first roll is above 0.5', () => {
    feedRandom([0.51]);
    expect(pickBotTip('en')).toBeNull();
  });

  test('contextual candidates are ordered evening, morning, quiet hours, google, country, voice', () => {
    feedRandom([0.1, 0.1, 0]);
    expect(pickBotTip('en', noFeatures)).toBe(l.contextualTips.noEveningReview);
    randomSpy.mockRestore();
    feedRandom([0.1, 0.1, 0.99]);
    expect(pickBotTip('en', noFeatures)).toBe(l.contextualTips.noVoiceCalls);
    randomSpy.mockRestore();
    feedRandom([0.1, 0.1, 0.5]);
    expect(pickBotTip('en', noFeatures)).toBe(l.contextualTips.noGoogleCalendar);
  });

  test('a contextual roll with no missing features falls through to the tip/quote roll', () => {
    feedRandom([0.1, 0.1, 0.9, 0]);
    expect(pickBotTip('en', allFeatures)).toBe(l.gtdQuotes[0]!);
  });

  test('a failed contextual roll falls through to a bot tip', () => {
    feedRandom([0.1, 0.9, 0.1, 0]);
    expect(pickBotTip('en', noFeatures)).toBe(Object.values(l.botTips)[0]!);
  });

  test('without a context the contextual roll is not consumed', () => {
    feedRandom([0.1, 0.1, 0]);
    expect(pickBotTip('en')).toBe(Object.values(l.botTips)[0]!);
  });

  test('quote pool is gtd, atomic habits, deep work, seven habits in order', () => {
    const quotes = [...l.gtdQuotes, ...l.atomicHabitsQuotes, ...l.deepWorkQuotes, ...l.sevenHabitsQuotes];
    feedRandom([0.1, 0.9, 0.9999]);
    expect(pickBotTip('en')).toBe(quotes.at(-1)!);
  });

  test('re-engagement tip is chosen when rolled under 0.4 and a stale well-known feature exists', () => {
    const keys = Object.keys(l.botTips);
    const staleKey = keys.find((k) => k === 'recurring_events')!;
    const staleDate = new Date(Date.now() - 60 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    const ctx: TipContext = {
      ...allFeatures,
      featureUsage: [{ user_id: 1, feature_key: 'recurrence', use_count: 20, last_used_at: staleDate }],
    };
    // tip branch, 40% re-engage roll passes, pick the first re-engage candidate
    feedRandom([0.1, 0.9, 0.1, 0.1, 0]);
    const result = pickBotTip('en', ctx);
    expect(result).toBe((l.botTips as Record<string, string>)[staleKey]!);
  });

  test('without re-engagement a recently-used feature tip is filtered out of the normal pool', () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const ctx: TipContext = {
      ...allFeatures,
      featureUsage: [{ user_id: 1, feature_key: 'recurrence', use_count: 10, last_used_at: now }],
    };
    const entries = Object.entries(l.botTips);
    const filtered = entries.filter(([k]) => k !== 'recurring_events' && k !== 'complex_recurrence');
    // tip branch; no re-engage candidates so only the normal pick consumes a roll
    feedRandom([0.1, 0.9, 0.1, 0]);
    expect(pickBotTip('en', ctx)).toBe(filtered[0]![1]);
  });

  test('when feature usage covers every mapped tip only unmapped tips stay in the normal pool', () => {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const mappedFeatures = new Set(Object.values(BOT_TIP_FEATURE_MAP));
    const usage = [...mappedFeatures].map((feature_key) => ({
      user_id: 1,
      feature_key,
      use_count: 10,
      last_used_at: now,
    }));
    const entries = Object.entries(l.botTips);
    const unmapped = entries.filter(([k]) => !BOT_TIP_FEATURE_MAP[k]);
    const ctx: TipContext = { ...allFeatures, featureUsage: usage };
    feedRandom([0.1, 0.9, 0.1, 0.9999]);
    const expected = unmapped.length > 0 ? unmapped.at(-1)![1] : entries.at(-1)![1];
    expect(pickBotTip('en', ctx)).toBe(expected);
  });
});
