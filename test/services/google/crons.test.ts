// Cron tests inject queues, repositories and API factories without Redis or Google access.
import { afterEach, expect, mock, setSystemTime, test } from 'bun:test';
import { OAuth2Client } from 'google-auth-library';
import type { EnvConfig } from '../../../src/config/env.ts';
import { executeCleanup, setupCleanupCron } from '../../../src/services/google/cleanup-cron.ts';
import { executeSyncCronTick, setupSyncCron } from '../../../src/services/google/sync-cron.ts';
import { renewExpiringChannels, setupWatchRenewalCron } from '../../../src/services/google/watch-renewal-cron.ts';

const now = Date.parse('2026-09-13T12:00:00Z');
afterEach(() => setSystemTime());
function queueFixture() {
  const add = mock(async () => {
    return { id: 'offline' };
  });
  return { add, queue: { add } };
}

test('cron setup registers exact repeat intervals and propagates queue failures', async () => {
  for (const [setup, name, type, every] of [
    [setupCleanupCron, 'cleanup-tick', 'cron-cleanup-tick', 86400000],
    [setupSyncCron, 'sync-cron-tick', 'cron-sync-tick', 900000],
    [setupWatchRenewalCron, 'watch-renewal-tick', 'cron-watch-renewal-tick', 21600000],
  ] as const) {
    const f = queueFixture();
    await setup(f.queue);
    expect(f.add).toHaveBeenCalledWith(
      name,
      { type, userId: 0 },
      { repeat: { every }, removeOnComplete: true, jobId: name },
    );
    f.add.mockImplementation(async () => {
      throw new Error('queue unavailable');
    });
    await expect(setup(f.queue)).rejects.toThrow('queue unavailable');
  }
});

test('sync tick enqueues enabled calendars per active user and stops on failure', async () => {
  setSystemTime(now);
  const f = queueFixture();
  const getEnabledCalendars = mock((id: number) =>
    id === 1
      ? ['a', 'b'].map((google_calendar_id) => ({
          id: 1,
          user_id: id,
          google_calendar_id,
          calendar_name: google_calendar_id,
          color: null,
          is_primary: 0,
          sync_enabled: 1,
          access_role: 'owner' as const,
          sync_token: null,
          last_synced_at: null,
          created_at: '',
          updated_at: '',
        }))
      : [],
  );
  const calendars = { getEnabledCalendars };
  await executeSyncCronTick(f.queue, { getActiveUsers: () => [1, 2] }, calendars);
  expect(getEnabledCalendars.mock.calls).toEqual([[1], [2]]);
  expect(f.add).toHaveBeenCalledTimes(2);
  for (const id of ['a', 'b'])
    expect(f.add).toHaveBeenCalledWith(
      'pull-sync',
      { type: 'pull-sync', userId: 1, calendarId: id, trigger: 'cron' },
      { jobId: `pull-1-${id}-${now}` },
    );
  f.add.mockClear();
  await executeSyncCronTick(f.queue, { getActiveUsers: () => [] }, calendars);
  expect(f.add).not.toHaveBeenCalled();
  f.add.mockImplementation(async () => {
    throw new Error('enqueue failed');
  });
  await expect(executeSyncCronTick(f.queue, { getActiveUsers: () => [1] }, calendars)).rejects.toThrow(
    'enqueue failed',
  );
  expect(f.add).toHaveBeenCalledTimes(1);
});

function channels() {
  return [0, 1, 2].map((id) => ({
    id,
    channel_id: `old-${id}`,
    resource_id: `resource-${id}`,
    user_id: id + 10,
    google_calendar_id: `cal-${id}`,
    google_calendar_row_id: id + 20,
    channel_token: 'old-token',
    created_at: '',
    expiration: new Date(now + (id - 1) * 1000).toISOString(),
  }));
}

test('cleanup prunes 30-day logs and deletes only strictly expired channels', () => {
  setSystemTime(now);
  const pruneOldLogs = mock(() => 0);
  const getExpiringChannels = mock(() => channels());
  const deleteWatchChannel = mock((_id: number) => {});
  executeCleanup({ pruneOldLogs }, { getExpiringChannels, deleteWatchChannel });
  expect(pruneOldLogs).toHaveBeenCalledWith(30);
  expect(getExpiringChannels).toHaveBeenCalledWith(new Date(now).toISOString());
  expect(deleteWatchChannel.mock.calls).toEqual([[0]]);
});

test('watch renewal skips absent domain and isolates per-channel OAuth/watch failures', async () => {
  setSystemTime(now);
  const auth = new OAuth2Client();
  const getAuthClient = mock(async (id: number) => {
    if (id === 10) throw new Error('revoked');
    return auth;
  });
  const getExpiringChannels = mock(() => channels());
  const deleteWatchChannel = mock((_id: number) => {});
  const addWatchChannel = mock(
    (_row: number, _id: string, _resource: string, _expiration: string, _token: string) => {},
  );
  const stopChannel = mock(async (_id: string, _resource: string) => {});
  const watchEvents = mock(async (calendar: string, _id: string, _url: string, _expiration: number, token: string) => {
    if (calendar === 'cal-1') throw new Error('watch rejected');
    return { resourceId: 'new-resource', expiration: '2026-09-20T12:00:00.000Z', token };
  });
  const createApi = mock(() => ({ stopChannel, watchEvents }));
  const repo = { getExpiringChannels, deleteWatchChannel, addWatchChannel };
  await renewExpiringChannels({ PUBLIC_DOMAIN: '' } as EnvConfig, { getAuthClient }, repo, createApi);
  expect(getExpiringChannels).not.toHaveBeenCalled();
  await renewExpiringChannels({ PUBLIC_DOMAIN: 'offline.invalid' } as EnvConfig, { getAuthClient }, repo, createApi);
  expect(getExpiringChannels).toHaveBeenCalledWith('2026-09-14T12:00:00.000Z');
  expect(getAuthClient.mock.calls).toEqual([[10], [11], [12]]);
  expect(createApi).toHaveBeenCalledWith(auth);
  expect(stopChannel.mock.calls).toEqual([
    ['old-1', 'resource-1'],
    ['old-2', 'resource-2'],
  ]);
  expect(deleteWatchChannel.mock.calls).toEqual([[1], [2]]);
  const call = watchEvents.mock.calls[1]!;
  expect(call[0]).toBe('cal-2');
  expect(call[1]).toMatch(/^[0-9a-f-]{36}$/);
  expect(call[2]).toBe('https://offline.invalid/webhooks/google-calendar');
  expect(call[3]).toBe(now + 7 * 86400000);
  expect(call[4]).not.toBe(call[1]);
  expect(addWatchChannel.mock.calls).toEqual([[22, call[1], 'new-resource', '2026-09-20T12:00:00.000Z', call[4]]]);
});
