// src/services/google/push-scheduler.ts

import type { Queue } from 'bullmq';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { ParticipantGoogleSyncRepository } from '../../database/repositories/participant-google-sync.repository.ts';
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

    await queue.add('push-participant-event', {
      type: 'push-participant-event',
      userId: participantUserId,
      eventId,
      action,
    });
  };
}
