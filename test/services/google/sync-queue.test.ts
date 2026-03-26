import { describe, expect, mock, test } from 'bun:test';
import type { EnvConfig } from '../../../src/config/env.ts';
import { flushPromises } from '../../helpers/mock-context.ts';

// ─── BullMQ mock setup (must come before dynamic import) ──────────────────────

type JobProcessor = (job: {
  id: string;
  name: string;
  data: Record<string, unknown>;
  attemptsMade: number;
}) => Promise<void>;
type FailedHandler = (
  job:
    | {
        id?: string;
        name: string;
        data: Record<string, unknown>;
        attemptsMade: number;
      }
    | undefined,
  err: Error,
) => void;

let capturedQueueName = '';
let capturedQueueOpts: Record<string, unknown> = {};
let capturedWorkerName = '';
let capturedProcessor: JobProcessor = async () => {};
let capturedWorkerOpts: Record<string, unknown> = {};
let capturedFailedHandler: FailedHandler = () => {};

const mockQueueAdd = mock(async () => ({ id: 'q-job-1' }));
const mockWorkerOn = mock((_event: string, handler: FailedHandler) => {
  capturedFailedHandler = handler;
});

mock.module('bullmq', () => ({
  Queue: class MockQueue {
    name: string;
    constructor(name: string, opts: Record<string, unknown>) {
      capturedQueueName = name;
      capturedQueueOpts = opts;
      this.name = name;
    }
    add = mockQueueAdd;
  },
  Worker: class MockWorker {
    constructor(name: string, processor: JobProcessor, opts: Record<string, unknown>) {
      capturedWorkerName = name;
      capturedProcessor = processor;
      capturedWorkerOpts = opts;
    }
    on = mockWorkerOn;
  },
}));

// ─── SyncService mock ──────────────────────────────────────────────────────────

const mockInitialSync = mock(async () => {});
const mockIncrementalPull = mock(async () => {});
const mockPushEvent = mock(async () => {});
const mockSetupWatchChannel = mock(async () => {});

mock.module('../../../src/services/google/sync-service.ts', () => ({
  SyncService: class MockSyncService {
    initialSync = mockInitialSync;
    incrementalPull = mockIncrementalPull;
    pushEvent = mockPushEvent;
    setupWatchChannel = mockSetupWatchChannel;
  },
}));

// ─── GoogleCalendarApi mock ────────────────────────────────────────────────────

const mockListCalendars = mock(
  async (): Promise<
    {
      google_calendar_id: string;
      calendar_name: string;
      color: string | null;
      is_primary: boolean;
      access_role: string;
    }[]
  > => [],
);
const mockStopChannel = mock(async () => {});

mock.module('../../../src/services/google/calendar-api.ts', () => ({
  GoogleCalendarApi: class MockGoogleCalendarApi {
    listCalendars = mockListCalendars;
    stopChannel = mockStopChannel;
  },
}));

const { createGoogleSyncQueue } = await import('../../../src/services/google/sync-queue.ts');

// ─── Helpers ───────────────────────────────────────────────────────────────────

const fakeConfig = { PUBLIC_DOMAIN: 'https://example.com' } as EnvConfig;

const fakeOauthService = {
  getAuthClient: mock(async () => ({})),
};

const fakeEventRepo = {} as never;
const fakeSyncRepo = {
  markRevoked: mock(() => {}),
} as never;

type FakeCalendarRepo = {
  getEnabledCalendars: ReturnType<typeof mock>;
  getCalendars: ReturnType<typeof mock>;
  getCalendarByGoogleId: ReturnType<typeof mock>;
  getWatchChannels: ReturnType<typeof mock>;
  upsertCalendar: ReturnType<typeof mock>;
  deleteWatchChannel?: ReturnType<typeof mock>;
};

