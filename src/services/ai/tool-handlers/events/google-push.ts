// Fan-out of one event change to several users' Google Calendars. Shared by update_event and
// delete_event, which differ only in the action, the log message and the logged user-id key.
import { logger } from '../../../../utils/logger.ts';
import type { AgentContext } from '../../types.ts';

export type ParticipantPush = NonNullable<NonNullable<AgentContext['google']>['scheduleParticipantPush']>;

/**
 * Concurrency note: SQLite ops inside scheduleParticipantPush are sync (bun:sqlite), so only the
 * Redis queue.add runs in parallel — bounded by realistic group sizes (<100 members). A failed push
 * is logged, never thrown: the event change itself already went through.
 */
export async function pushEventToUsers(
  push: ParticipantPush,
  userIds: number[],
  eventId: number,
  action: 'update' | 'delete',
  failureMessage: string,
  userIdKey: 'participantUserId' | 'userId',
): Promise<void> {
  const results = await Promise.allSettled(userIds.map((id) => push(id, eventId, action)));
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason, [userIdKey]: userIds[i], eventId }, failureMessage);
    }
  }
}
