import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import { notifyLogger } from '../../utils/logger.ts';
import { isQuietHours } from './timezone.ts';

function truncateToMinute(d: Date): Date {
  const r = new Date(d);
  r.setSeconds(0, 0);
  return r;
}

function formatHHMM(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export interface SchedulerDeps {
  prefsRepo: NotificationPreferencesRepository;
  reminderRepo: EventReminderRepository;
  logRepo: NotificationLogRepository;
  userRepo: UserRepository;
  eventRepo: EventRepository;
  enqueue: (type: string, userId: number, logId: number, payload: string) => void;
}

export class NotificationScheduler {
  private deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  async tick(nowUtc: Date): Promise<void> {
    const minute = truncateToMinute(nowUtc);
    const currentHHMM = formatHHMM(minute);
    const windowStart = minute.toISOString();
    const windowEnd = new Date(minute.getTime() + 60_000).toISOString();
    const todayDate = minute.toISOString().slice(0, 10);
    const tomorrowDate = new Date(minute.getTime() + 86_400_000).toISOString().slice(0, 10);

    // 1. Event reminders
    const dueReminders = this.deps.reminderRepo.getDue(windowStart, windowEnd);
    for (const reminder of dueReminders) {
      const user = this.deps.userRepo.findByTelegramId(reminder.user_id);
      if (!user) continue;
      const prefs = this.deps.prefsRepo.get(reminder.user_id);
      if (prefs) {
        const quiet = isQuietHours(
          { enabled: !!prefs.quiet_hours_enabled, start: prefs.quiet_hours_start, end: prefs.quiet_hours_end },
          nowUtc,
          user.timezone,
        );
        if (quiet) continue;
      }
      const refKey = `er:${reminder.id}`;
      const payload = JSON.stringify({
        event_title: reminder.event_title,
        event_start_at: reminder.event_start_at,
        event_location: reminder.event_location,
        interval_label: reminder.interval_label,
      });
      const logId = this.deps.logRepo.insert({
        user_id: reminder.user_id,
        type: 'event_reminder',
        reference_key: refKey,
        channel: 'telegram_text',
        payload,
      });
      if (logId === null) continue;
      this.deps.reminderRepo.markSent(reminder.id);
      this.deps.enqueue('event_reminder', reminder.user_id, logId, payload);
      notifyLogger.info({ userId: reminder.user_id, eventId: reminder.event_id }, 'Event reminder enqueued');
    }

    // 2. Morning agendas
    const morningPrefs = this.deps.prefsRepo.getAllByMorningUtc(currentHHMM);
    for (const pref of morningPrefs) {
      const user = this.deps.userRepo.findByTelegramId(pref.user_id);
      if (!user) continue;
      const quiet = isQuietHours(
        { enabled: !!pref.quiet_hours_enabled, start: pref.quiet_hours_start, end: pref.quiet_hours_end },
        nowUtc,
        user.timezone,
      );
      if (quiet) continue;
      const dayStart = `${todayDate}T00:00:00Z`;
      const dayEnd = `${todayDate}T23:59:59Z`;
      const events = this.deps.eventRepo.getByDateRange(pref.user_id, dayStart, dayEnd);
      if (events.length === 0) continue;
      const refKey = `ma:${pref.user_id}:${todayDate}`;
      const payload = JSON.stringify({ date: todayDate, eventCount: events.length });
      const logId = this.deps.logRepo.insert({
        user_id: pref.user_id,
        type: 'morning_agenda',
        reference_key: refKey,
        channel: 'telegram_text',
        payload,
      });
      if (logId === null) continue;
      this.deps.enqueue('morning_agenda', pref.user_id, logId, payload);
      notifyLogger.info({ userId: pref.user_id }, 'Morning agenda enqueued');
    }

    // 3. Evening reviews
    const eveningPrefs = this.deps.prefsRepo.getAllByEveningUtc(currentHHMM);
    for (const pref of eveningPrefs) {
      const user = this.deps.userRepo.findByTelegramId(pref.user_id);
      if (!user) continue;
      const quiet = isQuietHours(
        { enabled: !!pref.quiet_hours_enabled, start: pref.quiet_hours_start, end: pref.quiet_hours_end },
        nowUtc,
        user.timezone,
      );
      if (quiet) continue;
      const tmStart = `${tomorrowDate}T00:00:00Z`;
      const tmEnd = `${tomorrowDate}T23:59:59Z`;
      const events = this.deps.eventRepo.getByDateRange(pref.user_id, tmStart, tmEnd);
      if (events.length === 0) continue;
      const refKey = `ev:${pref.user_id}:${tomorrowDate}`;
      const payload = JSON.stringify({ date: tomorrowDate, eventCount: events.length });
      const logId = this.deps.logRepo.insert({
        user_id: pref.user_id,
        type: 'evening_review',
        reference_key: refKey,
        channel: 'telegram_text',
        payload,
      });
      if (logId === null) continue;
      this.deps.enqueue('evening_review', pref.user_id, logId, payload);
      notifyLogger.info({ userId: pref.user_id }, 'Evening review enqueued');
    }
  }
}
