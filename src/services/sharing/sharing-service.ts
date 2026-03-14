import type { EventRepository } from '../../database/repositories/event.repository';
import type { Visibility } from '../../database/types';
import { getDayRangeUtc } from '../../utils/date';
import type { PrivacyService } from './privacy-service';

export interface ShareableEvent {
  eventId: number;
  displayTitle: string;
  startAt: string;
  timezone: string;
  visibility: Visibility;
}

export class SharingService {
  constructor(
    private eventRepo: EventRepository,
    private privacyService: PrivacyService,
  ) {}

  getAgendaForSharing(userId: number, date: Date, timezone: string): ShareableEvent[] {
    const { start, end } = getDayRangeUtc(date, timezone);
    const events = this.eventRepo.getByDateRange(userId, start, end);

    const result: ShareableEvent[] = [];
    for (const event of events) {
      const visibility = this.privacyService.resolveVisibility(userId, event.id);
      if (visibility === 'private') continue;

      result.push({
        eventId: event.id,
        displayTitle: event.title,
        startAt: event.start_at,
        timezone: event.timezone,
        visibility,
      });
    }
    return result;
  }
}
