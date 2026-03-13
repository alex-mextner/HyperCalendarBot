// src/services/event/event-service.ts

import { DEFAULTS } from '../../config/constants.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { ReminderRepository } from '../../database/repositories/reminder.repository.ts';
import type { CalendarEvent, CreateEventData, EventOccurrence, UpdateEventData } from '../../database/types.ts';
import { getDayRangeUtc, getNDayRangeUtc, getWeekRangeUtc } from '../../utils/date.ts';
import type { ReminderMaterializer } from '../notification/materializer.ts';
import { expandRecurrence } from './recurrence.ts';

export interface FreeSlot {
  start: string;
  end: string;
  durationMinutes: number;
}

export class EventService {
  constructor(
    private eventRepo: EventRepository,
    private reminderRepo: ReminderRepository,
    private materializer?: ReminderMaterializer,
    private pushSync?: (userId: number, eventId: number, action: 'create' | 'update' | 'delete') => void,
  ) {}

  createEvent(data: CreateEventData): CalendarEvent {
    const event = this.eventRepo.create(data);
    const reminderMinutes = data.reminder_minutes ?? [DEFAULTS.REMINDER_MINUTES];
    for (const mins of reminderMinutes) {
      this.reminderRepo.create(event.id, mins);
    }
    if (this.materializer) {
      this.materializer.materialize(
        { id: event.id, start_at: event.start_at, reminder_overrides: event.reminder_overrides ?? null },
        event.user_id,
      );
    }
    if (this.pushSync && event.google_calendar_id) {
      this.pushSync(event.user_id, event.id, 'create');
    }
    return event;
  }

  updateEvent(id: number, userId: number, data: UpdateEventData): CalendarEvent | null {
    const updated = this.eventRepo.update(id, userId, data);
    if (this.materializer && updated) {
      this.materializer.materialize(
        { id: updated.id, start_at: updated.start_at, reminder_overrides: updated.reminder_overrides ?? null },
        updated.user_id,
      );
    }
    if (this.pushSync && updated?.google_calendar_id) {
      this.pushSync(updated.user_id, updated.id, 'update');
    }
    return updated;
  }

  deleteEvent(id: number, userId: number): boolean {
    if (this.pushSync) {
      const event = this.eventRepo.findById(id, userId);
      if (event?.google_calendar_id) {
        this.pushSync(userId, id, 'delete');
      }
    }
    if (this.materializer) {
      this.materializer.deleteForEvent(id);
    }
    return this.eventRepo.remove(id, userId);
  }

  getEvent(id: number, userId: number): CalendarEvent | null {
    return this.eventRepo.findById(id, userId);
  }

  getEventsForDay(userId: number, date: Date, timezone: string): EventOccurrence[] {
    const { start, end } = getDayRangeUtc(date, timezone);
    return this.getEventsInRange(userId, start, end);
  }

  getEventsForWeek(userId: number, date: Date, timezone: string): EventOccurrence[] {
    const { start, end } = getWeekRangeUtc(date, timezone);
    return this.getEventsInRange(userId, start, end);
  }

  getEventsForNDays(userId: number, date: Date, days: number, timezone: string): EventOccurrence[] {
    const { start, end } = getNDayRangeUtc(date, days, timezone);
    return this.getEventsInRange(userId, start, end);
  }

