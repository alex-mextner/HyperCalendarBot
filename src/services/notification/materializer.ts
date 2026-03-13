import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';

const INTERVAL_LABELS: Record<number, string> = {
  5: '5 minutes',
  10: '10 minutes',
  15: '15 minutes',
  30: '30 minutes',
  60: '1 hour',
  120: '2 hours',
  1440: '1 day',
};

function formatIntervalLabel(minutes: number): string {
  return INTERVAL_LABELS[minutes] ?? `${minutes} min`;
}

function truncateToMinute(date: Date): Date {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d;
}

export interface MaterializeEventData {
  id: number;
  start_at: string;
  reminder_overrides: string | null;
}

export class ReminderMaterializer {
  constructor(
    private reminderRepo: EventReminderRepository,
    private prefsRepo: NotificationPreferencesRepository,
  ) {}

  materialize(event: MaterializeEventData, userId: number): void {
    this.reminderRepo.deleteForEvent(event.id);

    const overrides = event.reminder_overrides ? (JSON.parse(event.reminder_overrides) as number[]) : null;

    let intervals: number[];
    if (overrides) {
      intervals = overrides;
    } else {
      const prefs = this.prefsRepo.get(userId);
      intervals = prefs ? (JSON.parse(prefs.default_reminder_intervals) as number[]) : [15];
    }

    const eventStart = new Date(event.start_at);
    const now = Date.now();

    for (const minutes of intervals) {
      const remindAt = truncateToMinute(new Date(eventStart.getTime() - minutes * 60_000));
      if (remindAt.getTime() < now) continue;

      this.reminderRepo.insert({
        event_id: event.id,
        user_id: userId,
        remind_at_utc: remindAt.toISOString(),
        interval_minutes: minutes,
        interval_label: formatIntervalLabel(minutes),
      });
    }
  }

  deleteForEvent(eventId: number): void {
    this.reminderRepo.deleteForEvent(eventId);
  }

  rematerializeAllForUser(userId: number, getEvents: () => MaterializeEventData[]): void {
    this.reminderRepo.deleteUnsentForUser(userId);
    const events = getEvents();
    for (const event of events) {
      this.materialize(event, userId);
    }
  }
}
