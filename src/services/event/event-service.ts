// src/services/event/event-service.ts

import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GroupMemberRepository } from '../../database/repositories/group-member.repository.ts';
import type { ParticipantRepository } from '../../database/repositories/participant.repository.ts';
import type { CalendarEvent, CreateEventData, EventOccurrence, UpdateEventData } from '../../database/types.ts';
import { getDayRangeUtc, getNDayRangeUtc, getWeekRangeUtc } from '../../utils/date.ts';
import { logger } from '../../utils/logger.ts';
import { computeEventDiff, snapshotFromCalendarEvent } from '../google/change-detection.ts';
import type { ReminderMaterializer } from '../notification/materializer.ts';
import type { DomainEventBus } from '../scheduled/domain-event-bus.ts';
import type { ChangeNotifierOptions, EventChangeNotifier } from './event-change-notifier.ts';
import { expandRecurrence } from './recurrence.ts';

export interface FreeSlot {
  start: string;
  end: string;
  durationMinutes: number;
}

export interface EventServiceDeps {
  eventRepo: EventRepository;
  materializer?: ReminderMaterializer;
  participantRepo?: ParticipantRepository;
  groupMemberRepo?: GroupMemberRepository;
  changeNotifier?: EventChangeNotifier;
  domainEvents?: DomainEventBus;
}

export class EventService {
  private eventRepo: EventRepository;
  private materializer?: ReminderMaterializer;
  private participantRepo?: ParticipantRepository;
  private groupMemberRepo?: GroupMemberRepository;
  private changeNotifier?: EventChangeNotifier;
  private domainEvents?: DomainEventBus;

  constructor(deps: EventServiceDeps) {
    this.eventRepo = deps.eventRepo;
    this.materializer = deps.materializer;
    this.participantRepo = deps.participantRepo;
    this.groupMemberRepo = deps.groupMemberRepo;
    this.changeNotifier = deps.changeNotifier;
    this.domainEvents = deps.domainEvents;
  }

  createEvent(data: CreateEventData): CalendarEvent {
    const event = this.eventRepo.create(data);
    if (this.materializer) {
      // Prefer explicit reminder_minutes from CreateEventData over event.reminder_overrides
      // (reminder_minutes is not persisted to events.reminder_overrides in the DB)
      const overrides = data.reminder_minutes
        ? JSON.stringify(data.reminder_minutes)
        : (event.reminder_overrides ?? null);
      this.materializer.materialize(
        {
          id: event.id,
          start_at: event.start_at,
          reminder_overrides: overrides,
          all_day: event.all_day,
          user_timezone: event.timezone,
        },
        event.user_id,
      );
      // For recurring events, also materialize reminders for upcoming occurrences
      if (event.recurrence_rule) {
        this.materializeRecurringOccurrences(event, overrides);
      }
    }
    if (this.domainEvents) {
      if (event.owner_type === 'group' && event.group_id) {
        this.domainEvents.emit('myGroup.newEvent', {
          userId: event.created_by ?? event.user_id,
          groupChatId: event.group_id,
          newEvent: event,
          createdBy: event.created_by ?? event.user_id,
        });
      } else {
        this.domainEvents.emit('myCalendar.newEvent', { userId: event.user_id, newEvent: event });
      }
    }
    return event;
  }

  updateEvent(
    id: number,
    userId: number,
    data: UpdateEventData,
    notifierOptions?: ChangeNotifierOptions,
  ): CalendarEvent | null {
    const existing = this.domainEvents || this.changeNotifier ? this.eventRepo.findById(id, userId) : null;
    const updated = this.eventRepo.update(id, userId, data);
    if (this.materializer && updated) {
      this.materializer.materialize(
        {
          id: updated.id,
          start_at: updated.start_at,
          reminder_overrides: updated.reminder_overrides ?? null,
          all_day: updated.all_day,
          user_timezone: updated.timezone,
        },
        updated.user_id,
      );
      if (updated.recurrence_rule) {
        this.materializeRecurringOccurrences(updated, updated.reminder_overrides ?? null);
      }
    }
    if (this.domainEvents && updated && existing) {
      this.domainEvents.emit('myCalendar.updatedEvent', {
        userId: updated.user_id,
        updatedEvent: updated,
        oldEvent: existing,
      });
    }
    if (this.changeNotifier && updated && existing) {
      const changes = computeEventDiff(snapshotFromCalendarEvent(existing), snapshotFromCalendarEvent(updated));
      if (changes.length > 0) {
        this.changeNotifier
          .onEventChanged({
            event: updated,
            changes,
            source: 'bot',
            ...notifierOptions,
          })
          .catch((err) => {
            logger.error({ err, eventId: id }, 'EventChangeNotifier.onEventChanged failed');
          });
      }
    }
    return updated;
  }