const fakeCalendarRepo: FakeCalendarRepo = {
  getEnabledCalendars: mock(() => []),
  getCalendars: mock(() => []),
  getCalendarByGoogleId: mock(() => null),
  getWatchChannels: mock(() => []),
  upsertCalendar: mock(() => {}),
};

const fakeSendMessage = mock(async () => {});

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    db: {} as never,
    config: fakeConfig,
    redisUrl: 'redis://localhost:6379',
    oauthService: fakeOauthService as never,
    eventRepo: fakeEventRepo,
    syncRepo: fakeSyncRepo,
    calendarRepo: fakeCalendarRepo as never,
    sendMessage: fakeSendMessage,
    ...overrides,
  };
}

// ─── createGoogleSyncQueue ────────────────────────────────────────────────────

describe('createGoogleSyncQueue', () => {
  test('returns queue, worker, and syncService', () => {
    const result = createGoogleSyncQueue(makeDeps());
    expect(result.queue).toBeDefined();
    expect(result.worker).toBeDefined();
    expect(result.syncService).toBeDefined();
  });

  test('queue is named google-sync', () => {
    createGoogleSyncQueue(makeDeps());
    expect(capturedQueueName).toBe('google-sync');
  });

  test('worker is named google-sync', () => {
    createGoogleSyncQueue(makeDeps());
    expect(capturedWorkerName).toBe('google-sync');
  });

  test('worker runs with concurrency 1', () => {
    createGoogleSyncQueue(makeDeps());
    expect((capturedWorkerOpts as { concurrency: number }).concurrency).toBe(1);
  });

  test('queue default job options have 5 attempts', () => {
    createGoogleSyncQueue(makeDeps());
    const opts = capturedQueueOpts as { defaultJobOptions: { attempts: number } };
    expect(opts.defaultJobOptions.attempts).toBe(5);
  });

  test('queue default job options use exponential backoff', () => {
    createGoogleSyncQueue(makeDeps());
    const opts = capturedQueueOpts as {
      defaultJobOptions: { backoff: { type: string; delay: number } };
    };
    expect(opts.defaultJobOptions.backoff.type).toBe('exponential');
    expect(opts.defaultJobOptions.backoff.delay).toBe(5000);
  });
});

// ─── Processor: cron ticks ────────────────────────────────────────────────────

