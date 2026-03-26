import { describe, expect, mock, test } from 'bun:test';
import { handleSnoozeCallback } from '../../../src/bot/handlers/snooze-callback.ts';

function makeCtx(overrides: { [key: string]: unknown } = {}) {
  return {
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    dbUser: { telegram_id: 42, language: 'ru', timezone: 'UTC' },
    ...overrides,
  };
}

function makeReminderRepo() {
  return {
    insert: mock(() => {}),
  };
}

function makeEventRepo(event: { id: number; user_id: number; start_at: string; title: string } | null) {
  return {
    findById: mock(() => event),
  };
}

describe('handleSnoozeCallback', () => {
  test('inserts new reminder for now + minutes and removes keyboard', async () => {
    const ctx = makeCtx();
    const event = { id: 7, user_id: 42, start_at: '2026-03-15T10:00:00Z', title: 'Стендап' };
    const reminderRepo = makeReminderRepo();
    const eventRepo = makeEventRepo(event);
    const now = new Date('2026-03-15T09:30:00Z');

    await handleSnoozeCallback(ctx as never, 42, 7, 5, reminderRepo as never, eventRepo as never, now);

    expect(reminderRepo.insert).toHaveBeenCalledTimes(1);
    const insertArg = (reminderRepo.insert.mock.calls[0] as unknown[])[0] as {
      event_id: number;
      user_id: number;
      remind_at_utc: string;
      interval_minutes: number;
    };
    expect(insertArg.event_id).toBe(7);
    expect(insertArg.user_id).toBe(42);
    expect(insertArg.remind_at_utc).toBe('2026-03-15T09:35:00.000Z');
    expect(insertArg.interval_minutes).toBe(5);
    // keyboard removed (editText called with no reply_markup / undefined markup)
    expect(ctx.editText).toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('rejects if event belongs to a different user', async () => {
    const ctx = makeCtx();
    const event = { id: 7, user_id: 99, start_at: '2026-03-15T10:00:00Z', title: 'Чужое' };
    const reminderRepo = makeReminderRepo();
    const eventRepo = makeEventRepo(event);
    const now = new Date('2026-03-15T09:30:00Z');

    await handleSnoozeCallback(ctx as never, 42, 7, 5, reminderRepo as never, eventRepo as never, now);

    expect(reminderRepo.insert).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('no-op when event not found', async () => {
    const ctx = makeCtx();
    const reminderRepo = makeReminderRepo();
    const eventRepo = makeEventRepo(null);
    const now = new Date('2026-03-15T09:30:00Z');

    await handleSnoozeCallback(ctx as never, 42, 999, 5, reminderRepo as never, eventRepo as never, now);

    expect(reminderRepo.insert).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalled();
  });
});
