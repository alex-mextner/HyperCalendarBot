import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';
import { t, toLang } from '../../config/constants.ts';
import type { CallLogRepository } from '../../database/repositories/call-log.repository.ts';
import type { CallSettingsRepository } from '../../database/repositories/call-settings.repository.ts';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { FeatureUsageRepository } from '../../database/repositories/feature-usage.repository.ts';
import type { HolidayRepository } from '../../database/repositories/holiday.repository.ts';
import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import type {
  NotificationPreferencesRepository,
  UserContextFlags,
} from '../../database/repositories/notification-preferences.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { EventOccurrence, FeatureUsageRow, NotificationPreferencesRow } from '../../database/types.ts';
import { getDayRangeUtc } from '../../utils/date.ts';
import { notifyLogger } from '../../utils/logger.ts';
import {
  renderBatchReminderForSpeech,
  renderEveningReviewForSpeech,
  renderMorningAgendaForSpeech,
  renderReminderForSpeech,
  renderWeeklyDigestForSpeech,
} from '../voice/tts-renderer.ts';
import type { DayWeather } from '../weather/types.ts';
import type { WeatherService } from '../weather/weather-service.ts';
import { detectClockChange, formatClockChangeNotice } from './clock-change.ts';
import type { AgendaEvent, WeeklyDigestDay } from './renderer.ts';
import { NotificationRenderer } from './renderer.ts';
import { isLocalTimeInWindow, isQuietHours } from './timezone.ts';
import { BOT_TIP_FEATURE_MAP } from './tip-tags.ts';

const renderer = new NotificationRenderer();

