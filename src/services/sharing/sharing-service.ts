import type { EventOccurrence, Visibility } from '../../database/types';
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
    private getEventsInRange: (userId: number, startUtc: string, endUtc: string) => EventOccurrence[],
    private privacyService: PrivacyService,
  ) {}

  getAgendaForSharing(userId: number, date: Date, timezone: string): ShareableEvent[] {
    const { start, end } = getDayRangeUtc(date, timezone);
    const occurrences = this.getEventsInRange(userId, start, end);

    const result: ShareableEvent[] = [];
    for (const occ of occurrences) {
      const visibility = this.privacyService.resolveVisibility(userId, occ.event.id);
      if (visibility === 'private') continue;

      result.push({
        eventId: occ.event.id,
        displayTitle: occ.event.title,
        startAt: occ.occurrence_start,
        timezone: occ.event.timezone,
        visibility,
      });
    }
    return result;
  }
}