  deleteEvent(id: number, userId: number): boolean {
    const event = this.eventRepo.findById(id, userId);
    if (this.changeNotifier && event) {
      this.changeNotifier.onEventDeleted({ event, source: 'bot' }).catch((err) => {
        logger.error({ err, eventId: id }, 'EventChangeNotifier.onEventDeleted failed');
      });
    }
    if (this.materializer) {
      this.materializer.deleteForEvent(id);
    }
    const deleted = this.eventRepo.remove(id, userId);
    if (this.domainEvents && deleted && event) {
      this.domainEvents.emit('myCalendar.deletedEvent', {
        userId: event.user_id,
        eventId: event.id,
        title: event.title,
      });
    }
    return deleted;
  }

  getEvent(id: number, userId: number): CalendarEvent | null {
    return this.eventRepo.findById(id, userId);
  }

  /**
   * Fetch an event by id, bypassing ONLY the soft-delete filter. Ownership
   * and group-visibility checks still apply — the caller must have had
   * access to the event before it was soft-deleted. Used by downstream
   * systems that need the title of a removed event (e.g. proposal accept/
   * reject notifications to the proposer).
   */
  getEventIncludingSoftDeleted(id: number, userId: number): CalendarEvent | null {
    return this.eventRepo.findByIdIncludingSoftDeleted(id, userId);
  }

  getLatestCreated(userId: number): CalendarEvent | null {
    return this.eventRepo.findLatestCreatedByUser(userId);
  }