function toAgendaEvents(occurrences: EventOccurrence[], timezone: string, lang: string): AgendaEvent[] {
  return occurrences.map((occ) => {
    const startAt = occ.occurrence_start;
    const endAt = occ.occurrence_end;
    const startTime = format(new TZDate(startAt, timezone), 'HH:mm');
    const endTime = endAt ? format(new TZDate(endAt, timezone), 'HH:mm') : startTime;
    const durationMs = endAt ? new Date(endAt).getTime() - new Date(startAt).getTime() : 0;
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
    const isAllDay = occ.event.all_day === 1;
    return { title: occ.event.title, startTime, endTime, location: occ.event.location, duration, isAllDay };
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

const DEFAULT_EVE_HOLIDAY_HHMM = '21:00';

/** User context for contextual tip selection */
export interface TipContext {
  hasMorningAgenda: boolean;
  hasEveningReview: boolean;
  hasQuietHours: boolean;
  hasGoogle: boolean;
  hasCountry: boolean;
  hasVoiceCalls: boolean;
  /** Feature usage data for filtering tips */
  featureUsage?: FeatureUsageRow[];
}

/** Build TipContext from a pref row with user context flags */
function buildTipContext(
  pref: NotificationPreferencesRow & UserContextFlags,
  featureUsage?: FeatureUsageRow[],
): TipContext {
  return {
    hasMorningAgenda: !!pref.morning_agenda_enabled,
    hasEveningReview: !!pref.evening_review_enabled,
    hasQuietHours: !!pref.quiet_hours_enabled,
    hasGoogle: !!pref.has_google,
    hasCountry: !!pref.has_country,
    hasVoiceCalls: !!pref.has_voice_calls,
    featureUsage,
  };
}

/** Days threshold: features used more recently than this are "fresh" — don't tip about them */
const RECENT_USAGE_DAYS = 7;
/** Days threshold: features used before this are "stale" — re-engagement tips welcome */
const STALE_USAGE_DAYS = 30;
/** Minimum use count to consider a feature "well known" (skip discovery tips) */
const WELL_KNOWN_COUNT = 5;

/**
 * Filter bot tips based on feature usage.
 * - Remove tips about features used recently (< 7 days) and frequently (>= 5 uses)
 * - Prioritize tips about features used a lot but stale (> 30 days) for re-engagement
 */
function filterTipsByUsage(
  tips: readonly string[],
  featureUsage: FeatureUsageRow[],
): { normal: number[]; reEngage: number[] } {
  const now = Date.now();
  const usageMap = new Map(featureUsage.map((u) => [u.feature_key, u]));

  const normal: number[] = [];
  const reEngage: number[] = [];

  for (let i = 0; i < tips.length && i < BOT_TIP_FEATURE_MAP.length; i++) {
    const featureKey = BOT_TIP_FEATURE_MAP[i]!;
    const usage = usageMap.get(featureKey);
    if (!usage) {
      // Never used — discovery tip
      normal.push(i);
      continue;
    }

    const lastUsedMs = new Date(usage.last_used_at).getTime();
    const daysSinceUse = (now - lastUsedMs) / 86_400_000;

    if (daysSinceUse < RECENT_USAGE_DAYS && usage.use_count >= WELL_KNOWN_COUNT) {
      // Used recently and frequently — skip this tip
      continue;
    }

    if (daysSinceUse > STALE_USAGE_DAYS && usage.use_count >= WELL_KNOWN_COUNT) {
      // Used a lot before but not recently — re-engagement candidate
      reEngage.push(i);
    } else {
      normal.push(i);
    }
  }

  return { normal, reEngage };
}

/** Pick a random bot tip, contextual tip, or book quote for free days (shown ~50% of the time) */
export function pickBotTip(lang: string, ctx?: TipContext): string | null {
  if (Math.random() > 0.5) return null;
  const l = t(toLang(lang));

  // 30% chance: try a contextual tip based on user's missing features
  if (ctx && Math.random() < 0.3) {
    const candidates: string[] = [];
    if (!ctx.hasEveningReview) candidates.push(l.contextualTips.noEveningReview);
    if (!ctx.hasMorningAgenda) candidates.push(l.contextualTips.noMorningAgenda);
    if (!ctx.hasQuietHours) candidates.push(l.contextualTips.noQuietHours);
    if (!ctx.hasGoogle) candidates.push(l.contextualTips.noGoogleCalendar);
    if (!ctx.hasCountry) candidates.push(l.contextualTips.noCountry);
    if (!ctx.hasVoiceCalls) candidates.push(l.contextualTips.noVoiceCalls);
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)]!;
    }
  }

  // 50% bot tips, 50% book quotes
  if (Math.random() < 0.5) {
    // Filter tips by feature usage if available
    if (ctx?.featureUsage && ctx.featureUsage.length > 0) {
      const { normal, reEngage } = filterTipsByUsage(l.botTips, ctx.featureUsage);
      // 40% chance to pick a re-engagement tip if available
      if (reEngage.length > 0 && Math.random() < 0.4) {
        const idx = reEngage[Math.floor(Math.random() * reEngage.length)]!;
        return l.botTips[idx]!;
      }
      if (normal.length > 0) {
        const idx = normal[Math.floor(Math.random() * normal.length)]!;
        return l.botTips[idx]!;
      }
    }
    return l.botTips[Math.floor(Math.random() * l.botTips.length)]!;
  }
  const allQuotes = [...l.gtdQuotes, ...l.atomicHabitsQuotes, ...l.deepWorkQuotes, ...l.sevenHabitsQuotes];
  return allQuotes[Math.floor(Math.random() * allQuotes.length)]!;
}

/** Fetch day weather with graceful failure */
async function fetchDayWeather(
  weatherService: WeatherService | undefined,
  timezone: string,
): Promise<DayWeather | null> {
  if (!weatherService) return null;
  try {
    return await weatherService.getDayWeather(timezone);
  } catch (err) {
    notifyLogger.warn({ err, timezone }, 'Weather fetch failed for agenda');
    return null;
  }
}

function truncateToMinute(d: Date): Date {
  const r = new Date(d);
  r.setSeconds(0, 0);
  return r;
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
  getEventsInRange: (userId: number, startUtc: string, endUtc: string) => EventOccurrence[];
  enqueue: (type: string, userId: number, logId: number, payload: string) => void;
  holidayRepo?: HolidayRepository;
  callSettingsRepo?: CallSettingsRepository;
  callLogRepo?: CallLogRepository;
  enqueueCall?: (data: EnqueueCallData) => void;
  weatherService?: WeatherService;
  featureUsageRepo?: FeatureUsageRepository;
}

