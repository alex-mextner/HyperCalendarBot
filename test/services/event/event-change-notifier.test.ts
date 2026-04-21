import { describe, expect, mock, test } from 'bun:test';
import type { CalendarEvent, EditProposal, EventParticipant } from '../../../src/database/types.ts';
import { EventChangeNotifier } from '../../../src/services/event/event-change-notifier.ts';
import type { FieldChange } from '../../../src/services/google/change-detection.ts';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    user_id: 100,
    title: 'Standup',
    description: null,
    category: null,
    start_at: '2026-04-21T10:00:00Z',
    end_at: '2026-04-21T11:00:00Z',
    all_day: 0,
    timezone: 'Europe/Moscow',
    location: null,
    recurrence_rule: null,
    recurrence_end_at: null,
    parent_event_id: null,
    original_start_at: null,
    is_cancelled: 0,
    is_deleted: 0,
    reminder_overrides: null,
    google_event_id: null,
    google_calendar_id: null,
    google_etag: null,
    sync_status: 'synced',
    sync_version: 1,
    owner_type: 'user',
    group_id: null,
    created_by: null,
    resolved_address: null,
    latitude: null,
    longitude: null,
    google_maps_url: null,
    location_verified: 0,
    venue_name: null,
    last_synced_at: null,
    created_at: '2026-04-21T00:00:00Z',
    updated_at: '2026-04-21T00:00:00Z',
    ...overrides,
  };
}

function makeParticipant(userId: number, status = 'accepted'): EventParticipant {
  return {
    id: userId,
    event_id: 1,
    user_id: userId,
    status: status as EventParticipant['status'],
    role: 'attendee',
    created_at: '',
    updated_at: '',
  };
}

function makeDeps(overrides: { participants?: EventParticipant[]; pendingProposals?: EditProposal[] } = {}) {
  const { participants = [], pendingProposals = [] } = overrides;
  const notifyUser = mock(async () => {});
  const editMessage = mock(async () => {});
  const syncQueueAdd = mock(async () => ({}));
  const updateStatus = mock(() => true);
  const deleteForEvent = mock(() => {});
  const materialize = mock(() => {});
  const deleteByEvent = mock(() => {});

  const deps = {
    participantRepo: {
      getByEvent: mock(() => participants),
    },
    editProposalRepo: {
      getPendingForEvent: mock(() => pendingProposals),
      updateStatus,
    },
    participantSyncRepo: {
      deleteByEvent,
    },
    materializer: {
      deleteForEvent,
      materialize,
    },
    syncQueue: {
      add: syncQueueAdd,
    },
    notifyUser,
    editMessage,
    getUserLang: mock(() => 'en' as const),
  };

  return { deps, notifyUser, editMessage, syncQueueAdd, updateStatus, deleteForEvent, materialize, deleteByEvent };
}

