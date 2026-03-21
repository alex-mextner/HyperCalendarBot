// src/services/invite/conflict-service.ts

import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';

export interface ConflictEvent {
  title: string | null;
  startAt: string;
  endAt: string;
}

export interface ConflictResult {
  userId: number;
  username: string | null;
  hasConflict: boolean;
  conflictingEvents: ConflictEvent[];
}

type EventRepoSubset = Pick<EventRepository, 'findVisibleOverlapping' | 'isParticipant'>;
type UserRepoSubset = Pick<UserRepository, 'findByTelegramId'>;

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export class ConflictService {
  constructor(
    private eventRepo: EventRepoSubset,
    private userRepo: UserRepoSubset,
  ) {}

  checkConflicts(
    organizerId: number,
    inviteeIds: number[],
    eventStart: string,
    eventEnd: string,
    _timezone: string,
  ): ConflictResult[] {
    const startMs = new Date(eventStart).getTime();
    const endMs = new Date(eventEnd).getTime();
    const windowStart = new Date(startMs - TWO_HOURS_MS).toISOString();
    const windowEnd = new Date(endMs + TWO_HOURS_MS).toISOString();

    return inviteeIds.map((inviteeId) => {
      const user = this.userRepo.findByTelegramId(inviteeId);
      const overlapping = this.eventRepo.findVisibleOverlapping(inviteeId, windowStart, windowEnd, organizerId);

      const conflictingEvents: ConflictEvent[] = overlapping.map((ev) => {
        const isShared = this.eventRepo.isParticipant(ev.id, organizerId);
        return {
          title: isShared ? ev.title : null,
          startAt: ev.start_at,
          endAt: ev.end_at ?? new Date(new Date(ev.start_at).getTime() + 30 * 60 * 1000).toISOString(),
        };
      });

      return {
        userId: inviteeId,
        username: user?.username ?? null,
        hasConflict: conflictingEvents.length > 0,
        conflictingEvents,
      };
    });
  }
}
