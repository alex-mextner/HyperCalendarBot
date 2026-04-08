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

const { createParticipantPushScheduler } = await import('../../../src/services/google/push-scheduler.ts');

// ─── Helpers ───────────────────────────────────────────────────────────────────

const mockGetSyncState = mock((): GoogleSyncState | null => null);
const mockUpsert = mock(() => {});
const mockGetByUserAndEvent = mock((): { google_event_id: string | null } | null => null);
const mockUpdateSyncFields = mock(() => {});

function makeDeps() {
  const syncRepo = { getSyncState: mockGetSyncState } as never;
  const participantSyncRepo = {
    upsert: mockUpsert,
    getByUserAndEvent: mockGetByUserAndEvent,
    updateSyncFields: mockUpdateSyncFields,
  } as never;
  const queue = { add: mockQueueAdd } as never;
  return { syncRepo, participantSyncRepo, queue };
}

function makeActiveState(overrides: Partial<GoogleSyncState> = {}): GoogleSyncState {
  return {
    user_id: 2,
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

describe('createParticipantPushScheduler', () => {
  beforeEach(() => {
    mockQueueAdd.mockClear();
    mockGetSyncState.mockClear();
    mockUpsert.mockClear();
    mockGetByUserAndEvent.mockClear();
    mockUpdateSyncFields.mockClear();
  });

  test('does nothing when participant has no sync state', async () => {
    mockGetSyncState.mockReturnValueOnce(null);
    const { syncRepo, participantSyncRepo, queue } = makeDeps();
    const schedule = createParticipantPushScheduler(syncRepo, participantSyncRepo, queue);
    await schedule(2, 10, 'create');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('does nothing when sync status is revoked', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState({ status: 'revoked' }));
    const { syncRepo, participantSyncRepo, queue } = makeDeps();
    const schedule = createParticipantPushScheduler(syncRepo, participantSyncRepo, queue);
    await schedule(2, 10, 'create');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('create action upserts pending_push and queues job', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState());
    const { syncRepo, participantSyncRepo, queue } = makeDeps();
    const schedule = createParticipantPushScheduler(syncRepo, participantSyncRepo, queue);
    await schedule(2, 10, 'create');
    expect(mockUpsert).toHaveBeenCalledWith(2, 10, { sync_status: 'pending_push' });
    const [name, jobData] = mockQueueAdd.mock.calls[0] as unknown as [
      string,
      { type: string; userId: number; eventId: number; action: string },
    ];
    expect(name).toBe('push-participant-event');
    expect(jobData.type).toBe('push-participant-event');
    expect(jobData.userId).toBe(2);
    expect(jobData.eventId).toBe(10);
    expect(jobData.action).toBe('create');
  });

  test('update action with existing record updates sync fields', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState());
    mockGetByUserAndEvent.mockReturnValueOnce({ google_event_id: 'g-1' });
    const { syncRepo, participantSyncRepo, queue } = makeDeps();
    const schedule = createParticipantPushScheduler(syncRepo, participantSyncRepo, queue);
    await schedule(2, 10, 'update');
    expect(mockUpdateSyncFields).toHaveBeenCalledWith(2, 10, { sync_status: 'pending_push' });
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  test('update action without existing record upserts as create', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState());
    mockGetByUserAndEvent.mockReturnValueOnce(null);
    const { syncRepo, participantSyncRepo, queue } = makeDeps();
    const schedule = createParticipantPushScheduler(syncRepo, participantSyncRepo, queue);
    await schedule(2, 10, 'update');
    expect(mockUpsert).toHaveBeenCalledWith(2, 10, { sync_status: 'pending_push' });
  });

  test('delete action queues job without upsert', async () => {
    mockGetSyncState.mockReturnValueOnce(makeActiveState());
    const { syncRepo, participantSyncRepo, queue } = makeDeps();
    const schedule = createParticipantPushScheduler(syncRepo, participantSyncRepo, queue);
    await schedule(2, 10, 'delete');
    expect(mockUpsert).not.toHaveBeenCalled();
    const [, jobData] = mockQueueAdd.mock.calls[0] as unknown as [string, { action: string }];
    expect(jobData.action).toBe('delete');
  });
});
