// create_event is idempotent for a repeat of the same request: the same owner asking again, within
// minutes, for an event with the same title, start and end gets the event that already exists back as
// a successful receipt instead of a second row (#520, #929 — the 2026-11-01 duplicates).
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { NotificationPreferencesRepository } from '../../../../src/database/repositories/notification-preferences.repository.ts';
import { SecretaryRepository } from '../../../../src/database/repositories/secretary.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../../src/services/ai/tool-executor.ts';
import { handleCreateEvent } from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext, ToolResult } from '../../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../../src/services/conversation-logger.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import { ReminderMaterializer } from '../../../../src/services/notification/materializer.ts';
import { partialOf } from '../partial-stubs.ts';
import { createEventToolFixture, type EventToolFixture, USER_ID } from './events-fixtures.ts';

/** The id of the event a create_event result describes. */
function eventIdOf(result: ToolResult): number {
  const data = result.data;
  if (data && typeof data === 'object' && 'id' in data && typeof data.id === 'number') return data.id;
  throw new Error('create_event result carries no event id');
}

const STANDUP = { title: 'Synthetic Standup', start_at: '2030-03-05T10:00:00Z', end_at: '2030-03-05T10:30:00Z' };

describe('create_event repeated within minutes', () => {
  let db: EventToolFixture['db'];
  let ctx: AgentContext;

  beforeEach(() => {
    _resetToolThrottleForTest();
    ({ db, ctx } = createEventToolFixture());
  });

  const rows = (userId = USER_ID) =>
    db.prepare('SELECT id, title FROM events WHERE user_id = ? AND is_deleted = 0 ORDER BY id').all(userId) as {
      id: number;
      title: string;
    }[];

  /** What a later run of the same chat looks like: its own context, sharing the calendar. */
  const laterRun = (): AgentContext => ({ ...ctx, createdEventIds: undefined });

  const ageEvents = (minutes: number) =>
    db.prepare("UPDATE events SET created_at = datetime('now', ?)").run(`-${minutes} minutes`);

  test('returns the existing event as a successful receipt and keeps one row', async () => {
    const first = await handleCreateEvent(ctx, { ...STANDUP });
    const second = await handleCreateEvent(laterRun(), { ...STANDUP });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.output).toContain('already exists');
    expect(second.data).toMatchObject({ title: STANDUP.title });
    expect(rows()).toHaveLength(1);
    expect(eventIdOf(second)).toBe(eventIdOf(first));
    expect(rows().map((row) => row.id)).toEqual([eventIdOf(second)]);
    expect(second.agentHint).toContain('Do NOT call create_event again');
  });

  test('the receipt tells how to make a deliberate second copy, and that flag creates it', async () => {
    await handleCreateEvent(ctx, { ...STANDUP });
    const repeat = await handleCreateEvent(laterRun(), { ...STANDUP });
    expect(repeat.agentHint).toContain('allow_duplicate');

    const deliberate = await handleCreateEvent(laterRun(), { ...STANDUP, allow_duplicate: true });
    expect(deliberate.success).toBe(true);
    expect(deliberate.output).not.toContain('already exists');
    expect(rows()).toHaveLength(2);
  });

  test('titles match after trimming, collapsing spaces and folding case, Cyrillic included', async () => {
    await handleCreateEvent(ctx, { title: 'Встреча с  Леной', start_at: '2030-03-06T09:00:00Z' });
    const again = await handleCreateEvent(laterRun(), {
      title: '  встреча С леной ',
      start_at: '2030-03-06T09:00:00Z',
    });
    expect(again.output).toContain('already exists');
    expect(rows()).toHaveLength(1);
  });

  test('the same instant spelled with another offset is the same event', async () => {
    await handleCreateEvent(ctx, { title: 'Offset', start_at: '2030-03-06T09:00:00Z', end_at: '2030-03-06T10:00:00Z' });
    const again = await handleCreateEvent(laterRun(), {
      title: 'Offset',
      start_at: '2030-03-06T11:00:00+02:00',
      end_at: '2030-03-06T12:00:00+02:00',
    });
    expect(again.output).toContain('already exists');
    expect(rows()).toHaveLength(1);
  });

  test.each([
    ['another title', { title: 'Synthetic Review' }],
    ['another day', { start_at: '2030-03-06T10:00:00Z', end_at: '2030-03-06T10:30:00Z' }],
  ])('%s is a different event and is created', async (_name, change) => {
    await handleCreateEvent(ctx, { ...STANDUP });
    const other = await handleCreateEvent(laterRun(), { ...STANDUP, ...change });
    expect(other.success).toBe(true);
    expect(other.output).not.toContain('already exists');
    expect(rows()).toHaveLength(2);
  });

  // #520: the same title on the same local day at another time is a move done by creating, or a second copy.
  test.each([
    ['another start', { start_at: '2030-03-05T11:00:00Z', end_at: '2030-03-05T11:30:00Z' }],
    ['another end', { end_at: '2030-03-05T11:00:00Z' }],
    ['no end', { end_at: undefined }],
  ])('%s on the same day is refused with a pointer to update_event', async (_name, change) => {
    const first = await handleCreateEvent(ctx, { ...STANDUP });
    const other = await handleCreateEvent(laterRun(), { ...STANDUP, ...change });
    expect(other.success).toBe(false);
    expect(other.mutationState).toBe('not_applied');
    expect(other.error).toContain(`id: ${eventIdOf(first)}`);
    expect(other.error).toContain('nothing was created');
    expect(other.error).not.toContain('update_event'); // the message is for the person; the route is for the model
    expect(other.agentHint).toContain('update_event');
    expect(other.agentHint).toContain('allow_duplicate');
    expect(rows()).toHaveLength(1);
  });

  test('allow_duplicate confirms a same-day second event', async () => {
    await handleCreateEvent(ctx, { ...STANDUP });
    const second = await handleCreateEvent(laterRun(), {
      ...STANDUP,
      start_at: '2030-03-05T16:00:00Z',
      end_at: '2030-03-05T16:30:00Z',
      allow_duplicate: true,
    });
    expect(second.success).toBe(true);
    expect(rows()).toHaveLength(2);
  });

  test('the same day is the user’s local day, not the UTC date', async () => {
    const la: AgentContext = { ...ctx, user: { ...ctx.user, timezone: 'America/Los_Angeles' } };
    // 2030-03-06T02:00Z is still 5 March in Los Angeles; 2030-03-05T10:00Z is 5 March there too.
    await handleCreateEvent(la, { title: 'Late Call', start_at: '2030-03-06T02:00:00Z' });
    const sameLocalDay = await handleCreateEvent(la, { title: 'Late Call', start_at: '2030-03-05T18:00:00Z' });
    expect(sameLocalDay.success).toBe(false);
    const nextLocalDay = await handleCreateEvent(la, { title: 'Late Call', start_at: '2030-03-06T18:00:00Z' });
    expect(nextLocalDay.success).toBe(true);
    expect(rows()).toHaveLength(2);
  });

  test('a repeat that states different details is not reported as already existing', async () => {
    await handleCreateEvent(ctx, { ...STANDUP });
    const withRoom = await handleCreateEvent(laterRun(), { ...STANDUP, location: 'Room 5' });
    expect(withRoom.success).toBe(false);
    expect(withRoom.agentHint).toContain('update_event');
    const withReminder = await handleCreateEvent(laterRun(), { ...STANDUP, reminder_minutes: [60] });
    expect(withReminder.success).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  test('a repeat that states the same details is still the same request', async () => {
    const detailed = { ...STANDUP, location: 'Room 5', description: 'Weekly', reminder_minutes: [15, 60] };
    await handleCreateEvent(ctx, detailed);
    const again = await handleCreateEvent(laterRun(), { ...detailed, location: ' Room 5 ' });
    expect(again.success).toBe(true);
    expect(again.output).toContain('already exists');
    expect(rows()).toHaveLength(1);
  });

  test('an all-day event and a timed one at the same moment are different events', async () => {
    await handleCreateEvent(ctx, { title: 'Holiday', start_at: '2030-03-05', all_day: true });
    await handleCreateEvent(laterRun(), { title: 'Holiday', start_at: '2030-03-05T00:00:00Z' });
    expect(rows()).toHaveLength(2);
  });

  test('a deleted or cancelled event does not stand in for a new one', async () => {
    const created = await handleCreateEvent(ctx, { ...STANDUP });
    db.prepare('UPDATE events SET is_deleted = 1 WHERE id = ?').run(eventIdOf(created));
    const again = await handleCreateEvent(laterRun(), { ...STANDUP });
    expect(again.output).not.toContain('already exists');
    db.prepare('UPDATE events SET is_cancelled = 1 WHERE id = ?').run(eventIdOf(again));
    const third = await handleCreateEvent(laterRun(), { ...STANDUP });
    expect(third.output).not.toContain('already exists');
    expect(rows()).toHaveLength(2); // the deleted one is hidden; the cancelled one and the new one remain
  });

  test('an identical event created longer ago than the window is not a repeat but still needs confirmation', async () => {
    await handleCreateEvent(ctx, { ...STANDUP });
    ageEvents(11);
    const again = await handleCreateEvent(laterRun(), { ...STANDUP });
    expect(again.success).toBe(false);
    expect(again.agentHint).toContain('SAME_DAY_EVENT');
    expect(again.output).toBeUndefined();
    expect(rows()).toHaveLength(1);
    const confirmed = await handleCreateEvent(laterRun(), { ...STANDUP, allow_duplicate: true });
    expect(confirmed.success).toBe(true);
    expect(rows()).toHaveLength(2);
  });

  test('an event created a few minutes ago is still matched', async () => {
    await handleCreateEvent(ctx, { ...STANDUP });
    ageEvents(4);
    const again = await handleCreateEvent(laterRun(), { ...STANDUP });
    expect(again.output).toContain('already exists');
    expect(rows()).toHaveLength(1);
  });

  test('recurring events are never matched, whichever side is recurring', async () => {
    await handleCreateEvent(ctx, { ...STANDUP, recurrence_rule: 'FREQ=WEEKLY' });
    await handleCreateEvent(laterRun(), { ...STANDUP, recurrence_rule: 'FREQ=WEEKLY' });
    await handleCreateEvent(laterRun(), { ...STANDUP });
    expect(rows()).toHaveLength(3);
    const once = await handleCreateEvent(laterRun(), { ...STANDUP });
    expect(once.output).toContain('already exists'); // the one-off from the line above, not the recurring ones
    expect(rows()).toHaveLength(3);
  });

  test('another owner’s identical event is not matched', async () => {
    const other = 888;
    ctx.userRepo.create({ telegram_id: other, timezone: 'UTC' });
    await handleCreateEvent(ctx, { ...STANDUP });
    const otherCtx: AgentContext = { ...laterRun(), user: ctx.userRepo.findByTelegramId(other)!, chatId: other };
    const result = await handleCreateEvent(otherCtx, { ...STANDUP });
    expect(result.output).not.toContain('already exists');
    expect(rows(USER_ID)).toHaveLength(1);
    expect(rows(other)).toHaveLength(1);
  });

  test('a secretary creating for an owner is matched against the owner’s calendar', async () => {
    const owner = 999;
    ctx.userRepo.create({ telegram_id: owner, timezone: 'UTC' });
    const secretaryRepo = new SecretaryRepository(db);
    const grant = secretaryRepo.upsert({ owner_id: owner, secretary_id: USER_ID, permission: 'write' });
    secretaryRepo.updateStatus(grant.id, 'active');
    const secretaryCtx: AgentContext = {
      ...ctx,
      secretary: partialOf<NonNullable<AgentContext['secretary']>>('secretary', { secretaryRepo }),
    };
    await handleCreateEvent(secretaryCtx, { ...STANDUP, owner_id: owner });
    const again = await handleCreateEvent(
      { ...secretaryCtx, createdEventIds: undefined },
      { ...STANDUP, owner_id: owner },
    );
    expect(again.output).toContain('already exists');
    expect(rows(owner)).toHaveLength(1);
    expect(rows(USER_ID)).toHaveLength(0);
    // the owner creating the same thing by themselves is the same calendar too
    const ownerCtx: AgentContext = { ...ctx, user: ctx.userRepo.findByTelegramId(owner)!, chatId: owner };
    const byOwner = await handleCreateEvent(ownerCtx, { ...STANDUP });
    expect(byOwner.output).toContain('already exists');
    expect(rows(owner)).toHaveLength(1);
  });

  describe('in a group', () => {
    const GROUP = -100777;
    const groupCtx = (groupChatId: number): AgentContext => ({
      ...ctx,
      isGroup: true,
      groupChatId,
      chatId: groupChatId,
      groupTitle: 'Synthetic Group',
    });

    test('is compared inside the group only', async () => {
      await handleCreateEvent(groupCtx(GROUP), { ...STANDUP, scope: 'group' });
      const sameGroup = await handleCreateEvent(groupCtx(GROUP), { ...STANDUP, scope: 'group' });
      expect(sameGroup.output).toContain('already exists');
      const otherGroup = await handleCreateEvent(groupCtx(GROUP - 1), { ...STANDUP, scope: 'group' });
      expect(otherGroup.output).not.toContain('already exists');
      const personal = await handleCreateEvent(ctx, { ...STANDUP });
      expect(personal.output).not.toContain('already exists');
      const groupRows = db.prepare("SELECT id FROM events WHERE owner_type = 'group' AND is_deleted = 0").all();
      expect(groupRows).toHaveLength(2);
    });
  });

  test('a repeat is not a second creation: no reminders, notifications, calendar push or delete rights', async () => {
    const reminders = mock(() => {});
    const emitted = mock(() => {});
    const push = mock(async () => {});
    const eventRepo = new EventRepository(db);
    const service = new EventService({
      eventRepo,
      materializer: partialOf<NonNullable<ConstructorParameters<typeof EventService>[0]['materializer']>>(
        'materializer',
        { materialize: reminders },
      ),
      domainEvents: partialOf<NonNullable<ConstructorParameters<typeof EventService>[0]['domainEvents']>>('bus', {
        emit: emitted,
      }),
    });
    const wired: AgentContext = {
      ...ctx,
      eventService: service,
      google: partialOf<NonNullable<AgentContext['google']>>('google', { schedulePush: push }),
    };
    await handleCreateEvent(wired, { ...STANDUP });
    expect([reminders.mock.calls.length, emitted.mock.calls.length, push.mock.calls.length]).toEqual([1, 1, 1]);

    const later = { ...wired, createdEventIds: undefined };
    const repeat = await handleCreateEvent(later, { ...STANDUP });
    expect(repeat.output).toContain('already exists');
    expect([reminders.mock.calls.length, emitted.mock.calls.length, push.mock.calls.length]).toEqual([1, 1, 1]);
    expect(later.createdEventIds).toBeUndefined(); // the event is not this run's creation
  });

  test('the executor accepts allow_duplicate and rejects a non-boolean', async () => {
    await executeTool(ctx, 'create_event', { ...STANDUP });
    _resetToolThrottleForTest();
    const repeat = await executeTool(laterRun(), 'create_event', { ...STANDUP });
    expect(repeat.success).toBe(true);
    expect(repeat.mutationState).toBe('not_applied'); // nothing was written by this call
    expect(repeat.output).toContain('already exists');
    _resetToolThrottleForTest();
    const deliberate = await executeTool(laterRun(), 'create_event', { ...STANDUP, allow_duplicate: 'true' });
    expect(deliberate.success).toBe(true);
    expect(rows()).toHaveLength(2);
    _resetToolThrottleForTest();
    const invalid = await executeTool(laterRun(), 'create_event', { ...STANDUP, allow_duplicate: 'maybe' });
    expect(invalid.success).toBe(false);
    expect(rows()).toHaveLength(2);
  });
});

describe('create_event repeated across connections and restarts', () => {
  let dir: string;

  beforeEach(() => {
    _resetToolThrottleForTest();
    dir = mkdtempSync(path.join(tmpdir(), 'hcb-duplicate-create-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A bot process: its own connection, repositories and services over the same database file. */
  function startProcess(file: string): { ctx: AgentContext; db: Database } {
    const db = new Database(file);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    runMigrations(db, migrations);
    const userRepo = new UserRepository(db);
    if (!userRepo.findByTelegramId(USER_ID)) userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const eventRepo = new EventRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const ctx: AgentContext = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      isGroup: false,
      eventService: new EventService({ eventRepo }),
      holidayService: new HolidayService(new HolidayRepository(db)),
      chatHistory: chatHistoryRepo,
      userRepo,
      eventReminderRepo: new EventReminderRepository(db),
      conversationLogger: new ConversationLogger(chatHistoryRepo),
    };
    return { ctx, db };
  }

  test('a process that starts later still sees the event created by the one before it', async () => {
    const file = path.join(dir, 'calendar.db');
    const before = startProcess(file);
    await handleCreateEvent(before.ctx, { ...STANDUP });
    before.db.close();

    const after = startProcess(file);
    const repeat = await handleCreateEvent(after.ctx, { ...STANDUP });
    expect(repeat.output).toContain('already exists');
    expect(after.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    after.db.close();
  });

  test('two connections creating the same event hold one row between them', async () => {
    const file = path.join(dir, 'calendar.db');
    const a = startProcess(file);
    const b = startProcess(file);
    const results = await Promise.all([
      handleCreateEvent(a.ctx, { ...STANDUP }),
      handleCreateEvent(b.ctx, { ...STANDUP }),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    expect(results.filter((result) => result.output?.includes('already exists'))).toHaveLength(1);
    expect(a.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    a.db.close();
    b.db.close();
  });
});

describe('create_event all-day repeats', () => {
  test('an all-day event is the same event whether its start came as local midnight or as a date', async () => {
    _resetToolThrottleForTest();
    const { db, ctx } = createEventToolFixture();
    const belgrade: AgentContext = { ...ctx, user: { ...ctx.user, timezone: 'Europe/Belgrade' } };
    const first = await handleCreateEvent(belgrade, {
      title: 'Synthetic Holiday',
      start_at: '2030-03-04T23:00:00Z',
      all_day: true,
    });
    const again = await handleCreateEvent(belgrade, {
      title: 'Synthetic Holiday',
      start_at: '2030-03-05',
      all_day: true,
    });
    const other = await handleCreateEvent(belgrade, {
      title: 'Synthetic Holiday',
      start_at: '2030-03-06',
      all_day: true,
    });

    expect(first.output).not.toContain('already exists');
    expect(again.output).toContain('already exists');
    expect(other.output).not.toContain('already exists');
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 2 });
  });

  const LA = (ctx: AgentContext): AgentContext => ({ ...ctx, user: { ...ctx.user, timezone: 'America/Los_Angeles' } });

  test('a floating all-day date is the same day in a zone west of UTC', async () => {
    _resetToolThrottleForTest();
    const { db, ctx } = createEventToolFixture();
    const la = LA(ctx);
    // A UTC midnight is the floating date 2030-03-05 everywhere, not 4 March at 16:00 in Los Angeles.
    await handleCreateEvent(la, { title: 'Floating Day', start_at: '2030-03-05T00:00:00Z', all_day: true });
    const sameDate = await handleCreateEvent(la, { title: 'Floating Day', start_at: '2030-03-05', all_day: true });
    expect(sameDate.success).toBe(true);
    expect(sameDate.output).toContain('already exists');
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });

    const dayBefore = await handleCreateEvent(la, { title: 'Floating Day', start_at: '2030-03-04', all_day: true });
    expect(dayBefore.success).toBe(true);
    expect(dayBefore.output).not.toContain('already exists');
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 2 });
  });

  test('the other way round: a date-only event, then the same date as a UTC midnight', async () => {
    _resetToolThrottleForTest();
    const { db, ctx } = createEventToolFixture();
    const la = LA(ctx);
    await handleCreateEvent(la, { title: 'Floating Day', start_at: '2030-03-05', all_day: true });
    const sameDate = await handleCreateEvent(la, {
      title: 'Floating Day',
      start_at: '2030-03-05T00:00:00Z',
      all_day: true,
    });
    expect(sameDate.output).toContain('already exists');
    const dayBefore = await handleCreateEvent(la, {
      title: 'Floating Day',
      start_at: '2030-03-04T00:00:00Z',
      all_day: true,
    });
    expect(dayBefore.output).not.toContain('already exists');
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 2 });
  });
});