export class NotificationScheduler {
  private deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  async tick(nowUtc: Date): Promise<void> {
    const minute = truncateToMinute(nowUtc);
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

    // Batch-fetch users and prefs for all reminder groups in one query each
    const reminderUserIds = [...new Set([...byKey.values()].map((g) => g[0]!.user_id))];
    const reminderUsersMap = this.deps.userRepo.findManyByTelegramIds(reminderUserIds);
    const reminderPrefsMap = this.deps.prefsRepo.getMany(reminderUserIds);

    for (const group of byKey.values()) {
      const firstReminder = group[0]!;
      const user = reminderUsersMap.get(firstReminder.user_id);
      if (!user) continue;
      const prefs = reminderPrefsMap.get(firstReminder.user_id);
      if (prefs) {
        const quiet = isQuietHours(
          { enabled: !!prefs.quiet_hours_enabled, start: prefs.quiet_hours_start, end: prefs.quiet_hours_end },
          nowUtc,
          user.timezone,
        );
        if (quiet) continue;
      }

      if (group.length > 1) {
        const lang = user.language ?? 'en';
        // Batch: one combined job for all reminders in this group
        const batchItems = group.map((r) => ({
          event_id: r.event_id,
          event_title: r.event_title,
          event_start_at: r.event_start_at,
          event_location: r.event_location,
          interval_label: r.interval_label,
          is_all_day: r.interval_minutes === -1,
        }));
        const refKey = `erb:${firstReminder.user_id}:${firstReminder.remind_at_utc}`;
        const renderItems = batchItems.map((item) => ({
          title: item.event_title,
          startTime: format(new TZDate(item.event_start_at, user.timezone), 'HH:mm'),
          location: item.event_location,
          intervalLabel: item.interval_label,
          isAllDay: item.is_all_day,
        }));
        const rendered = renderer.renderBatchReminder(lang, renderItems);
        const eventIds = batchItems.map((item) => item.event_id);
        const payload = JSON.stringify({ text: rendered.text, event_ids: eventIds });
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
            lang: user.language ?? 'en',
            items: batchItems.map((item) => ({
              event_title: item.event_title,
              event_start_at: item.event_start_at,
              timezone: user.timezone,
            })),
          });
          this.deps.enqueueCall?.({ userId: firstReminder.user_id, ttsText, language: user.language ?? 'en' });
          notifyLogger.info({ userId: firstReminder.user_id, count: group.length }, 'Batch voice call enqueued');
        }
        continue;
      }

      // Single reminder
      const reminder = firstReminder;
      const refKey = `er:${reminder.id}`;
      const lang = user.language ?? 'en';
      const startTime = format(new TZDate(reminder.event_start_at, user.timezone), 'HH:mm');
      const endTime = reminder.event_end_at
        ? format(new TZDate(reminder.event_end_at, user.timezone), 'HH:mm')
        : undefined;
      const isAllDay = reminder.interval_minutes === -1;
      const rendered = renderer.renderEventReminder(lang, {
        title: reminder.event_title,
        startTime,
        endTime,
        location: reminder.event_location,
        intervalLabel: reminder.interval_label,
        isAllDay,
      });
      const payload = JSON.stringify({ text: rendered.text, event_id: reminder.event_id });
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
    const morningPrefs = this.deps.prefsRepo.getAllMorningEnabled();
    for (const pref of morningPrefs) {
      if (!isLocalTimeInWindow(nowUtc, pref.timezone, pref.morning_agenda_time, 5)) continue;
      const quiet = isQuietHours(
        { enabled: !!pref.quiet_hours_enabled, start: pref.quiet_hours_start, end: pref.quiet_hours_end },
        nowUtc,
        pref.timezone,
      );
      if (quiet) continue;
      const localTodayIso = new TZDate(nowUtc, pref.timezone).toISOString().slice(0, 10);
      const { start: dayStart, end: dayEnd } = getDayRangeUtc(nowUtc, pref.timezone);
      const occurrences = this.deps.getEventsInRange(pref.user_id, dayStart, dayEnd);
      const clockChange = detectClockChange(pref.timezone, localTodayIso);
      const refKey = `ma:${pref.user_id}:${localTodayIso}`;
      const lang = toLang(pref.language);
      const dateLabel = makeDateLabel(localTodayIso, pref.timezone, lang);
      const agendaEvents = toAgendaEvents(occurrences, pref.timezone, lang);
      const weather = await fetchDayWeather(this.deps.weatherService, pref.timezone);
      const featureUsage = this.deps.featureUsageRepo?.getForUser(pref.user_id);
      const tipCtx = buildTipContext(pref, featureUsage);
      const botTip = agendaEvents.length === 0 ? pickBotTip(lang, tipCtx) : null;
      // TODO: 'image' format requires sendPhoto (architectural change) — render as text for now
      let payload = renderer.renderMorningAgenda(lang, dateLabel, agendaEvents, { weather, botTip }).text;
      if (clockChange) {
        payload += `\n\n${formatClockChangeNotice(lang, clockChange)}`;
      }
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

    // 2b. Standalone clock-change notifications for users without morning agenda
    // Sent at 08:00 local time on the day of the DST transition.
    // Cursor-based batching: reads 100 users at a time, never loads full table.
    const morningUserIds = new Set(morningPrefs.map((p) => p.user_id));
    for (const batch of this.deps.userRepo.iterateTimezoneInfo(morningUserIds)) {
      for (const user of batch) {
        if (!isLocalTimeInWindow(nowUtc, user.timezone, '08:00', 5)) continue;
        const localTodayIso = new TZDate(nowUtc, user.timezone).toISOString().slice(0, 10);
        const clockChange = detectClockChange(user.timezone, localTodayIso);
        if (!clockChange) continue;
        const lang = toLang(user.language);
        const refKey = `cc:${user.telegram_id}:${localTodayIso}`;
        const payload = formatClockChangeNotice(lang, clockChange);
        const logId = this.deps.logRepo.insert({
          user_id: user.telegram_id,
          type: 'clock_change',
          reference_key: refKey,
          channel: 'telegram_text',
          payload,
        });
        if (logId === null) continue;
        this.deps.enqueue('clock_change', user.telegram_id, logId, payload);
        notifyLogger.info(
          { userId: user.telegram_id, direction: clockChange.direction, minutes: clockChange.minutes },
          'Clock change notification enqueued',
        );
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
      const candidateIds = [...candidates.keys()];
      const holidayUsersMap = this.deps.userRepo.findManyByTelegramIds(candidateIds);
      const holidayPrefsMap = this.deps.prefsRepo.getMany(candidateIds);

      for (const [userId] of candidates) {
        const user = holidayUsersMap.get(userId);
        if (!user) continue;
        const prefs = holidayPrefsMap.get(userId);
        const targetTime = prefs?.evening_review_time ?? DEFAULT_EVE_HOLIDAY_HHMM;
        if (!isLocalTimeInWindow(nowUtc, user.timezone, targetTime, 5)) continue;
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
    const eveningPrefs = this.deps.prefsRepo.getAllEveningEnabled();
    for (const pref of eveningPrefs) {
      if (!isLocalTimeInWindow(nowUtc, pref.timezone, pref.evening_review_time, 5)) continue;
      const quiet = isQuietHours(
        { enabled: !!pref.quiet_hours_enabled, start: pref.quiet_hours_start, end: pref.quiet_hours_end },
        nowUtc,
        pref.timezone,
      );
      if (quiet) continue;
      const tomorrowUtc = new Date(nowUtc.getTime() + 86_400_000);
      const localTomorrowIso = new TZDate(tomorrowUtc, pref.timezone).toISOString().slice(0, 10);
      const { start: tmStart, end: tmEnd } = getDayRangeUtc(new Date(`${localTomorrowIso}T12:00:00Z`), pref.timezone);
      const occurrences = this.deps.getEventsInRange(pref.user_id, tmStart, tmEnd);
      const refKey = `ev:${pref.user_id}:${localTomorrowIso}`;
      const lang = pref.language ?? 'en';
      const dateLabel = makeDateLabel(localTomorrowIso, pref.timezone, lang);
      const agendaEvents = toAgendaEvents(occurrences, pref.timezone, lang);
      // For evening review, fetch tomorrow's weather via week forecast (day index 1)
      let tomorrowWeather: DayWeather | null = null;
      if (this.deps.weatherService) {
        try {
          const weekW = await this.deps.weatherService.getWeekWeather(pref.timezone);
          const dayW = weekW?.days.find((d) => d.date === localTomorrowIso);
          if (dayW) tomorrowWeather = dayW;
        } catch (err) {
          notifyLogger.warn({ err, timezone: pref.timezone }, 'Weather fetch failed for evening review');
        }
      }
      const featureUsage = this.deps.featureUsageRepo?.getForUser(pref.user_id);
      const tipCtx = buildTipContext(pref, featureUsage);
      const botTip = agendaEvents.length === 0 ? pickBotTip(lang, tipCtx) : null;
      // TODO: 'image' format requires sendPhoto (architectural change) — render as text for now
      const payload = renderer.renderEveningReview(lang, dateLabel, agendaEvents, {
        weather: tomorrowWeather,
        botTip,
      }).text;
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

    // 5. Weekly digest (Sunday only, at user's evening_review_time)
    if (minute.getUTCDay() === 0) {
      const weeklyPrefs = this.deps.prefsRepo.getAllEveningEnabled();
      for (const pref of weeklyPrefs) {
        if (!isLocalTimeInWindow(nowUtc, pref.timezone, pref.evening_review_time, 5)) continue;

        // Next Monday = tomorrow (Sunday + 1 day)
        const nextMonDate = new Date(minute.getTime() + 86_400_000);
        const nextMonLocalIso = new TZDate(nextMonDate, pref.timezone).toISOString().slice(0, 10);
        const nextMonLocalDate = new Date(`${nextMonLocalIso}T12:00:00Z`);
        const weekYear = isoWeekYear(nextMonLocalDate);
        const weekNum = isoWeekNumber(nextMonLocalDate);
        const weekStr = `${weekYear}-W${String(weekNum).padStart(2, '0')}`;
        const refKey = `wd:${pref.user_id}:${weekStr}`;

        const lang = pref.language ?? 'en';

        // Build Mon–Sun local calendar dates for next week.
        // Fetch all 7 days in one range query, then slice per day in memory.
        const sunCalDateForRange = new Date(`${nextMonLocalIso}T12:00:00Z`);
        sunCalDateForRange.setUTCDate(sunCalDateForRange.getUTCDate() + 6);
        const { start: weekRangeStart } = getDayRangeUtc(new Date(`${nextMonLocalIso}T12:00:00Z`), pref.timezone);
        const { end: weekRangeEnd } = getDayRangeUtc(sunCalDateForRange, pref.timezone);
        const allWeekOccurrences = this.deps.getEventsInRange(pref.user_id, weekRangeStart, weekRangeEnd);

        const days: WeeklyDigestDay[] = [];
        for (let i = 0; i < 7; i++) {
          const calDate = new Date(`${nextMonLocalIso}T12:00:00Z`);
          calDate.setUTCDate(calDate.getUTCDate() + i);
          const dateStr = calDate.toISOString().slice(0, 10);
          const { start: dayStart, end: dayEnd } = getDayRangeUtc(calDate, pref.timezone);
          const dayOccs = allWeekOccurrences.filter(
            (occ) => occ.occurrence_start >= dayStart && occ.occurrence_start < dayEnd,
          );
          const dayLabel = makeDayLabel(calDate, lang);
          days.push({
            date: dateStr,
            dayLabel,
            events: dayOccs.map((occ) => ({
              title: occ.event.title,
              startTime: format(new TZDate(occ.occurrence_start, pref.timezone), 'HH:mm'),
              isAllDay: occ.event.all_day === 1,
            })),
          });
        }

        const sunCalDate = new Date(`${nextMonLocalIso}T12:00:00Z`);
        sunCalDate.setUTCDate(sunCalDate.getUTCDate() + 6);
        const weekRange = makeWeekRangeLabel(new Date(`${nextMonLocalIso}T12:00:00Z`), sunCalDate, lang);

        // Fetch week weather for digest
        let weatherByDate: { [date: string]: DayWeather } | undefined;
        if (this.deps.weatherService) {
          try {
            const weekW = await this.deps.weatherService.getWeekWeather(pref.timezone);
            if (weekW) {
              weatherByDate = {};
              for (const d of weekW.days) {
                weatherByDate[d.date] = d;
              }
            }
          } catch (err) {
            notifyLogger.warn({ err, timezone: pref.timezone }, 'Weather fetch failed for weekly digest');
          }
        }

        const payload = renderer.renderWeeklyDigest(lang, weekRange, days, { weatherByDate }).text;

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
    if (!this.deps.callSettingsRepo) return false;
    const callSettings = this.deps.callSettingsRepo.get(userId);
    if (!callSettings?.enabled) return false;

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