describe('EventChangeNotifier.onEventChanged', () => {
  const titleChange: FieldChange[] = [{ field: 'title', oldValue: 'Old', newValue: 'New' }];
  const timeChange: FieldChange[] = [{ field: 'start_at', oldValue: '10:00', newValue: '11:00' }];
  const timezoneOnly: FieldChange[] = [{ field: 'timezone', oldValue: 'UTC', newValue: 'US/Pacific' }];

  test('no participants → no side effects', async () => {
    const { deps, notifyUser, syncQueueAdd } = makeDeps();
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({ event: makeEvent(), changes: titleChange, source: 'bot' });
    expect(notifyUser).not.toHaveBeenCalled();
    expect(syncQueueAdd).not.toHaveBeenCalled();
  });

  test('3 active participants → 3 notifications + 3 participant pushes + 1 organizer push', async () => {
    const participants = [makeParticipant(200), makeParticipant(300), makeParticipant(400)];
    const { deps, notifyUser, syncQueueAdd } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({ event: makeEvent(), changes: titleChange, source: 'bot' });
    expect(notifyUser).toHaveBeenCalledTimes(3);
    expect(syncQueueAdd).toHaveBeenCalledTimes(4);
  });

  test('declined participant skipped', async () => {
    const participants = [makeParticipant(200, 'declined'), makeParticipant(300)];
    const { deps, notifyUser } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({ event: makeEvent(), changes: titleChange, source: 'bot' });
    expect(notifyUser).toHaveBeenCalledTimes(1);
  });

  test('excludeUserIds skips specified users', async () => {
    const participants = [makeParticipant(200), makeParticipant(300)];
    const { deps, notifyUser } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({
      event: makeEvent(),
      changes: titleChange,
      source: 'bot',
      excludeUserIds: [200],
    });
    expect(notifyUser).toHaveBeenCalledTimes(1);
    expect((notifyUser.mock.calls[0] as unknown[])[0]).toBe(300);
  });

  test('skipProposalExpiry prevents proposal expiry', async () => {
    const participants = [makeParticipant(200)];
    const pendingProposals = [{ id: 1, proposer_id: 200 }] as EditProposal[];
    const { deps, updateStatus } = makeDeps({ participants, pendingProposals });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({
      event: makeEvent(),
      changes: titleChange,
      source: 'bot',
      skipProposalExpiry: true,
    });
    expect(updateStatus).not.toHaveBeenCalled();
  });

  test('without skipProposalExpiry, proposals are expired', async () => {
    const participants = [makeParticipant(200)];
    const pendingProposals = [{ id: 1, proposer_id: 200 }] as EditProposal[];
    const { deps, updateStatus } = makeDeps({ participants, pendingProposals });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({ event: makeEvent(), changes: titleChange, source: 'bot' });
    expect(updateStatus).toHaveBeenCalledWith(1, 'expired');
  });

  test('group event → early return', async () => {
    const participants = [makeParticipant(200)];
    const { deps, notifyUser } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({ event: makeEvent({ owner_type: 'group' }), changes: titleChange, source: 'bot' });
    expect(notifyUser).not.toHaveBeenCalled();
  });

  test('timezone-only changes → early return (no shared changes)', async () => {
    const participants = [makeParticipant(200)];
    const { deps, notifyUser } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({ event: makeEvent(), changes: timezoneOnly, source: 'bot' });
    expect(notifyUser).not.toHaveBeenCalled();
  });

  test('source=bot → push to organizer GCal', async () => {
    const participants = [makeParticipant(200)];
    const { deps, syncQueueAdd } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({ event: makeEvent(), changes: titleChange, source: 'bot' });
    const calls = syncQueueAdd.mock.calls as unknown[][];
    const pushEventCall = calls.find((c) => (c[0] as string) === 'push-event');
    expect(pushEventCall).toBeDefined();
  });

  test('source=google_sync → NO push to organizer GCal', async () => {
    const participants = [makeParticipant(200)];
    const { deps, syncQueueAdd } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({ event: makeEvent(), changes: titleChange, source: 'google_sync' });
    const calls = syncQueueAdd.mock.calls as unknown[][];
    const pushEventCall = calls.find((c) => (c[0] as string) === 'push-event');
    expect(pushEventCall).toBeUndefined();
  });

  test('time change + source=google_sync → rematerialization', async () => {
    const participants = [makeParticipant(200)];
    const { deps, deleteForEvent, materialize } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({ event: makeEvent(), changes: timeChange, source: 'google_sync' });
    expect(deleteForEvent).toHaveBeenCalledWith(1);
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  test('time change + source=bot → NO rematerialization (EventService handles it)', async () => {
    const participants = [makeParticipant(200)];
    const { deps, deleteForEvent } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventChanged({ event: makeEvent(), changes: timeChange, source: 'bot' });
    expect(deleteForEvent).not.toHaveBeenCalled();
  });
});

describe('EventChangeNotifier.onEventDeleted', () => {
  test('notifies active participants + deletes from GCal + cleans sync', async () => {
    const participants = [makeParticipant(200), makeParticipant(300)];
    const { deps, notifyUser, syncQueueAdd, deleteByEvent } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventDeleted({ event: makeEvent(), source: 'google_sync' });
    expect(notifyUser).toHaveBeenCalledTimes(2);
    expect(deleteByEvent).toHaveBeenCalledWith(1);
    const calls = syncQueueAdd.mock.calls as unknown[][];
    const deleteJobs = calls.filter((c) => {
      const data = c[1] as { action?: string };
      return data.action === 'delete';
    });
    expect(deleteJobs).toHaveLength(2);
  });

  test('source=bot → push delete to organizer GCal', async () => {
    const participants = [makeParticipant(200)];
    const { deps, syncQueueAdd } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventDeleted({ event: makeEvent(), source: 'bot' });
    const calls = syncQueueAdd.mock.calls as unknown[][];
    const pushEventCall = calls.find((c) => (c[0] as string) === 'push-event');
    expect(pushEventCall).toBeDefined();
  });

  test('source=google_sync → NO push delete to organizer GCal', async () => {
    const participants = [makeParticipant(200)];
    const { deps, syncQueueAdd } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventDeleted({ event: makeEvent(), source: 'google_sync' });
    const calls = syncQueueAdd.mock.calls as unknown[][];
    const pushEventCall = calls.find((c) => (c[0] as string) === 'push-event');
    expect(pushEventCall).toBeUndefined();
  });

  test('group event → early return', async () => {
    const participants = [makeParticipant(200)];
    const { deps, notifyUser } = makeDeps({ participants });
    const notifier = new EventChangeNotifier(deps as never);
    await notifier.onEventDeleted({ event: makeEvent({ owner_type: 'group' }), source: 'bot' });
    expect(notifyUser).not.toHaveBeenCalled();
  });
});
