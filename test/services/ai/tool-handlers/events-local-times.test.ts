/**
 * Event tool output must show the user's wall clock (weekday, date, time, zone) and label the
 * stored instants as UTC, so the model never presents a UTC clock time as local time.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  handleCreateEvent,
  handleGetEvent,
  handleGetEvents,
  handleGetUpcoming,
  handleSearchEvents,
  handleSnoozeEvent,
  handleUpdateEvent,
} from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../../src/services/conversation-logger.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

const USER_ID = 716_000_001;
// Sunday evening in Belgrade; the Monday event below is in the future.
const NOW = new Date('2026-09-27T21:00:00Z');
const START = '2026-09-28T10:30:00.000Z';
const END = '2026-09-28T11:30:00.000Z';
const BELGRADE_LOCAL = 'local: Mon 2026-09-28 12:30–13:30 (Europe/Belgrade)';

function buildCtx(timezone: string): AgentContext {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  userRepo.create({ telegram_id: USER_ID, timezone });
  const chatHistory = new ChatHistoryRepository(db);
  return {
    user: userRepo.findByTelegramId(USER_ID)!,
    chatId: USER_ID,
    messageText: '',
    isGroup: false,
    eventService: new EventService({ eventRepo: new EventRepository(db) }),
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    userRepo,
    eventReminderRepo: new EventReminderRepository(db),
    conversationLogger: new ConversationLogger(chatHistory),
  };
}

function seed(
  ctx: AgentContext,
  fields: { start_at: string; end_at?: string; all_day?: boolean; recurrence_rule?: string },
): number {
  return ctx.eventService.createEvent({ user_id: USER_ID, title: 'Lesson', timezone: ctx.user.timezone, ...fields }).id;
}

async function getEventOutput(ctx: AgentContext, id: number): Promise<string> {
  const result = await handleGetEvent(ctx, { event_id: id });
  expect(result.success).toBe(true);
  return result.output ?? '';
}

beforeEach(() => setSystemTime(NOW));
afterEach(() => setSystemTime());

describe('event tools report local wall-clock times (Europe/Belgrade)', () => {
  let ctx: AgentContext;
  let id: number;

  beforeEach(() => {
    ctx = buildCtx('Europe/Belgrade');
    id = seed(ctx, { start_at: START, end_at: END });
  });

  function expectLocalLine(output: string, eventId = id): void {
    expect(output).toContain(
      `id: ${eventId}, title: Lesson, ${BELGRADE_LOCAL}, start_utc: 2026-09-28T10:30:00.000Z, end_utc: 2026-09-28T11:30:00.000Z`,
    );
    expect(output).not.toContain('10:30–');
    expect(output).not.toMatch(/\bstart: /);
  }

  test('get_events', async () => {
    const result = await handleGetEvents(ctx, { start_date: '2026-09-28', end_date: '2026-09-28' });
    expectLocalLine(result.output ?? '');
  });

  test('search_events', async () => {
    const result = await handleSearchEvents(ctx, { query: 'Lesson' });
    expectLocalLine(result.output ?? '');
  });

  test('get_upcoming', async () => {
    const result = await handleGetUpcoming(ctx, {});
    expectLocalLine(result.output ?? '');
  });

  test('get_event', async () => {
    expectLocalLine(await getEventOutput(ctx, id));
  });

  test('update_event', async () => {
    const result = await handleUpdateEvent(ctx, { event_id: id, description: 'room 4' });
    expect(result.success).toBe(true);
    expectLocalLine(result.output ?? '');
  });

  test('create_event', async () => {
    const result = await handleCreateEvent(ctx, { title: 'Lesson', start_at: START, end_at: END });
    expect(result.success).toBe(true);
    expectLocalLine(result.output ?? '', id + 1);
  });

  test('an instant stored with an offset is reported as UTC', async () => {
    const result = await handleCreateEvent(ctx, {
      title: 'Offset',
      start_at: '2026-09-28T12:30:00+02:00',
      end_at: '2026-09-28T13:30:00+02:00',
    });
    expect(result.output).toContain(
      `${BELGRADE_LOCAL}, start_utc: 2026-09-28T10:30:00.000Z, end_utc: 2026-09-28T11:30:00.000Z`,
    );
  });

  test('snooze_event reports the new start as local time and labelled UTC', () => {
    const result = handleSnoozeEvent(ctx, { event_id: id, minutes: 15 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Mon 2026-09-28 12:45 (Europe/Belgrade)');
    expect(result.output).toContain('start_utc: 2026-09-28T10:45:00.000Z');
    expect(result.output).not.toMatch(/New start: 2026-/);
  });
});

describe('local rendering edge cases', () => {
  test('a UTC Monday-night start is the local Tuesday', async () => {
    const ctx = buildCtx('Europe/Belgrade');
    const id = seed(ctx, { start_at: '2026-09-28T23:00:00.000Z', end_at: '2026-09-29T00:00:00.000Z' });
    expect(await getEventOutput(ctx, id)).toContain('local: Tue 2026-09-29 01:00–02:00 (Europe/Belgrade)');
  });

  test('an event crossing local midnight shows both local days', async () => {
    const ctx = buildCtx('Europe/Belgrade');
    const id = seed(ctx, { start_at: '2026-09-28T21:00:00.000Z', end_at: '2026-09-28T23:00:00.000Z' });
    expect(await getEventOutput(ctx, id)).toContain(
      'local: Mon 2026-09-28 23:00 – Tue 2026-09-29 01:00 (Europe/Belgrade)',
    );
  });

  test('an event without an end shows only the local start', async () => {
    const ctx = buildCtx('Europe/Belgrade');
    const id = seed(ctx, { start_at: START });
    const output = await getEventOutput(ctx, id);
    expect(output).toContain(`local: Mon 2026-09-28 12:30 (Europe/Belgrade), start_utc: ${START}`);
    expect(output).not.toContain('end_utc');
  });

  test('an all-day event shows its calendar date without a clock time', async () => {
    const ctx = buildCtx('America/Los_Angeles');
    const id = seed(ctx, { start_at: '2026-09-28T00:00:00Z', all_day: true });
    const output = await getEventOutput(ctx, id);
    expect(output).toContain('local: Mon 2026-09-28 all day, start_date: 2026-09-28');
    expect(output).not.toContain('start_utc');
    expect(output).not.toMatch(/local: [^,]*\d{2}:\d{2}/);
  });

  test('a multi-day all-day event treats the later end date as exclusive', async () => {
    const ctx = buildCtx('Europe/Belgrade');
    const id = seed(ctx, { start_at: '2026-09-27', end_at: '2026-09-30', all_day: true });
    expect(await getEventOutput(ctx, id)).toContain(
      'local: Sun 2026-09-27 – Tue 2026-09-29 all day, start_date: 2026-09-27, end_date_exclusive: 2026-09-30',
    );
  });

  test('an all-day end on its own start date is a single day with no exclusive end', async () => {
    const ctx = buildCtx('Europe/Belgrade');
    const id = seed(ctx, { start_at: '2026-09-28', end_at: '2026-09-28', all_day: true });
    const output = await getEventOutput(ctx, id);
    expect(output).toContain('local: Mon 2026-09-28 all day, start_date: 2026-09-28');
    expect(output).not.toContain('end_date');
  });

  test('a snoozed all-day event reports the exact new start, not an unchanged day', async () => {
    const ctx = buildCtx('Europe/Belgrade');
    const id = seed(ctx, { start_at: '2026-09-28T00:00:00Z', all_day: true });
    const result = handleSnoozeEvent(ctx, { event_id: id, minutes: 10 });
    expect(result.output).toContain(
      'local: Mon 2026-09-28 02:10 (Europe/Belgrade), start_utc: 2026-09-28T00:10:00.000Z',
    );
  });

  test('after the autumn DST shift 09:00Z is 10:00 in Belgrade', async () => {
    const ctx = buildCtx('Europe/Belgrade');
    const id = seed(ctx, { start_at: '2026-10-25T09:00:00.000Z', end_at: '2026-10-25T10:00:00.000Z' });
    expect(await getEventOutput(ctx, id)).toContain('local: Sun 2026-10-25 10:00–11:00 (Europe/Belgrade)');
  });

  test('after the spring DST shift Belgrade is UTC+2', async () => {
    const ctx = buildCtx('Europe/Belgrade');
    const id = seed(ctx, { start_at: '2026-03-29T09:00:00.000Z', end_at: '2026-03-29T10:00:00.000Z' });
    expect(await getEventOutput(ctx, id)).toContain('local: Sun 2026-03-29 11:00–12:00 (Europe/Belgrade)');
  });

  test('recurring occurrences use their own start across the DST shift', async () => {
    const ctx = buildCtx('Europe/Belgrade');
    // 10:00 local daily: 08:00Z in summer time, 09:00Z after the 2026-10-25 shift.
    seed(ctx, {
      start_at: '2026-10-24T08:00:00.000Z',
      end_at: '2026-10-24T09:00:00.000Z',
      recurrence_rule: 'FREQ=DAILY;COUNT=2',
    });
    const result = await handleGetEvents(ctx, { start_date: '2026-10-24', end_date: '2026-10-25' });
    const output = result.output ?? '';
    expect(output).toContain(
      'local: Sat 2026-10-24 10:00–11:00 (Europe/Belgrade), start_utc: 2026-10-24T08:00:00.000Z',
    );
    expect(output).toContain(
      'local: Sun 2026-10-25 10:00–11:00 (Europe/Belgrade), start_utc: 2026-10-25T09:00:00.000Z',
    );
  });

  test('for a UTC user the local clock equals the UTC clock', async () => {
    const ctx = buildCtx('UTC');
    const id = seed(ctx, { start_at: START, end_at: END });
    expect(await getEventOutput(ctx, id)).toContain(`local: Mon 2026-09-28 10:30–11:30 (UTC), start_utc: ${START}`);
  });
});
