import { TZDate } from '@date-fns/tz';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';

const INTERVAL_LABELS: Record<number, string> = {
  0: 'at start',
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
  all_day: number; // 0 | 1
  user_timezone: string;
}

const DEFAULT_ALL_DAY_TIME = '09:00';

function allDayReminderUtc(dateStr: string, localTime: string, timezone: string): Date {
  const [h, m] = localTime.split(':').map(Number);
  const local = new TZDate(new Date(dateStr), timezone);
  local.setHours(h!, m!, 0, 0);
  return new Date(local.getTime());
}

export class ReminderMaterializer {
  constructor(
    private reminderRepo: EventReminderRepository,
    private prefsRepo: NotificationPreferencesRepository,
  ) {}

  materialize(event: MaterializeEventData, userId: number): void {
    this.reminderRepo.deleteForEvent(event.id);

    if (event.all_day) {
      this.materializeAllDay(event, userId);
      return;
    }

    const overrides = event.reminder_overrides ? (JSON.parse(event.reminder_overrides) as number[]) : null;

    let intervals: number[];
    if (overrides) {
      intervals = overrides;
    } else {
      const prefs = this.prefsRepo.get(userId);
      intervals = prefs ? (JSON.parse(prefs.default_reminder_intervals) as number[]) : [30, 0];
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

  private materializeAllDay(event: MaterializeEventData, userId: number): void {
    const prefs = this.prefsRepo.get(userId);
    const localTime = prefs?.morning_agenda_time ?? DEFAULT_ALL_DAY_TIME;
    const timezone = event.user_timezone;
    const now = Date.now();

    // event.start_at is like '2099-07-10T00:00:00Z'; extract the date part only
    const datePart = event.start_at.substring(0, 10);
    const [year, month, day] = datePart.split('-').map(Number);
    const dayBeforeParts = new Date(Date.UTC(year!, month! - 1, day! - 1));
    const dayBeforeStr = dayBeforeParts.toISOString().substring(0, 10);

    for (const [label, dateStr] of [
      ['day before', dayBeforeStr],
      ['day of', datePart],
    ] as [string, string][]) {
      const remindAt = allDayReminderUtc(`${dateStr}T00:00:00Z`, localTime, timezone);
      if (remindAt.getTime() < now) continue;
      this.reminderRepo.insert({
        event_id: event.id,
        user_id: userId,
        remind_at_utc: remindAt.toISOString(),
        interval_minutes: -1,
        interval_label: label,
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
