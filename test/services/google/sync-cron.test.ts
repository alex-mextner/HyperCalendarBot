// test/services/google/sync-cron.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { queueHistoryBackfill } from '../../../src/services/google/sync-cron.ts';

function makeQueue() {
  return { add: mock(async () => ({ id: 'q-1' })) };
}

function makeSyncRepo(activeUsers: number[]) {
  return { getActiveUsers: mock(() => activeUsers) };
}

function makeCalendarRepo(calendarsPerUser: { google_calendar_id: string }[]) {
  return { getEnabledCalendars: mock(() => calendarsPerUser) };
}

describe('queueHistoryBackfill', () => {
  test('queues history-backfill job for each enabled calendar of each active user', async () => {
    const queue = makeQueue();
    const syncRepo = makeSyncRepo([1, 2]);
    const calendarRepo = makeCalendarRepo([{ google_calendar_id: 'cal-a' }]);

    await queueHistoryBackfill(queue as never, syncRepo as never, calendarRepo as never);

    expect(queue.add).toHaveBeenCalledTimes(2);
    const [name1, data1] = queue.add.mock.calls[0] as unknown as [
      string,
      { type: string; userId: number; calendarId: string },
    ];
    expect(name1).toBe('history-backfill');
    expect(data1.type).toBe('history-backfill');
    expect(data1.userId).toBe(1);
    expect(data1.calendarId).toBe('cal-a');
  });

  test('queues nothing when no active users', async () => {
    const queue = makeQueue();
    const syncRepo = makeSyncRepo([]);
    const calendarRepo = makeCalendarRepo([]);

    await queueHistoryBackfill(queue as never, syncRepo as never, calendarRepo as never);

    expect(queue.add).not.toHaveBeenCalled();
  });

  test('queues multiple jobs for user with multiple calendars', async () => {
    const queue = makeQueue();
    const syncRepo = makeSyncRepo([1]);
    const calendarRepo = makeCalendarRepo([{ google_calendar_id: 'cal-a' }, { google_calendar_id: 'cal-b' }]);

    await queueHistoryBackfill(queue as never, syncRepo as never, calendarRepo as never);

    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  test('uses deterministic jobId to prevent duplicate jobs', async () => {
    const queue = makeQueue();
    const syncRepo = makeSyncRepo([1]);
    const calendarRepo = makeCalendarRepo([{ google_calendar_id: 'cal-a' }]);

    await queueHistoryBackfill(queue as never, syncRepo as never, calendarRepo as never);

    const [, , opts] = queue.add.mock.calls[0] as unknown as [string, unknown, { jobId: string }];
    expect(opts.jobId).toBe('backfill-1-cal-a');
  });
});