describe('create_event next to events imported from another Google calendar', () => {
  test('an identical event of a secondary calendar does not stand in for a personal one', async () => {
    _resetToolThrottleForTest();
    const { db, ctx } = createEventToolFixture();
    new EventRepository(db).insertSyncedEvent({
      user_id: USER_ID,
      title: STANDUP.title,
      description: null,
      start_at: STANDUP.start_at,
      end_at: STANDUP.end_at,
      all_day: false,
      timezone: 'UTC',
      location: null,
      recurrence_rule: null,
      google_calendar_id: 'team@group.calendar.example',
      google_event_id: 'synthetic-team-1',
      google_etag: null,
      is_cancelled: false,
    });
    const personal = await handleCreateEvent(ctx, { ...STANDUP });
    expect(personal.success).toBe(true);
    expect(personal.output).not.toContain('already exists');
    const rows = db.prepare('SELECT id, google_calendar_id FROM events ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(eventIdOf(personal)).toBe(2);

    const repeat = await handleCreateEvent({ ...ctx, createdEventIds: undefined }, { ...STANDUP });
    expect(repeat.output).toContain('already exists');
    expect(eventIdOf(repeat)).toBe(2);
  });
});

describe('create_event next to the user’s primary Google calendar', () => {
  test('an event imported under the primary calendar’s concrete id is the same calendar', async () => {
    _resetToolThrottleForTest();
    const { db, ctx } = createEventToolFixture();
    db.prepare(
      "INSERT INTO google_calendars (user_id, google_calendar_id, calendar_name, is_primary, access_role) VALUES (?, 'owner@example.test', 'Synthetic', 1, 'owner')",
    ).run(USER_ID);
    const eventRepo = new EventRepository(db);
    const importEvent = (calendar: string, id: string) =>
      eventRepo.insertSyncedEvent({
        user_id: USER_ID,
        title: STANDUP.title,
        description: null,
        start_at: STANDUP.start_at,
        end_at: STANDUP.end_at,
        all_day: false,
        timezone: 'UTC',
        location: null,
        recurrence_rule: null,
        google_calendar_id: calendar,
        google_event_id: id,
        google_etag: null,
        is_cancelled: false,
      });
    importEvent('owner@example.test', 'synthetic-primary-1');
    const same = await handleCreateEvent(ctx, { ...STANDUP });
    expect(same.output).toContain('already exists');
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
  });
});

describe('create_event all-day dates read in the zone each event was saved with', () => {
  test('a Belgrade-saved group holiday is the same holiday for a member in Los Angeles', async () => {
    _resetToolThrottleForTest();
    const { db, ctx } = createEventToolFixture();
    const group = { ...ctx, isGroup: true, groupChatId: -9001 };
    const belgrade: AgentContext = { ...group, user: { ...ctx.user, timezone: 'Europe/Belgrade' } };
    const losAngeles: AgentContext = { ...group, user: { ...ctx.user, timezone: 'America/Los_Angeles' } };
    // 5 March in Belgrade is local midnight 2030-03-04T23:00Z.
    const first = await handleCreateEvent(belgrade, {
      title: 'Group Holiday',
      start_at: '2030-03-04T23:00:00Z',
      all_day: true,
      scope: 'group',
    });
    expect(first.success).toBe(true);
    const again = await handleCreateEvent(losAngeles, {
      title: 'Group Holiday',
      start_at: '2030-03-05',
      all_day: true,
      scope: 'group',
    });
    expect(again.output).toContain('already exists');
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
  });
});

describe('create_event is all or nothing', () => {
  test('a failed reminder write leaves no event, and the retry creates event and reminders together', async () => {
    _resetToolThrottleForTest();
    const { db, ctx } = createEventToolFixture();
    const reminderRepo = new EventReminderRepository(db);
    const realInsert = reminderRepo.insert.bind(reminderRepo);
    let failures = 1;
    reminderRepo.insert = (...args: Parameters<typeof realInsert>) => {
      if (failures-- > 0) throw new Error('synthetic reminder write failure');
      return realInsert(...args);
    };
    const service = new EventService({
      eventRepo: new EventRepository(db),
      materializer: new ReminderMaterializer(reminderRepo, new NotificationPreferencesRepository(db)),
    });
    const wired: AgentContext = { ...ctx, eventService: service };

    const failed = await handleCreateEvent(wired, { ...STANDUP });
    expect(failed.success).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });

    // The deliberate-copy path is just as atomic: a failed reminder write keeps no second event either.
    failures = 1;
    const failedCopy = await handleCreateEvent(wired, { ...STANDUP, allow_duplicate: true });
    expect(failedCopy.success).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });

    const retry = await handleCreateEvent(wired, { ...STANDUP });
    expect(retry.success).toBe(true);
    expect(retry.output).not.toContain('already exists');
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
    const reminders = db.prepare('SELECT COUNT(*) AS n FROM event_reminders WHERE event_id = ?').get(eventIdOf(retry));
    expect(reminders).not.toEqual({ n: 0 });
  });
});

describe('create_event reports a repeat as structured evidence', () => {
  test('the result names the event it found, and a fresh create carries none', async () => {
    _resetToolThrottleForTest();
    const { ctx } = createEventToolFixture();
    const first = await handleCreateEvent(ctx, { ...STANDUP });
    const repeat = await handleCreateEvent({ ...ctx, createdEventIds: undefined }, { ...STANDUP });
    expect(first.alreadyExists).toBeUndefined();
    expect(repeat.alreadyExists).toEqual({ entity: 'event', id: eventIdOf(first) });
  });
});
