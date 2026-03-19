import type { Database } from 'bun:sqlite';
import type { CalendarEvent } from '../database/types.ts';
import type { DomainEventBus } from '../services/scheduled/domain-event-bus.ts';
import { logger } from '../utils/logger.ts';

const checkerLogger = logger.child({ module: 'event-starting-checker' });

export class EventStartingChecker {
  constructor(
    private db: Database,
    private bus: DomainEventBus,
    private getUpcomingEvents: (withinMs: number) => CalendarEvent[],
  ) {}

  async check(): Promise<void> {
    const events = this.getUpcomingEvents(60_000);

    for (const event of events) {
      if (event.all_day) continue;

      const already = this.db.prepare('SELECT 1 FROM event_starting_log WHERE event_id = ?').get(event.id);
      if (already) continue;

      this.bus.emit('myCalendar.eventStarting', { userId: event.user_id, event });

      this.db
        .prepare('INSERT OR IGNORE INTO event_starting_log (event_id, notified_at) VALUES (?, ?)')
        .run(event.id, new Date().toISOString());

      checkerLogger.info({ eventId: event.id, userId: event.user_id }, 'Emitted eventStarting');
    }
  }
}