describe('google-sync job processor — cron ticks', () => {
  test('calls onCronSyncTick for cron-sync-tick', async () => {
    const onCronSyncTick = mock(async () => {});
    createGoogleSyncQueue(makeDeps({ onCronSyncTick }));
    await capturedProcessor({
      id: 'j1',
      name: 'cron-tick',
      data: { type: 'cron-sync-tick', userId: 0 },
      attemptsMade: 0,
    });
    expect(onCronSyncTick).toHaveBeenCalledTimes(1);
  });

  test('calls onWatchRenewalTick for cron-watch-renewal-tick', async () => {
    const onWatchRenewalTick = mock(async () => {});
    createGoogleSyncQueue(makeDeps({ onWatchRenewalTick }));
    await capturedProcessor({
      id: 'j2',
      name: 'cron-tick',
      data: { type: 'cron-watch-renewal-tick', userId: 0 },
      attemptsMade: 0,
    });
    expect(onWatchRenewalTick).toHaveBeenCalledTimes(1);
  });

  test('calls onCleanupTick for cron-cleanup-tick', async () => {
    const onCleanupTick = mock(() => {});
    createGoogleSyncQueue(makeDeps({ onCleanupTick }));
    await capturedProcessor({
      id: 'j3',
      name: 'cron-tick',
      data: { type: 'cron-cleanup-tick', userId: 0 },
      attemptsMade: 0,
    });
    expect(onCleanupTick).toHaveBeenCalledTimes(1);
  });

  test('does not throw when cron tick handlers are absent', async () => {
    createGoogleSyncQueue(makeDeps());
    await expect(
      capturedProcessor({ id: 'j4', name: 'cron-tick', data: { type: 'cron-sync-tick', userId: 0 }, attemptsMade: 0 }),
    ).resolves.toBeUndefined();
    await expect(
      capturedProcessor({
        id: 'j5',
        name: 'cron-tick',
        data: { type: 'cron-watch-renewal-tick', userId: 0 },
        attemptsMade: 0,
      }),
    ).resolves.toBeUndefined();
    await expect(
      capturedProcessor({
        id: 'j6',
        name: 'cron-tick',
        data: { type: 'cron-cleanup-tick', userId: 0 },
        attemptsMade: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── Processor: auth errors ───────────────────────────────────────────────────

describe('google-sync job processor — auth errors', () => {
  test('swallows GoogleNotConnectedError and returns without throw', async () => {
    const err = Object.assign(new Error('not connected'), { name: 'GoogleNotConnectedError' });
    const oauthService = {
      getAuthClient: mock(async () => {
        throw err;
      }),
    };
    createGoogleSyncQueue(makeDeps({ oauthService }));
    await expect(
      capturedProcessor({
        id: 'j10',
        name: 'pull-sync',
        data: { type: 'pull-sync', userId: 42 },
        attemptsMade: 0,
      }),
    ).resolves.toBeUndefined();
  });

  test('swallows GoogleTokenRevokedError and returns without throw', async () => {
    const err = Object.assign(new Error('revoked'), { name: 'GoogleTokenRevokedError' });
    const oauthService = {
      getAuthClient: mock(async () => {
        throw err;
      }),
    };
    createGoogleSyncQueue(makeDeps({ oauthService }));
    await expect(
      capturedProcessor({
        id: 'j11',
        name: 'pull-sync',
        data: { type: 'pull-sync', userId: 42 },
        attemptsMade: 0,
      }),
    ).resolves.toBeUndefined();
  });

  test('rethrows unexpected auth errors', async () => {
    const err = new Error('network timeout');
    const oauthService = {
      getAuthClient: mock(async () => {
        throw err;
      }),
    };
    createGoogleSyncQueue(makeDeps({ oauthService }));
    await expect(
      capturedProcessor({
        id: 'j12',
        name: 'pull-sync',
        data: { type: 'pull-sync', userId: 42 },
        attemptsMade: 0,
      }),
    ).rejects.toThrow('network timeout');
  });
});

// ─── Processor: job types ────────────────────────────────────────────────────

describe('google-sync job processor — job types', () => {
  test('initial-sync throws when calendarId is missing', async () => {
    createGoogleSyncQueue(makeDeps());
    await expect(
      capturedProcessor({
        id: 'j20',
        name: 'initial-sync',
        data: { type: 'initial-sync', userId: 1 },
        attemptsMade: 0,
      }),
    ).rejects.toThrow('calendarId required');
  });

  test('initial-sync calls syncService.initialSync with calendarId', async () => {
    mockInitialSync.mockClear();
    createGoogleSyncQueue(makeDeps());
    await capturedProcessor({
      id: 'j21',
      name: 'initial-sync',
      data: { type: 'initial-sync', userId: 1, calendarId: 'cal-primary' },
      attemptsMade: 0,
    });
    expect(mockInitialSync).toHaveBeenCalledTimes(1);
    const [, userId, calendarId] = mockInitialSync.mock.calls[0] as unknown as [unknown, number, string];
    expect(userId).toBe(1);
    expect(calendarId).toBe('cal-primary');
  });

  test('initial-sync calls onSyncComplete after sync', async () => {
    mockInitialSync.mockClear();
    const onSyncComplete = mock(async () => {});
    createGoogleSyncQueue(makeDeps({ onSyncComplete }));
    await capturedProcessor({
      id: 'j22',
      name: 'initial-sync',
      data: { type: 'initial-sync', userId: 1, calendarId: 'cal-primary' },
      attemptsMade: 0,
    });
    expect(onSyncComplete).toHaveBeenCalledWith(1, 'cal-primary');
  });

  test('pull-sync calls incrementalPull for specific calendarId', async () => {
    mockIncrementalPull.mockClear();
    createGoogleSyncQueue(makeDeps());
    await capturedProcessor({
      id: 'j23',
      name: 'pull-sync',
      data: { type: 'pull-sync', userId: 2, calendarId: 'cal-work' },
      attemptsMade: 0,
    });
    expect(mockIncrementalPull).toHaveBeenCalledTimes(1);
    const [, userId, calId] = mockIncrementalPull.mock.calls[0] as unknown as [unknown, number, string];
    expect(userId).toBe(2);
    expect(calId).toBe('cal-work');
  });

  test('pull-sync iterates enabled calendars when calendarId is absent', async () => {
    mockIncrementalPull.mockClear();
    const calendarRepo: FakeCalendarRepo = {
      ...fakeCalendarRepo,
      getEnabledCalendars: mock(() => [{ google_calendar_id: 'cal-a' }, { google_calendar_id: 'cal-b' }]),
    };
    createGoogleSyncQueue(makeDeps({ calendarRepo }));
    await capturedProcessor({
      id: 'j24',
      name: 'pull-sync',
      data: { type: 'pull-sync', userId: 3 },
      attemptsMade: 0,
    });
    expect(mockIncrementalPull).toHaveBeenCalledTimes(2);
  });

  test('push-event throws when eventId or action is missing', async () => {
    createGoogleSyncQueue(makeDeps());
    await expect(
      capturedProcessor({
        id: 'j25',
        name: 'push-event',
        data: { type: 'push-event', userId: 1, eventId: 5 },
        attemptsMade: 0,
      }),
    ).rejects.toThrow('eventId and action required');
  });

  test('push-event calls syncService.pushEvent', async () => {
    mockPushEvent.mockClear();
    createGoogleSyncQueue(makeDeps());
    await capturedProcessor({
      id: 'j26',
      name: 'push-event',
      data: { type: 'push-event', userId: 1, eventId: 7, action: 'create' },
      attemptsMade: 0,
    });
    expect(mockPushEvent).toHaveBeenCalledTimes(1);
    const [, userId, eventId, action] = mockPushEvent.mock.calls[0] as unknown as [unknown, number, number, string];
    expect(userId).toBe(1);
    expect(eventId).toBe(7);
    expect(action).toBe('create');
  });

  test('refresh-calendars calls api.listCalendars and upserts each', async () => {
    mockListCalendars.mockImplementation(async () => [
      {
        google_calendar_id: 'cal-x',
        calendar_name: 'X',
        color: '#ff0000',
        is_primary: true,
        access_role: 'owner',
      },
    ]);
    const upsertCalendar = mock(() => {});
    const calendarRepo: FakeCalendarRepo = { ...fakeCalendarRepo, upsertCalendar };
    createGoogleSyncQueue(makeDeps({ calendarRepo }));
    await capturedProcessor({
      id: 'j27',
      name: 'refresh-calendars',
      data: { type: 'refresh-calendars', userId: 1 },
      attemptsMade: 0,
    });
    expect(upsertCalendar).toHaveBeenCalledTimes(1);
    const [userId, calData] = upsertCalendar.mock.calls[0] as unknown as [number, { google_calendar_id: string }];
    expect(userId).toBe(1);
    expect(calData.google_calendar_id).toBe('cal-x');
    mockListCalendars.mockImplementation(async () => []);
  });

  test('setup-watch returns early when calendarId is missing', async () => {
    mockSetupWatchChannel.mockClear();
    createGoogleSyncQueue(makeDeps());
    await capturedProcessor({
      id: 'j28',
      name: 'setup-watch',
      data: { type: 'setup-watch', userId: 1 },
      attemptsMade: 0,
    });
    expect(mockSetupWatchChannel).not.toHaveBeenCalled();
  });

  test('setup-watch returns early when calendar record not found', async () => {
    mockSetupWatchChannel.mockClear();
    const calendarRepo: FakeCalendarRepo = {
      ...fakeCalendarRepo,
      getCalendarByGoogleId: mock(() => null),
    };
    createGoogleSyncQueue(makeDeps({ calendarRepo }));
    await capturedProcessor({
      id: 'j29',
      name: 'setup-watch',
      data: { type: 'setup-watch', userId: 1, calendarId: 'cal-missing' },
      attemptsMade: 0,
    });
    expect(mockSetupWatchChannel).not.toHaveBeenCalled();
  });

  test('setup-watch calls syncService.setupWatchChannel when calendar exists', async () => {
    mockSetupWatchChannel.mockClear();
    const calendarRepo: FakeCalendarRepo = {
      ...fakeCalendarRepo,
      getCalendarByGoogleId: mock(() => ({ id: 99 })),
    };
    createGoogleSyncQueue(makeDeps({ calendarRepo }));
    await capturedProcessor({
      id: 'j29b',
      name: 'setup-watch',
      data: { type: 'setup-watch', userId: 1, calendarId: 'cal-primary' },
      attemptsMade: 0,
    });
    expect(mockSetupWatchChannel).toHaveBeenCalledTimes(1);
    const [, calId, googleCalId, domain] = mockSetupWatchChannel.mock.calls[0] as unknown as [
      unknown,
      number,
      string,
      string,
    ];
    expect(calId).toBe(99);
    expect(googleCalId).toBe('cal-primary');
    expect(domain).toBe('https://example.com');
  });

  test('stop-watch stops and deletes all channels for user calendars', async () => {
    mockStopChannel.mockClear();
    const deleteWatchChannel = mock(() => {});
    const calendarRepo: FakeCalendarRepo = {
      ...fakeCalendarRepo,
      getCalendars: mock(() => [{ id: 10 }]),
      getWatchChannels: mock(() => [
        { id: 1, channel_id: 'ch-1', resource_id: 'res-1' },
        { id: 2, channel_id: 'ch-2', resource_id: 'res-2' },
      ]),
      deleteWatchChannel,
    };
    createGoogleSyncQueue(makeDeps({ calendarRepo }));
    await capturedProcessor({
      id: 'j30',
      name: 'stop-watch',
      data: { type: 'stop-watch', userId: 1 },
      attemptsMade: 0,
    });
    expect(mockStopChannel).toHaveBeenCalledTimes(2);
    expect(deleteWatchChannel).toHaveBeenCalledTimes(2);
  });
});

// ─── Failed handler ───────────────────────────────────────────────────────────

describe('google-sync failed handler', () => {
  test('does not throw when job is present', () => {
    createGoogleSyncQueue(makeDeps());
    expect(() =>
      capturedFailedHandler(
        { id: 'j40', name: 'pull-sync', data: { type: 'pull-sync', userId: 1 }, attemptsMade: 1 },
        new Error('generic failure'),
      ),
    ).not.toThrow();
  });

  test('does not throw when job is undefined', () => {
    createGoogleSyncQueue(makeDeps());
    expect(() => capturedFailedHandler(undefined, new Error('no job'))).not.toThrow();
  });

  test('calls syncRepo.markRevoked on invalid_grant error', () => {
    const markRevoked = mock(() => {});
    const syncRepo = { markRevoked } as never;
    createGoogleSyncQueue(makeDeps({ syncRepo }));
    capturedFailedHandler(
      { id: 'j41', name: 'pull-sync', data: { type: 'pull-sync', userId: 55 }, attemptsMade: 2 },
      new Error('invalid_grant: Token has been expired'),
    );
    expect(markRevoked).toHaveBeenCalledWith(55);
  });

  test('calls syncRepo.markRevoked on token revoked error', () => {
    const markRevoked = mock(() => {});
    const syncRepo = { markRevoked } as never;
    createGoogleSyncQueue(makeDeps({ syncRepo }));
    capturedFailedHandler(
      { id: 'j42', name: 'pull-sync', data: { type: 'pull-sync', userId: 66 }, attemptsMade: 2 },
      new Error('Token has been expired or revoked'),
    );
    expect(markRevoked).toHaveBeenCalledWith(66);
  });

  test('calls sendMessage on invalid_grant error', async () => {
    const sendMessage = mock(async () => {});
    createGoogleSyncQueue(makeDeps({ sendMessage }));
    capturedFailedHandler(
      { id: 'j43', name: 'pull-sync', data: { type: 'pull-sync', userId: 77 }, attemptsMade: 2 },
      new Error('invalid_grant'),
    );
    // sendMessage is fire-and-forget via .catch(() => {}), so we flush microtasks
    await flushPromises();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [userId] = sendMessage.mock.calls[0] as unknown as [number, string];
    expect(userId).toBe(77);
  });

  test('re-queues job with delay on rate limit error (429 code)', async () => {
    mockQueueAdd.mockClear();
    createGoogleSyncQueue(makeDeps());
    const rateLimitErr = Object.assign(new Error('Rate Limit Exceeded'), { code: 429 });
    capturedFailedHandler(
      { id: 'j44', name: 'pull-sync', data: { type: 'pull-sync', userId: 1 }, attemptsMade: 1 },
      rateLimitErr,
    );
    await flushPromises();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, , opts] = mockQueueAdd.mock.calls[0] as unknown as [string, unknown, { delay: number }];
    expect(opts.delay).toBeGreaterThan(0);
  });

  test('re-queues job with delay on Rate Limit Exceeded message', async () => {
    mockQueueAdd.mockClear();
    createGoogleSyncQueue(makeDeps());
    capturedFailedHandler(
      { id: 'j45', name: 'pull-sync', data: { type: 'pull-sync', userId: 1 }, attemptsMade: 1 },
      new Error('Rate Limit Exceeded'),
    );
    await flushPromises();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  test('uses retry-after header when present on rate limit', async () => {
    mockQueueAdd.mockClear();
    createGoogleSyncQueue(makeDeps());
    const rateLimitErr = Object.assign(new Error('Rate Limit Exceeded'), {
      response: { headers: { 'retry-after': '30' } },
    });
    capturedFailedHandler(
      { id: 'j46', name: 'pull-sync', data: { type: 'pull-sync', userId: 1 }, attemptsMade: 1 },
      rateLimitErr,
    );
    await flushPromises();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, , opts] = mockQueueAdd.mock.calls[0] as unknown as [string, unknown, { delay: number }];
    expect(opts.delay).toBe(30_000);
  });

  test('uses 60s fallback delay when no retry-after header on rate limit', async () => {
    mockQueueAdd.mockClear();
    createGoogleSyncQueue(makeDeps());
    capturedFailedHandler(
      { id: 'j47', name: 'pull-sync', data: { type: 'pull-sync', userId: 1 }, attemptsMade: 1 },
      new Error('Rate Limit Exceeded'),
    );
    await flushPromises();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, , opts] = mockQueueAdd.mock.calls[0] as unknown as [string, unknown, { delay: number }];
    expect(opts.delay).toBe(60_000);
  });

  test('does not call markRevoked or re-queue on generic error', async () => {
    mockQueueAdd.mockClear();
    const markRevoked = mock(() => {});
    const syncRepo = { markRevoked } as never;
    createGoogleSyncQueue(makeDeps({ syncRepo }));
    capturedFailedHandler(
      { id: 'j48', name: 'pull-sync', data: { type: 'pull-sync', userId: 1 }, attemptsMade: 1 },
      new Error('some unrelated error'),
    );
    await flushPromises();
    expect(markRevoked).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
