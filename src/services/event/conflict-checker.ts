import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';

const DEFAULT_POINT_DURATION_MIN = 30;

export class ConflictChecker {
  constructor(private eventRepo: EventRepository) {}

  checkConflicts(event: CalendarEvent, userId: number): CalendarEvent[] {
    if (event.all_day) return [];

    const startMs = new Date(event.start_at).getTime();
    const endMs = event.end_at ? new Date(event.end_at).getTime() : startMs + DEFAULT_POINT_DURATION_MIN * 60_000;

    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();

    const visible = this.eventRepo.findVisibleOverlapping(userId, startIso, endIso);

    return visible.filter((e) => {
      if (e.id === event.id) return false;
      if (e.all_day) return false;

      const eStart = new Date(e.start_at).getTime();
      const eEnd = e.end_at ? new Date(e.end_at).getTime() : eStart + DEFAULT_POINT_DURATION_MIN * 60_000;

      // Overlap: A starts before B ends AND A ends after B starts
      // Adjacent (eEnd === startMs or endMs === eStart) is NOT a conflict
      return eStart < endMs && eEnd > startMs;
    });
  }
}