  getEventOwnerId(eventId: number): number | null {
    return this.eventRepo.getOwnerId(eventId);
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
    const oneOff = this.eventRepo.getVisibleInRange(userId, startUtc, endUtc).map(
      (event) =>
        ({
          event,
          occurrence_start: event.start_at,
          occurrence_end: event.end_at,
          is_exception: false,
        }) satisfies EventOccurrence,
    );

    const templates = this.eventRepo.getVisibleRecurringTemplates(userId);
    const recurring: EventOccurrence[] = [];
    for (const template of templates) {
      const exceptions = this.eventRepo.getExceptions(template.id);
      let expanded = expandRecurrence(template, exceptions, startUtc, endUtc);

      // Clip group event occurrences to membership window
      if (template.owner_type === 'group' && template.group_id && this.groupMemberRepo) {
        const membership = this.groupMemberRepo.getMembership(template.group_id, userId);
        if (membership) {
          expanded = expanded.filter(
            (occ) =>
              occ.occurrence_start >= membership.joined_at &&
              (!membership.left_at || occ.occurrence_start < membership.left_at),
          );
        }
      }

      recurring.push(...expanded);
    }

    return [...oneOff, ...recurring].sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start));
  }

  private computeFreeSlots(occurrences: EventOccurrence[], dayStart: string, dayEnd: string): FreeSlot[] {
    const busy = occurrences
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

  getFreeSlots(userId: number, date: Date, timezone: string): FreeSlot[] {
    const { start: dayStart, end: dayEnd } = getDayRangeUtc(date, timezone);
    const events = this.getEventsInRange(userId, dayStart, dayEnd);
    return this.computeFreeSlots(events, dayStart, dayEnd);
  }

  getFreeSlotsForGroup(groupId: number, date: Date, timezone: string): FreeSlot[] {
    const { start: dayStart, end: dayEnd } = getDayRangeUtc(date, timezone);
    const events = this.getEventsInRangeForGroup(groupId, dayStart, dayEnd);
    return this.computeFreeSlots(events, dayStart, dayEnd);
  }

  searchEvents(userId: number, query: string): CalendarEvent[] {
    return this.eventRepo.search(userId, query);
  }

  getUpcoming(userId: number, limit = 10): CalendarEvent[] {
    return this.eventRepo.getVisibleUpcoming(userId, limit);
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

  getEventsInRangeForGroup(groupId: number, startUtc: string, endUtc: string): EventOccurrence[] {
    const oneOff = this.eventRepo.getInRangeForGroup(groupId, startUtc, endUtc).map(
      (event) =>
        ({
          event,
          occurrence_start: event.start_at,
          occurrence_end: event.end_at,
          is_exception: false,
        }) satisfies EventOccurrence,
    );

    const templates = this.eventRepo.getRecurringTemplatesForGroup(groupId);
    const recurring: EventOccurrence[] = [];
    for (const template of templates) {
      const exceptions = this.eventRepo.getExceptions(template.id);
      const expanded = expandRecurrence(template, exceptions, startUtc, endUtc);
      recurring.push(...expanded);
    }

    return [...oneOff, ...recurring].sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start));
  }

  getEventForGroup(eventId: number, groupId: number): CalendarEvent | null {
    return this.eventRepo.findByIdInGroup(eventId, groupId);
  }

  updateEventForGroup(eventId: number, groupId: number, data: UpdateEventData): CalendarEvent | null {
    const updated = this.eventRepo.updateInGroup(eventId, groupId, data);
    if (this.materializer && updated) {
      this.materializer.materialize(
        {
          id: updated.id,
          start_at: updated.start_at,
          reminder_overrides: updated.reminder_overrides ?? null,
          all_day: updated.all_day,
          user_timezone: updated.timezone,
        },
        updated.user_id,
      );
      if (updated.recurrence_rule) {
        this.materializeRecurringOccurrences(updated, updated.reminder_overrides ?? null);
      }
    }
    return updated;
  }

  deleteEventForGroup(eventId: number, groupId: number): boolean {
    const event = this.eventRepo.findByIdInGroup(eventId, groupId);
    if (event) {
      if (this.materializer) {
        this.materializer.deleteForEvent(eventId);
      }
    }
    return this.eventRepo.removeFromGroup(eventId, groupId);
  }

  searchEventsForGroup(groupId: number, query: string): CalendarEvent[] {
    return this.eventRepo.searchForGroup(groupId, query);
  }

  getUpcomingForGroup(groupId: number, limit = 10): EventOccurrence[] {
    const now = new Date().toISOString();
    const farFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const events = this.eventRepo.getUpcomingForGroup(groupId, limit);

    const oneOff: EventOccurrence[] = events
      .filter((e) => !e.recurrence_rule)
      .map((event) => ({
        event,
        occurrence_start: event.start_at,
        occurrence_end: event.end_at,
        is_exception: false,
      }));

    const recurring: EventOccurrence[] = [];
    const templates = events.filter((e) => e.recurrence_rule);
    for (const template of templates) {
      const exceptions = this.eventRepo.getExceptions(template.id);
      const expanded = expandRecurrence(template, exceptions, now, farFuture);
      recurring.push(...expanded.slice(0, limit));
    }

    return [...oneOff, ...recurring]
      .sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start))
      .slice(0, limit);
  }

  searchWithEventType(userId: number, query: string | null, eventType: string | null): CalendarEvent[] {
    return this.eventRepo.searchWithEventType(userId, query, eventType);
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

  private materializeRecurringOccurrences(event: CalendarEvent, reminderOverrides: string | null): void {
    if (!this.materializer || !event.recurrence_rule) return;

    const HORIZON_DAYS = 7;
    const now = new Date();
    const rangeStart = now.toISOString();
    const rangeEnd = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60_000).toISOString();

    const exceptions = this.eventRepo.getExceptions(event.id);
    const occurrences = expandRecurrence(event, exceptions, rangeStart, rangeEnd);

    for (const occ of occurrences) {
      if (occ.is_exception && occ.event.is_cancelled) continue;
      // Skip the base occurrence — already materialized by the caller
      if (occ.occurrence_start === event.start_at) continue;

      this.materializer.materializeForOccurrence(
        event.id,
        occ.occurrence_start,
        event.user_id,
        reminderOverrides,
        event.all_day,
        event.timezone,
        occ.occurrence_end,
      );
    }
  }
}
