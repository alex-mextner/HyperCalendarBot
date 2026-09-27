// src/services/google/push-scheduler.ts

import type { Queue } from 'bullmq';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { ParticipantGoogleSyncRepository } from '../../database/repositories/participant-google-sync.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import { syncLogger } from '../../utils/logger.ts';
import type { GoogleSyncJobData } from './sync-queue.ts';

export function createPushScheduler(
  syncRepo: GoogleSyncRepository,
  eventRepo: EventRepository,
  queue: Queue<GoogleSyncJobData>,
) {
  return async function schedulePush(
    userId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
    opts?: { googleEventId?: string },
  ): Promise<void> {
    const syncState = syncRepo.getSyncState(userId);
    if (syncState?.status !== 'active') return;

    let effectiveAction = action;

    if (action === 'update') {
      const event = eventRepo.findById(eventId, userId);
      if (!event) return;
      // Event was never pushed to Google — treat as create so sync-service can insert it
      if (!event.google_event_id) effectiveAction = 'create';
    }

    if (action !== 'delete') {
      eventRepo.updateSyncFields(eventId, { sync_status: 'pending_push' });
    }

    const jobData: GoogleSyncJobData = {
      type: 'push-event',
      userId,
      eventId,
      action: effectiveAction,
    };
    if (action === 'delete' && opts?.googleEventId) {
      jobData.googleEventId = opts.googleEventId;
    }

    await queue.add('push-event', jobData);
  };
}

export function createParticipantPushScheduler(
  syncRepo: GoogleSyncRepository,
  participantSyncRepo: ParticipantGoogleSyncRepository,
  queue: Queue<GoogleSyncJobData>,
) {
  return async function scheduleParticipantPush(
    participantUserId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
  ): Promise<void> {
    const syncState = syncRepo.getSyncState(participantUserId);
    if (syncState?.status !== 'active') return;

    if (action === 'create') {
      participantSyncRepo.upsert(participantUserId, eventId, {
        sync_status: 'pending_push',
      });
    } else if (action === 'update') {
      const existing = participantSyncRepo.getByUserAndEvent(participantUserId, eventId);
      if (existing) {
        participantSyncRepo.updateSyncFields(participantUserId, eventId, {
          sync_status: 'pending_push',
        });
      } else {
        // Not yet synced — create instead
        participantSyncRepo.upsert(participantUserId, eventId, {
          sync_status: 'pending_push',
        });
      }
    }

    const job: GoogleSyncJobData = { type: 'push-participant-event', userId: participantUserId, eventId, action };
    if (action === 'delete') {
      // The event delete removes this row before the worker runs; carry the copy's identity.
      const copy = participantSyncRepo.getByUserAndEvent(participantUserId, eventId);
      if (copy?.google_event_id) {
        job.googleEventId = copy.google_event_id;
        job.calendarId = copy.google_calendar_id;
      }
    }
    await queue.add('push-participant-event', job);
  };
}

/** Queues an update push of an event's Google Calendar copy in one user's calendar. */
type ScheduleCopyUpdate = (userId: number, eventId: number, action: 'update') => Promise<void>;

/**
 * Re-push every Google Calendar copy of an event that changed outside an edit (a place confirmed
 * after the event was pushed): the owner's copy of a personal event (a group event lives only in
 * its members' calendars) and each participant copy already made for it. Each push goes through the
 * normal scheduler, which skips users without active sync.
 */
export function createEventCopiesPushScheduler(
  schedulePush: ScheduleCopyUpdate,
  scheduleParticipantPush: ScheduleCopyUpdate,
  participantSyncRepo: ParticipantGoogleSyncRepository,
) {
  return async function pushEventCopies(event: Pick<CalendarEvent, 'id' | 'user_id' | 'owner_type'>): Promise<void> {
    const participantIds = participantSyncRepo.getSyncedByEvent(event.id).map((copy) => copy.user_id);
    const results = await Promise.allSettled([
      ...(event.owner_type === 'group' ? [] : [schedulePush(event.user_id, event.id, 'update')]),
      ...participantIds.map((userId) => scheduleParticipantPush(userId, event.id, 'update')),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        syncLogger.error({ err: result.reason, eventId: event.id }, 'Failed to schedule a Google copy push');
      }
    }
  };
}
