import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GoogleSyncState } from '../../../src/database/types.ts';

// ─── BullMQ mock ───────────────────────────────────────────────────────────────

const mockQueueAdd = mock(async () => ({ id: 'j1' }));

mock.module('bullmq', () => ({
  Queue: class MockQueue {
    add = mockQueueAdd;
  },
  Worker: class MockWorker {
    on = mock(() => {});
  },
}));

const { createPushScheduler } = await import('../../../src/services/google/push-scheduler.ts');

// ─── Helpers ───────────────────────────────────────────────────────────────────

const mockGetSyncState = mock((): GoogleSyncState | null => null);
const mockUpdateSyncFields = mock(() => {});
const mockFindById = mock((): { google_event_id: string | null } | null => null);

function makeDeps() {
  const syncRepo = { getSyncState: mockGetSyncState } as never;
  const eventRepo = { updateSyncFields: mockUpdateSyncFields, findById: mockFindById } as never;
  const queue = { add: mockQueueAdd } as never;
  return { syncRepo, eventRepo, queue };
}

function makeActiveState(overrides: Partial<GoogleSyncState> = {}): GoogleSyncState {
  return {
    user_id: 1,
    access_token: 'tok',
    expires_at: null,
    scopes: 'calendar',
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('createPushScheduler', () => {
  beforeEach(() => {
    mockQueueAdd.mockClear();
    mockGetSyncState.mockClear();
    mockUpdateSyncFields.mockClear();
    mockFindById.mockClear();
  });

  test('does nothing when user has no sync state', async () => {
    mockGetSyncState.mockReturnValueOnce(null);
    const { syncRepo, eventRepo, queue } = makeDeps();
    const schedulePush = createPushScheduler(syncRepo, eventRepo, queue);
    await schedulePush(1, 10, 'create');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('does nothing when sync status is revoked', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState({ status: 'revoked' }));
    const { syncRepo, eventRepo, queue } = makeDeps();
    const schedulePush = createPushScheduler(syncRepo, eventRepo, queue);
    await schedulePush(1, 10, 'create');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('marks event pending_push and queues create job', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState());
    const { syncRepo, eventRepo, queue } = makeDeps();
    const schedulePush = createPushScheduler(syncRepo, eventRepo, queue);
    await schedulePush(1, 10, 'create');
    expect(mockUpdateSyncFields).toHaveBeenCalledWith(10, { sync_status: 'pending_push' });
    const [, jobData] = mockQueueAdd.mock.calls[0] as unknown as [
      string,
      { type: string; userId: number; eventId: number; action: string },
    ];
    expect(jobData.type).toBe('push-event');
    expect(jobData.userId).toBe(1);
    expect(jobData.eventId).toBe(10);
    expect(jobData.action).toBe('create');
  });

  test('update with existing google_event_id queues as update', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState());
    mockFindById.mockReturnValueOnce({ google_event_id: 'goog-123' });
    const { syncRepo, eventRepo, queue } = makeDeps();
    const schedulePush = createPushScheduler(syncRepo, eventRepo, queue);
    await schedulePush(1, 10, 'update');
    const [, jobData] = mockQueueAdd.mock.calls[0] as unknown as [string, { action: string }];
    expect(jobData.action).toBe('update');
  });

  test('update without google_event_id queues as create', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState());
    mockFindById.mockReturnValueOnce({ google_event_id: null });
    const { syncRepo, eventRepo, queue } = makeDeps();
    const schedulePush = createPushScheduler(syncRepo, eventRepo, queue);
    await schedulePush(1, 10, 'update');
    const [, jobData] = mockQueueAdd.mock.calls[0] as unknown as [string, { action: string }];
    expect(jobData.action).toBe('create');
  });

  test('update with no matching event does nothing', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState());
    mockFindById.mockReturnValueOnce(null);
    const { syncRepo, eventRepo, queue } = makeDeps();
    const schedulePush = createPushScheduler(syncRepo, eventRepo, queue);
    await schedulePush(1, 10, 'update');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('delete does not call updateSyncFields but queues job with googleEventId', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState());
    const { syncRepo, eventRepo, queue } = makeDeps();
    const schedulePush = createPushScheduler(syncRepo, eventRepo, queue);
    await schedulePush(1, 10, 'delete', { googleEventId: 'goog-456' });
    expect(mockUpdateSyncFields).not.toHaveBeenCalled();
    const [, jobData] = mockQueueAdd.mock.calls[0] as unknown as [string, { action: string; googleEventId: string }];
    expect(jobData.action).toBe('delete');
    expect(jobData.googleEventId).toBe('goog-456');
  });

  test('delete without googleEventId queues job without googleEventId field', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState());
    const { syncRepo, eventRepo, queue } = makeDeps();
    const schedulePush = createPushScheduler(syncRepo, eventRepo, queue);
    await schedulePush(1, 10, 'delete');
    const [, jobData] = mockQueueAdd.mock.calls[0] as unknown as [string, { action: string; googleEventId?: string }];
    expect(jobData.action).toBe('delete');
    expect(jobData.googleEventId).toBeUndefined();
  });
});
