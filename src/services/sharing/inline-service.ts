import type { CalendarEvent, EventOccurrence, Visibility } from '../../database/types';

type IntentType = 'agenda_today' | 'agenda_tomorrow' | 'agenda_week' | 'search';

export interface QueryIntent {
  type: IntentType;
  query?: string;
}

export interface InlineResultItem {
  id: string;
  type: 'article' | 'photo';
  title: string;
  description: string;
  messageText: string;
  photoUrl?: string;
  thumbnailUrl?: string;
  caption?: string;
}

interface EventServiceDep {
  getEventsForDay(userId: number, date: Date, timezone: string): EventOccurrence[];
  getEventsForWeek(userId: number, date: Date, timezone: string): EventOccurrence[];
  searchEvents(userId: number, query: string): CalendarEvent[];
}

interface PrivacyServiceDep {
  resolveVisibility(userId: number, eventId: number): Visibility;
}

export class InlineService {
  constructor(
    private eventService: EventServiceDep,
    private privacyService: PrivacyServiceDep,
  ) {}

  parseQuery(query: string): QueryIntent {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed || trimmed === 'today') return { type: 'agenda_today' };
    if (trimmed === 'tomorrow') return { type: 'agenda_tomorrow' };
    if (trimmed === 'week') return { type: 'agenda_week' };
    return { type: 'search', query: query.trim() };
  }

  buildResults(userId: number, intent: QueryIntent, timezone: string): InlineResultItem[] {
    if (intent.type === 'search') {
      return this.buildSearchResults(userId, intent.query ?? '');
    }

    const occurrences = this.fetchOccurrences(userId, intent, timezone);
    return this.occurrencesToResults(userId, occurrences);
  }

  private fetchOccurrences(userId: number, intent: QueryIntent, timezone: string): EventOccurrence[] {
    const date = new Date();
    if (intent.type === 'agenda_tomorrow') {
      date.setDate(date.getDate() + 1);
    }

    if (intent.type === 'agenda_week') {
      return this.eventService.getEventsForWeek(userId, date, timezone);
    }

    return this.eventService.getEventsForDay(userId, date, timezone);
  }

  private occurrencesToResults(userId: number, occurrences: EventOccurrence[]): InlineResultItem[] {
    const results: InlineResultItem[] = [];
    for (const occ of occurrences) {
      const event = occ.event;
      const visibility = this.privacyService.resolveVisibility(userId, event.id);
      if (visibility === 'private') continue;

      const title = visibility === 'free_busy' ? 'Busy' : event.title;
      const timeStr = occ.occurrence_start ? new Date(occ.occurrence_start).toISOString().slice(11, 16) : '';

      results.push({
        id: `evt_${event.id}`,
        type: 'article',
        title: `${timeStr} ${title}`.trim(),
        description: visibility === 'free_busy' ? 'Busy' : event.title,
        messageText: `📅 ${title}${timeStr ? ` — ${timeStr}` : ''}`,
      });
    }
    return results;
  }

  async buildPhotoResult(userId: number, date: Date, timezone: string): Promise<InlineResultItem | null> {
    // Photo results require a publicly accessible URL for Telegram.
    // Implementation depends on image serving infrastructure
    // (Bun.serve static route, Telegram file upload, etc.)
    // Returns null until RenderService and serving are wired up.
    return null;
  }

  private buildSearchResults(userId: number, query: string): InlineResultItem[] {
    const events = this.eventService.searchEvents(userId, query);
    const results: InlineResultItem[] = [];
    for (const event of events) {
      const visibility = this.privacyService.resolveVisibility(userId, event.id);
      if (visibility === 'private') continue;

      const title = visibility === 'free_busy' ? 'Busy' : event.title;
      const timeStr = event.start_at ? new Date(event.start_at).toISOString().slice(11, 16) : '';

      results.push({
        id: `evt_${event.id}`,
        type: 'article',
        title: `${timeStr} ${title}`.trim(),
        description: visibility === 'free_busy' ? 'Busy' : event.title,
        messageText: `📅 ${title}${timeStr ? ` — ${timeStr}` : ''}`,
      });
    }
    return results;
  }
}
