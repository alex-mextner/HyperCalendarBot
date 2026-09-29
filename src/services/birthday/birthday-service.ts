import type { BirthdayMetadataRepository } from '../../database/repositories/birthday-metadata.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';
import type { BirthEventMetadata, CalendarEvent } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';
import { allDayReminderUtc } from '../notification/materializer.ts';

const birthdayLogger = logger.child({ module: 'birthday-service' });

const DEFAULT_ALL_DAY_TIME = '09:00';

export interface UpsertBirthdayParams {
  ownerId: number;
  celebrantId: number | null;
  celebrantName: string;
  day: number;
  month: number;
  year: number | null;
  lang: 'en' | 'ru';
  timezone: string;
  groupId?: number;
}

export interface BirthdayDisplayItem {
  event: CalendarEvent;
  celebrantId: number | null;
  birthYear: number | null;
  username: string | null;
}

export interface BirthdaysForDisplay {
  personal: BirthdayDisplayItem[];
  groups: { groupId: number; title: string; items: BirthdayDisplayItem[] }[];
}

export class BirthdayService {
  constructor(
    private eventRepo: EventRepository,
    private metaRepo: BirthdayMetadataRepository,
    private reminderRepo: EventReminderRepository,
    private prefsRepo: NotificationPreferencesRepository,
  ) {}

  findExistingBirthday(
    celebrantId: number,
    ownerId: number,
  ): (BirthEventMetadata & { start_at: string; title: string }) | null {
    return this.metaRepo.findByCelebrantAndOwner(celebrantId, ownerId);
  }

  upsertBirthdayEvent(params: UpsertBirthdayParams): void {
    const titlePrefix = params.lang === 'ru' ? '\u0414/\u0440 ' : 'Bday ';
    const title = titlePrefix + params.celebrantName;

    const now = new Date();
    let year = now.getUTCFullYear();
    const thisYearDate = new Date(Date.UTC(year, params.month - 1, params.day));
    if (thisYearDate < now) year += 1;

    const startDateStr = `${year}-${String(params.month).padStart(2, '0')}-${String(params.day).padStart(2, '0')}`;
    const startAt = `${startDateStr}T00:00:00Z`;

    const existing = params.celebrantId
      ? params.groupId
        ? this.metaRepo.findByCelebrantAndGroup(params.celebrantId, params.groupId)
        : this.metaRepo.findByCelebrantAndOwner(params.celebrantId, params.ownerId)
      : null;

    let eventId: number;
    let remindersNeedUpdate = !existing;

    if (existing) {
      if (existing.start_at !== startAt) {
        this.eventRepo.update(existing.event_id, params.ownerId, { start_at: startAt });
        birthdayLogger.info({ eventId: existing.event_id }, 'Birthday date updated');
        remindersNeedUpdate = true;
      }
      eventId = existing.event_id;
    } else {
      const event = this.eventRepo.create({
        user_id: params.ownerId,
        title,
        start_at: startAt,
        all_day: true,
        timezone: params.timezone,
        recurrence_rule: 'FREQ=YEARLY',
        event_type: 'birthday',
        owner_type: params.groupId ? 'group' : 'user',
        group_id: params.groupId ?? undefined,
      });
      eventId = event.id;
    }

    this.metaRepo.upsertMetadata({
      event_id: eventId,
      celebrant_id: params.celebrantId ?? null,
      birth_year: params.year ?? null,
      // Birthdays are only added by hand since the Telegram-profile auto-sync was removed.
      auto_created: 0,
    });

    if (remindersNeedUpdate) {
      this.reminderRepo.deleteForEvent(eventId);
      this.createBirthdayReminders(eventId, params.ownerId, startDateStr, params.timezone);
    }
  }

  private createBirthdayReminders(eventId: number, userId: number, startDateStr: string, timezone: string): void {
    const prefs = this.prefsRepo.get(userId);
    const localTime = prefs?.morning_agenda_time ?? DEFAULT_ALL_DAY_TIME;
    const now = Date.now();

    const [y, mo, d] = startDateStr.split('-').map(Number);

    // 7 days before
    const sevenBefore = new Date(Date.UTC(y!, mo! - 1, d! - 7)).toISOString().substring(0, 10);
    const sevenBeforeUtc = allDayReminderUtc(`${sevenBefore}T00:00:00Z`, localTime, timezone);
    if (sevenBeforeUtc.getTime() > now) {
      this.reminderRepo.insert({
        event_id: eventId,
        user_id: userId,
        remind_at_utc: sevenBeforeUtc.toISOString(),
        interval_minutes: 7 * 24 * 60,
        interval_label: '7 days before',
      });
    }

    // Day of
    const dayOfUtc = allDayReminderUtc(`${startDateStr}T00:00:00Z`, localTime, timezone);
    if (dayOfUtc.getTime() > now) {
      this.reminderRepo.insert({
        event_id: eventId,
        user_id: userId,
        remind_at_utc: dayOfUtc.toISOString(),
        interval_minutes: 0,
        interval_label: 'day of',
      });
    }
  }

  getBirthdaysForDisplay(userId: number, groupCalendars: { groupId: number; title: string }[]): BirthdaysForDisplay {
    const personalEvents = this.eventRepo.getBirthdays(userId);
    const personalCelebrantIds = new Set<number>();

    const personal: BirthdayDisplayItem[] = personalEvents.map((e) => {
      if (e.celebrant_id != null) personalCelebrantIds.add(e.celebrant_id);
      return { event: e, celebrantId: e.celebrant_id ?? null, birthYear: e.birth_year ?? null, username: null };
    });

    const groups = groupCalendars.flatMap(({ groupId, title }) => {
      const groupEvents = this.eventRepo.getBirthdaysForGroup(groupId);
      const items: BirthdayDisplayItem[] = groupEvents
        .map((e) => ({
          event: e,
          celebrantId: e.celebrant_id ?? null,
          birthYear: e.birth_year ?? null,
          username: null,
        }))
        .filter((item) => item.celebrantId == null || !personalCelebrantIds.has(item.celebrantId));
      if (items.length === 0) return [];
      return [{ groupId, title, items }];
    });

    personal.sort(sortByNext);
    for (const g of groups) g.items.sort(sortByNext);

    return { personal, groups };
  }
}

function sortByNext(a: BirthdayDisplayItem, b: BirthdayDisplayItem): number {
  return nextOccurrenceTs(a.event.start_at) - nextOccurrenceTs(b.event.start_at);
}

function nextOccurrenceTs(startAt: string): number {
  const d = new Date(startAt);
  const now = new Date();
  const year = now.getUTCFullYear();
  const thisYear = new Date(Date.UTC(year, d.getUTCMonth(), d.getUTCDate()));
  return thisYear >= now ? thisYear.getTime() : new Date(Date.UTC(year + 1, d.getUTCMonth(), d.getUTCDate())).getTime();
}
