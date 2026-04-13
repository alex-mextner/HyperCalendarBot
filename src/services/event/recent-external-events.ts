// src/services/event/recent-external-events.ts

import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';

export interface RecentExternalEvent {
  eventId: number;
  externalInviteeIds: number[];
}

const RECENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Find the most recent event created by the user (within last 10 minutes)
 * that has participants who haven't started the bot (no entry in `users` table).
 */
export function findMostRecentEventWithExternalParticipants(
  userId: number,
  actionLogRepo: ActionLogRepository,
  participantRepo: ParticipantRepository,
  userRepo: UserRepository,
): RecentExternalEvent | null {
  const cutoff = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();

  // Query action_log for recent 'create_event' entries by this user
  const recentActions = actionLogRepo.query({
    user_id: userId,
    action_name: 'create_event',
    after: cutoff,
    limit: 5,
  });

  // Results are ordered by created_at DESC — most recent first
  for (const action of recentActions) {
    if (!action.target_event_id) continue;

    const participants = participantRepo.getByEvent(action.target_event_id);
    // Filter out the event creator and find participants not in users table
    const externalIds: number[] = [];

    for (const p of participants) {
      if (p.user_id === userId) continue;
      const user = userRepo.findByTelegramId(p.user_id);
      if (!user) {
        externalIds.push(p.user_id);
      }
    }

    if (externalIds.length > 0) {
      return { eventId: action.target_event_id, externalInviteeIds: externalIds };
    }
  }

  return null;
}
