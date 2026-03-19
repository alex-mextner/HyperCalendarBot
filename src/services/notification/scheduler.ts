import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';
import type { CallLogRepository } from '../../database/repositories/call-log.repository.ts';
import type { CallSettingsRepository } from '../../database/repositories/call-settings.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { HolidayRepository } from '../../database/repositories/holiday.repository.ts';
import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import type { NotificationPreferencesRepository } from '../../database/repositories/notification-preferences.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import { getDayRangeUtc } from '../../utils/date.ts';
import { notifyLogger } from '../../utils/logger.ts';
import {
  renderBatchReminderForSpeech,
  renderEveningReviewForSpeech,
  renderMorningAgendaForSpeech,
  renderReminderForSpeech,
  renderWeeklyDigestForSpeech,
} from '../voice/tts-renderer.ts';
import type { AgendaEvent, WeeklyDigestDay } from './renderer.ts';
import { NotificationRenderer } from './renderer.ts';
import { isQuietHours } from './timezone.ts';

const renderer = new NotificationRenderer();

function toAgendaEvents(events: CalendarEvent[], timezone: string, lang: string): AgendaEvent[] {
  return events.map((e) => {
    const startTime = format(new TZDate(e.start_at, timezone), 'HH:mm');
    const endTime = e.end_at ? format(new TZDate(e.end_at, timezone), 'HH:mm') : startTime;
    const durationMs = e.end_at ? new Date(e.end_at).getTime() - new Date(e.start_at).getTime() : 0;
    const totalMin = Math.round(durationMs / 60000);
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    let duration: string;
    if (totalMin === 0) {
      duration = lang === 'ru' ? '?' : '?';
    } else if (hours === 0) {
      duration = lang === 'ru' ? `${mins}мин` : `${mins}m`;
    } else if (mins === 0) {
      duration = lang === 'ru' ? `${hours}ч` : `${hours}h`;
    } else {
      duration = lang === 'ru' ? `${hours}ч ${mins}мин` : `${hours}h ${mins}m`;
    }
    return { title: e.title, startTime, endTime, location: e.location, duration };
  });
}

function makeDateLabel(dateStr: string, timezone: string, lang: string): string {
  const d = new TZDate(`${dateStr}T12:00:00Z`, timezone);
  const locale = lang === 'ru' ? ru : enUS;
  return format(d, 'EEEE, MMMM d', { locale });
}

function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weeks start on Monday; adjust to nearest Thursday
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function isoWeekYear(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  return d.getUTCFullYear();
}

function makeWeekRangeLabel(monDate: Date, sunDate: Date, lang: string): string {
  const monDay = monDate.getUTCDate();
  const sunDay = sunDate.getUTCDate();
  const monMonth = monDate.getUTCMonth();
  const sunMonth = sunDate.getUTCMonth();
  const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const months = lang === 'ru' ? MONTHS_RU : MONTHS_EN;
  if (monMonth === sunMonth) {
    return `${monDay}–${sunDay} ${months[sunMonth]}`;
  }
  return `${monDay} ${months[monMonth]}–${sunDay} ${months[sunMonth]}`;
}

function makeDayLabel(date: Date, lang: string): string {
  const DAY_SHORT_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const DAY_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = lang === 'ru' ? DAY_SHORT_RU : DAY_SHORT_EN;
  const day = days[date.getUTCDay()]!;
  return `${day} ${date.getUTCDate()}`;
}

const DEFAULT_EVE_HOLIDAY_UTCHHMM = '21:00';

function truncateToMinute(d: Date): Date {
  const r = new Date(d);
  r.setSeconds(0, 0);
  return r;
}