  getEventsInRange(userId: number, startUtc: string, endUtc: string): EventOccurrence[] {
    const oneOff = this.eventRepo.getInRange(userId, startUtc, endUtc).map(
      (event) =>
        ({
          event,
          occurrence_start: event.start_at,
          occurrence_end: event.end_at,
          is_exception: false,
        }) satisfies EventOccurrence,
    );

    const templates = this.eventRepo.getRecurringTemplates(userId);
    const recurring: EventOccurrence[] = [];
    for (const template of templates) {
      const exceptions = this.eventRepo.getExceptions(template.id);
      const expanded = expandRecurrence(template, exceptions, startUtc, endUtc);
      recurring.push(...expanded);
    }

    return [...oneOff, ...recurring].sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start));
  }

  getFreeSlots(userId: number, date: Date, timezone: string): FreeSlot[] {
    const { start: dayStart, end: dayEnd } = getDayRangeUtc(date, timezone);
    const events = this.getEventsInRange(userId, dayStart, dayEnd);

    const busy = events
      .filter((o) => o.occurrence_end)
      .map((o) => ({
        start: new Date(o.occurrence_start).getTime(),
        end: new Date(o.occurrence_end!).getTime(),
      }))
      .sort((a, b) => a.start - b.start);

    const slots: FreeSlot[] = [];
    let cursor = new Date(dayStart).getTime();
    const dayEndMs = new Date(dayEnd).getTime();

    for (const interval of busy) {
      if (interval.start > cursor) {
        const durationMinutes = Math.round((interval.start - cursor) / 60000);
        if (durationMinutes > 0) {
          slots.push({
            start: new Date(cursor).toISOString(),
            end: new Date(interval.start).toISOString(),
            durationMinutes,
          });
        }
      }
      cursor = Math.max(cursor, interval.end);
    }

    if (cursor < dayEndMs) {
      const durationMinutes = Math.round((dayEndMs - cursor) / 60000);
      slots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(dayEndMs).toISOString(),
        durationMinutes,
      });
    }

    return slots;
  }

  searchEvents(userId: number, query: string): CalendarEvent[] {
    return this.eventRepo.search(userId, query);
  }

  getUpcoming(userId: number, limit = 10): CalendarEvent[] {
    return this.eventRepo.getUpcoming(userId, limit);
  }

  editOccurrence(templateId: number, occurrenceDate: string, userId: number): CalendarEvent | null {
    const template = this.eventRepo.findById(templateId, userId);
    if (!template || !template.recurrence_rule) return null;

    return this.eventRepo.createException(templateId, {
      user_id: userId,
      title: template.title,
      description: template.description ?? undefined,
      category: template.category ?? undefined,
      start_at: occurrenceDate,
      end_at: template.end_at
        ? new Date(
            new Date(occurrenceDate).getTime() +
              (new Date(template.end_at).getTime() - new Date(template.start_at).getTime()),
          ).toISOString()
        : undefined,
      timezone: template.timezone,
      location: template.location ?? undefined,
      original_start_at: occurrenceDate,
    });
  }

  splitRecurrence(templateId: number, occurrenceDate: string, userId: number): CalendarEvent | null {
    const template = this.eventRepo.findById(templateId, userId);
    if (!template || !template.recurrence_rule) return null;

    // Set UNTIL on original template to day before occurrenceDate
    const dayBefore = new Date(new Date(occurrenceDate).getTime() - 86400000).toISOString();
    this.eventRepo.setRecurrenceUntil(templateId, dayBefore);

    // Extract base FREQ/INTERVAL from original rule (without UNTIL/COUNT)
    const baseRule = template.recurrence_rule
      .split(';')
      .filter((p) => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='))
      .join(';');

    // Create new template starting at occurrenceDate
    const durationMs = template.end_at
      ? new Date(template.end_at).getTime() - new Date(template.start_at).getTime()
      : 0;

    const newTemplate = this.eventRepo.create({
      user_id: userId,
      title: template.title,
      description: template.description ?? undefined,
      category: template.category ?? undefined,
      start_at: occurrenceDate,
      end_at: durationMs ? new Date(new Date(occurrenceDate).getTime() + durationMs).toISOString() : undefined,
      timezone: template.timezone,
      location: template.location ?? undefined,
      recurrence_rule: baseRule,
    });

    // Re-parent exceptions
    this.eventRepo.reparentExceptions(templateId, newTemplate.id, occurrenceDate);

    return newTemplate;
  }

  deleteFuture(templateId: number, occurrenceDate: string, userId: number): void {
    const template = this.eventRepo.findById(templateId, userId);
    if (!template || !template.recurrence_rule) return;

    // Set UNTIL on template to day before occurrenceDate
    const dayBefore = new Date(new Date(occurrenceDate).getTime() - 86400000).toISOString();
    this.eventRepo.setRecurrenceUntil(templateId, dayBefore);

    // Delete all exceptions >= occurrenceDate
    this.eventRepo.deleteExceptionsFrom(templateId, occurrenceDate);
  }

  cancelOccurrence(templateId: number, userId: number, originalStartAt: string): CalendarEvent | null {
    const template = this.eventRepo.findById(templateId, userId);
    if (!template || !template.recurrence_rule) return null;

    return this.eventRepo.createException(templateId, {
      user_id: userId,
      title: template.title,
      start_at: originalStartAt,
      timezone: template.timezone,
      original_start_at: originalStartAt,
      is_cancelled: true,
    });
  }
}
