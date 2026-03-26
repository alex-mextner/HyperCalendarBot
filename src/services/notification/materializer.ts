import { TZDate } from '@date-fns/tz';
import { z } from 'zod';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { logger } from '../../utils/logger.ts';
import { expandRecurrence } from '../event/recurrence.ts';

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

const NumberArrayCodec = jsonCodec(z.array(z.number()));
const DEFAULT_ALL_DAY_TIME = '09:00';

export function allDayReminderUtc(dateStr: string, localTime: string, timezone: string): Date {
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

    const overrides = event.reminder_overrides ? NumberArrayCodec.parse(event.reminder_overrides) : null;

    let intervals: number[];
    if (overrides) {
      intervals = overrides;
    } else {
      const prefs = this.prefsRepo.get(userId);
      intervals = prefs ? NumberArrayCodec.parse(prefs.default_reminder_intervals) : [30, 0];
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

  /**
   * Materialize reminders for a single occurrence of a recurring event.
   * Does NOT delete existing reminders — only inserts missing ones (dedup by event_id + remind_at_utc).
   */
  materializeForOccurrence(
    eventId: number,
    occurrenceStart: string,
    userId: number,
    reminderOverrides: string | null,
    allDay: number,
    userTimezone: string,
  ): number {
    let inserted = 0;
    const now = Date.now();

    if (allDay) {
      const prefs = this.prefsRepo.get(userId);
      const localTime = prefs?.morning_agenda_time ?? DEFAULT_ALL_DAY_TIME;
      const datePart = occurrenceStart.substring(0, 10);
      const [year, month, day] = datePart.split('-').map(Number);
      const dayBeforeParts = new Date(Date.UTC(year!, month! - 1, day! - 1));
      const dayBeforeStr = dayBeforeParts.toISOString().substring(0, 10);

      for (const [label, dateStr] of [
        ['day before', dayBeforeStr],
        ['day of', datePart],
      ] as [string, string][]) {
        const remindAt = allDayReminderUtc(`${dateStr}T00:00:00Z`, localTime, userTimezone);
        if (remindAt.getTime() < now) continue;
        const remindAtIso = remindAt.toISOString();
        if (this.reminderRepo.existsForEventAt(eventId, remindAtIso)) continue;
        this.reminderRepo.insert({
          event_id: eventId,
          user_id: userId,
          remind_at_utc: remindAtIso,
          interval_minutes: -1,
          interval_label: label,
        });
        inserted++;
      }
      return inserted;
    }

    const overrides = reminderOverrides ? NumberArrayCodec.parse(reminderOverrides) : null;
    let intervals: number[];
    if (overrides) {
      intervals = overrides;
    } else {
      const prefs = this.prefsRepo.get(userId);
      intervals = prefs ? NumberArrayCodec.parse(prefs.default_reminder_intervals) : [30, 0];
    }

    const eventStart = new Date(occurrenceStart);
    for (const minutes of intervals) {
      const remindAt = truncateToMinute(new Date(eventStart.getTime() - minutes * 60_000));
      if (remindAt.getTime() < now) continue;
      const remindAtIso = remindAt.toISOString();
      if (this.reminderRepo.existsForEventAt(eventId, remindAtIso)) continue;
      this.reminderRepo.insert({
        event_id: eventId,
        user_id: userId,
        remind_at_utc: remindAtIso,
        interval_minutes: minutes,
        interval_label: formatIntervalLabel(minutes),
      });
      inserted++;
    }
    return inserted;
  }

  /**
   * Rolling materializer: expand upcoming occurrences for all recurring events
   * and create missing reminders for the next `horizonDays`.
   */
  materializeUpcomingRecurringReminders(eventRepo: EventRepository, horizonDays = 7): number {
    const materializeLogger = logger.child({ module: 'recurring-materializer' });
    const now = new Date();
    const rangeStart = now.toISOString();
    const rangeEnd = new Date(now.getTime() + horizonDays * 24 * 60 * 60_000).toISOString();

    const templates = eventRepo.getAllRecurringTemplates();
    let totalInserted = 0;

    for (const template of templates) {
      const exceptions = eventRepo.getExceptions(template.id);
      const occurrences = expandRecurrence(template, exceptions, rangeStart, rangeEnd);

      for (const occ of occurrences) {
        // Skip cancelled occurrences (exception with is_cancelled)
        if (occ.is_exception && occ.event.is_cancelled) continue;

        const inserted = this.materializeForOccurrence(
          template.id,
          occ.occurrence_start,
          template.user_id,
          template.reminder_overrides,
          template.all_day,
          template.timezone,
        );
        totalInserted += inserted;
      }
    }

    materializeLogger.info(
      { templates: templates.length, inserted: totalInserted, horizonDays },
      'Recurring reminder materialization completed',
    );
    return totalInserted;
  }
}