function formatHHMM(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export interface EnqueueCallData {
  userId: number;
  eventId?: number;
  ttsText: string;
  language: string;
}

export interface SchedulerDeps {
  prefsRepo: NotificationPreferencesRepository;
  reminderRepo: EventReminderRepository;
  logRepo: NotificationLogRepository;
  userRepo: UserRepository;
  eventRepo: EventRepository;
  enqueue: (type: string, userId: number, logId: number, payload: string) => void;
  holidayRepo?: HolidayRepository;
  callSettingsRepo?: CallSettingsRepository;
  callLogRepo?: CallLogRepository;
  enqueueCall?: (data: EnqueueCallData) => void;
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
    const tomorrowDate = new Date(minute.getTime() + 86_400_000).toISOString().slice(0, 10);

    // Weekly cleanup: Sundays at 03:00 UTC
    if (minute.getUTCDay() === 0 && minute.getUTCHours() === 3) {
      const deleted = this.deps.logRepo.cleanup(30);
      notifyLogger.info({ deleted }, 'Notification log cleanup ran');
    }

    // 1. Event reminders
    const dueReminders = this.deps.reminderRepo.getDue(windowStart, windowEnd);

    // Group by (user_id, remind_at_utc) to detect batches
    const byKey = new Map<string, typeof dueReminders>();
    for (const reminder of dueReminders) {
      const key = `${reminder.user_id}:${reminder.remind_at_utc}`;
      const group = byKey.get(key);
      if (group) {
        group.push(reminder);
      } else {
        byKey.set(key, [reminder]);
      }
    }

    for (const group of byKey.values()) {
      const firstReminder = group[0]!;
      const user = this.deps.userRepo.findByTelegramId(firstReminder.user_id);
      if (!user) continue;
      const prefs = this.deps.prefsRepo.get(firstReminder.user_id);
      if (prefs) {
        const quiet = isQuietHours(
          { enabled: !!prefs.quiet_hours_enabled, start: prefs.quiet_hours_start, end: prefs.quiet_hours_end },
          nowUtc,
          user.timezone,
        );
        if (quiet) continue;
      }

      if (group.length > 1) {
        // Batch: one combined job for all reminders in this group
        const batchItems = group.map((r) => ({
          event_id: r.event_id,
          event_title: r.event_title,
          event_start_at: r.event_start_at,
          event_location: r.event_location,
          interval_label: r.interval_label,
        }));
        const refKey = `erb:${firstReminder.user_id}:${firstReminder.remind_at_utc}`;
        const payload = JSON.stringify({ items: batchItems });
        const logId = this.deps.logRepo.insert({
          user_id: firstReminder.user_id,
          type: 'event_reminder_batch',
          reference_key: refKey,
          channel: 'telegram_text',
          payload,
        });
        if (logId === null) continue;
        for (const r of group) {
          this.deps.reminderRepo.markSent(r.id);
        }
        this.deps.enqueue('event_reminder_batch', firstReminder.user_id, logId, payload);
        notifyLogger.info({ userId: firstReminder.user_id, count: group.length }, 'Batch event reminder enqueued');

        if (this.isCallAllowed(firstReminder.user_id, nowUtc)) {
          const ttsText = renderBatchReminderForSpeech({
            lang: user.language ?? 'ru',
            items: batchItems.map((item) => ({
              event_title: item.event_title,
              event_start_at: item.event_start_at,
              timezone: user.timezone,
            })),
          });
          this.deps.enqueueCall?.({ userId: firstReminder.user_id, ttsText, language: user.language ?? 'ru' });
          notifyLogger.info({ userId: firstReminder.user_id, count: group.length }, 'Batch voice call enqueued');
        }
        continue;
      }

      // Single reminder
      const reminder = firstReminder;
      const refKey = `er:${reminder.id}`;
      const payload = JSON.stringify({
        event_id: reminder.event_id,
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

      if (this.isCallAllowed(reminder.user_id, nowUtc)) {
        const ttsText = renderReminderForSpeech({
          title: reminder.event_title,
          startAt: reminder.event_start_at,
          timezone: user.timezone,
          location: reminder.event_location,
          language: user.language,
        });
        this.deps.enqueueCall?.({
          userId: reminder.user_id,
          eventId: reminder.event_id,
          ttsText,
          language: user.language,
        });
        notifyLogger.info({ userId: reminder.user_id, eventId: reminder.event_id }, 'Voice call enqueued');
      }
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
      const localTodayIso = new TZDate(nowUtc, user.timezone).toISOString().slice(0, 10);
      const { start: dayStart, end: dayEnd } = getDayRangeUtc(nowUtc, user.timezone);
      const events = this.deps.eventRepo.getByDateRange(pref.user_id, dayStart, dayEnd);
      if (events.length === 0) continue;
      const refKey = `ma:${pref.user_id}:${localTodayIso}`;
      const lang = user.language ?? 'ru';
      const dateLabel = makeDateLabel(localTodayIso, user.timezone, lang);
      const agendaEvents = toAgendaEvents(events, user.timezone, lang);
      // TODO: 'image' format requires sendPhoto (architectural change) — render as text for now
      const payload = renderer.renderMorningAgenda(lang, dateLabel, agendaEvents).text;
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

      if (this.isCallAllowed(pref.user_id, nowUtc)) {
        const ttsText = renderMorningAgendaForSpeech({ lang, dateLabel, events: agendaEvents });
        this.deps.enqueueCall?.({ userId: pref.user_id, ttsText, language: lang });
        notifyLogger.info({ userId: pref.user_id }, 'Morning agenda voice call enqueued');
      }
    }

    // 3. Eve-holiday notifications (per-user local tomorrow date)
    // Query 3 consecutive UTC dates to cover all timezone offsets (UTC-14 to UTC+14),
    // then verify each user's actual local tomorrow with getHolidayForUser.
    if (this.deps.holidayRepo) {
      const utcToday = minute.toISOString().slice(0, 10);
      const utcDayAfter = new Date(minute.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
      const candidates = new Map<number, true>();
      for (const date of [utcToday, tomorrowDate, utcDayAfter]) {
        for (const row of this.deps.holidayRepo.getUsersWithNotifyForDate(date)) {
          candidates.set(row.user_id, true);
        }
      }
      for (const [userId] of candidates) {
        const prefs = this.deps.prefsRepo.get(userId);
        const targetUtc = prefs?.evening_review_utc ?? DEFAULT_EVE_HOLIDAY_UTCHHMM;
        if (currentHHMM !== targetUtc) continue;
        const user = this.deps.userRepo.findByTelegramId(userId);
        if (!user) continue;
        const localTomorrowIso = new TZDate(new Date(minute.getTime() + 86_400_000), user.timezone)
          .toISOString()
          .slice(0, 10);
        const holiday = this.deps.holidayRepo.getHolidayForUser(userId, localTomorrowIso);
        if (!holiday) continue;
        const refKey = `eh:${userId}:${localTomorrowIso}`;
        const payload = JSON.stringify({ date: localTomorrowIso, holidayName: holiday.holiday_name });
        const logId = this.deps.logRepo.insert({
          user_id: userId,
          type: 'eve_holiday',
          reference_key: refKey,
          channel: 'telegram_text',
          payload,
        });
        if (logId === null) continue;
        this.deps.enqueue('eve_holiday', userId, logId, payload);
        notifyLogger.info({ userId, holiday: holiday.holiday_name }, 'Eve-holiday notification enqueued');
      }
    }

    // 4. Evening reviews
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
      const tomorrowUtc = new Date(nowUtc.getTime() + 86_400_000);
      const localTomorrowIso = new TZDate(tomorrowUtc, user.timezone).toISOString().slice(0, 10);
      const { start: tmStart, end: tmEnd } = getDayRangeUtc(new Date(`${localTomorrowIso}T12:00:00Z`), user.timezone);
      const events = this.deps.eventRepo.getByDateRange(pref.user_id, tmStart, tmEnd);
      if (events.length === 0) continue;
      const refKey = `ev:${pref.user_id}:${localTomorrowIso}`;
      const lang = user.language ?? 'ru';
      const dateLabel = makeDateLabel(localTomorrowIso, user.timezone, lang);
      const agendaEvents = toAgendaEvents(events, user.timezone, lang);
      // TODO: 'image' format requires sendPhoto (architectural change) — render as text for now
      const payload = renderer.renderEveningReview(lang, dateLabel, agendaEvents).text;
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

      if (this.isCallAllowed(pref.user_id, nowUtc)) {
        const ttsText = renderEveningReviewForSpeech({ lang, dateLabel, events: agendaEvents });
        this.deps.enqueueCall?.({ userId: pref.user_id, ttsText, language: lang });
        notifyLogger.info({ userId: pref.user_id }, 'Evening review voice call enqueued');
      }
    }

    // 5. Weekly digest (Sunday only, at user's evening_review_utc)
    if (minute.getUTCDay() === 0) {
      const weeklyPrefs = this.deps.prefsRepo.getAllByEveningUtc(currentHHMM);
      for (const pref of weeklyPrefs) {
        const user = this.deps.userRepo.findByTelegramId(pref.user_id);
        if (!user) continue;

        // Next Monday = tomorrow (Sunday + 1 day)
        const nextMonDate = new Date(minute.getTime() + 86_400_000);
        const nextMonLocalIso = new TZDate(nextMonDate, user.timezone).toISOString().slice(0, 10);
        const nextMonLocalDate = new Date(`${nextMonLocalIso}T12:00:00Z`);
        const weekYear = isoWeekYear(nextMonLocalDate);
        const weekNum = isoWeekNumber(nextMonLocalDate);
        const weekStr = `${weekYear}-W${String(weekNum).padStart(2, '0')}`;
        const refKey = `wd:${pref.user_id}:${weekStr}`;

        const lang = user.language ?? 'ru';

        // Build Mon–Sun local calendar dates for next week
        const days: WeeklyDigestDay[] = [];
        for (let i = 0; i < 7; i++) {
          const calDate = new Date(`${nextMonLocalIso}T12:00:00Z`);
          calDate.setUTCDate(calDate.getUTCDate() + i);
          const dateStr = calDate.toISOString().slice(0, 10);
          const { start: dayStart, end: dayEnd } = getDayRangeUtc(calDate, user.timezone);
          const dayEvents = this.deps.eventRepo.getByDateRange(pref.user_id, dayStart, dayEnd);
          const dayLabel = makeDayLabel(calDate, lang);
          days.push({
            date: dateStr,
            dayLabel,
            events: dayEvents.map((e) => ({
              title: e.title,
              startTime: format(new TZDate(e.start_at, user.timezone), 'HH:mm'),
            })),
          });
        }

        const sunCalDate = new Date(`${nextMonLocalIso}T12:00:00Z`);
        sunCalDate.setUTCDate(sunCalDate.getUTCDate() + 6);
        const weekRange = makeWeekRangeLabel(new Date(`${nextMonLocalIso}T12:00:00Z`), sunCalDate, lang);
        const payload = renderer.renderWeeklyDigest(lang, weekRange, days).text;

        const logId = this.deps.logRepo.insert({
          user_id: pref.user_id,
          type: 'weekly_digest',
          reference_key: refKey,
          channel: 'telegram_text',
          payload,
        });
        if (logId === null) continue;
        this.deps.enqueue('weekly_digest', pref.user_id, logId, payload);
        notifyLogger.info({ userId: pref.user_id, week: weekStr }, 'Weekly digest enqueued');

        if (this.isCallAllowed(pref.user_id, nowUtc)) {
          const digestDays = days.map((d) => ({
            dayLabel: d.dayLabel,
            events: d.events.map((e) => ({ title: e.title, startTime: e.startTime })),
          }));
          const ttsText = renderWeeklyDigestForSpeech({ lang, weekRange, days: digestDays });
          this.deps.enqueueCall?.({ userId: pref.user_id, ttsText, language: lang });
          notifyLogger.info({ userId: pref.user_id, week: weekStr }, 'Weekly digest voice call enqueued');
        }
      }
    }
  }

  private isCallAllowed(userId: number, nowUtc: Date): boolean {
    if (!this.deps.callSettingsRepo?.isEnabled(userId)) return false;

    const callSettings = this.deps.callSettingsRepo.get(userId);

    if (callSettings?.quiet_hours_start && callSettings?.quiet_hours_end) {
      const hours = nowUtc.getUTCHours();
      const mins = nowUtc.getUTCMinutes();
      const currentTime = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
      const start = callSettings.quiet_hours_start;
      const end = callSettings.quiet_hours_end;
      const inQuietHours =
        start <= end ? currentTime >= start && currentTime < end : currentTime >= start || currentTime < end;
      if (inQuietHours) {
        notifyLogger.info({ userId }, 'Voice call skipped (quiet hours)');
        return false;
      }
    }

    const dailyCount = this.deps.callLogRepo?.countTodayCalls(userId) ?? 0;
    const maxDaily = callSettings?.max_daily_calls ?? 5;
    return dailyCount < maxDaily;
  }
}
