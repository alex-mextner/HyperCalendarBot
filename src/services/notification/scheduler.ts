import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';
import { type Lang, type Messages, t, toLang } from '../../config/constants.ts';
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
import type {
  DueReminderRow,
  EventOccurrence,
  FeatureUsageRow,
  NotificationPreferencesRow,
  User,
} from '../../database/types.ts';
import { getDayRangeUtc } from '../../utils/date.ts';
import { notifyLogger } from '../../utils/logger.ts';
import {
  renderBatchReminderForSpeech,
  renderEveningReviewForSpeech,
  renderMorningAgendaForSpeech,
  renderReminderForSpeech,
  renderWeeklyDigestForSpeech,
} from '../voice/tts-renderer.ts';
import type { DayWeather, EventForecast } from '../weather/types.ts';
import type { WeatherService } from '../weather/weather-service.ts';
import { detectClockChange, formatClockChangeNotice } from './clock-change.ts';
import type { AgendaEvent, BatchReminderItem, WeeklyDigestDay } from './renderer.ts';
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
    return {
      title: occ.event.title,
      startTime,
      endTime,
      location: occ.event.location,
      resolvedAddress: occ.event.resolved_address,
      googleMapsUrl: occ.event.google_maps_url,
      venueName: occ.event.venue_name,
      locationVerified: occ.event.location_verified === 1,
      duration,
      isAllDay,
    };
  });
}

function makeDateLabel(dateStr: string, timezone: string, lang: string): string {
  const d = new TZDate(`${dateStr}T12:00:00Z`, timezone);
  const locale = lang === 'ru' ? ru : enUS;
  const pattern = lang === 'ru' ? 'EEEE, d MMMM' : 'EEEE, MMMM d';
  return format(d, pattern, { locale });
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
  tipKeys: string[],
  featureUsage: FeatureUsageRow[],
): { normal: string[]; reEngage: string[] } {
  const now = Date.now();
  const usageMap = new Map(featureUsage.map((u) => [u.feature_key, u]));

  const normal: string[] = [];
  const reEngage: string[] = [];

  for (const tipKey of tipKeys) {
    const featureKey = BOT_TIP_FEATURE_MAP[tipKey];
    if (!featureKey) {
      normal.push(tipKey);
      continue;
    }
    const usage = usageMap.get(featureKey);
    if (!usage) {
      // Never used — discovery tip
      normal.push(tipKey);
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
      reEngage.push(tipKey);
    } else {
      normal.push(tipKey);
    }
  }

  return { normal, reEngage };
}

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** Settings prompts for the features the user has not enabled yet, in display priority order. */
function missingFeatureTips(l: Messages, ctx: TipContext): string[] {
  const rules: ReadonlyArray<readonly [boolean, string]> = [
    [ctx.hasEveningReview, l.contextualTips.noEveningReview],
    [ctx.hasMorningAgenda, l.contextualTips.noMorningAgenda],
    [ctx.hasQuietHours, l.contextualTips.noQuietHours],
    [ctx.hasGoogle, l.contextualTips.noGoogleCalendar],
    [ctx.hasCountry, l.contextualTips.noCountry],
    [ctx.hasVoiceCalls, l.contextualTips.noVoiceCalls],
  ];
  return rules.filter(([hasFeature]) => !hasFeature).map(([, tip]) => tip);
}

/** Pick a tip honouring feature usage; `null` when usage filtering leaves nothing to pick from. */
function pickUsageAwareTip(tipEntries: Array<[string, string]>, featureUsage: FeatureUsageRow[]): string | null {
  const tipMap = new Map(tipEntries);
  const { normal, reEngage } = filterTipsByUsage(
    tipEntries.map(([k]) => k),
    featureUsage,
  );
  // 40% chance to pick a re-engagement tip if available
  if (reEngage.length > 0 && Math.random() < 0.4) return tipMap.get(pickRandom(reEngage))!;
  if (normal.length > 0) return tipMap.get(pickRandom(normal))!;
  return null;
}

function pickBotTipText(tipEntries: Array<[string, string]>, featureUsage: FeatureUsageRow[] | undefined): string {
  // Filter tips by feature usage if available
  if (featureUsage && featureUsage.length > 0) {
    const usageAware = pickUsageAwareTip(tipEntries, featureUsage);
    if (usageAware !== null) return usageAware;
  }
  return pickRandom(tipEntries)[1];
}

/** Pick a random bot tip, contextual tip, or book quote for free days (shown ~50% of the time) */
export function pickBotTip(lang: string, ctx?: TipContext): string | null {
  if (Math.random() > 0.5) return null;
  const l = t(toLang(lang));

  // 30% chance: try a contextual tip based on user's missing features
  if (ctx && Math.random() < 0.3) {
    const candidates = missingFeatureTips(l, ctx);
    if (candidates.length > 0) return pickRandom(candidates);
  }

  // 50% bot tips, 50% book quotes
  if (Math.random() < 0.5) return pickBotTipText(Object.entries(l.botTips), ctx?.featureUsage);
  return pickRandom([...l.gtdQuotes, ...l.atomicHabitsQuotes, ...l.deepWorkQuotes, ...l.sevenHabitsQuotes]);
}

/** Fetch day weather with graceful failure */
async function fetchDayWeather(
  weatherService: WeatherService | undefined,
  timezone: string,
  lang = 'en',
): Promise<DayWeather | null> {
  if (!weatherService) return null;
  try {
    return await weatherService.getDayWeather(timezone, lang);
  } catch (err) {
    notifyLogger.warn({ err, timezone }, 'Weather fetch failed for agenda');
    return null;
  }
}

/**
 * Fetch forecast anchored to a specific event time (hourly when possible).
 * For all-day events the daily forecast for the event's date is returned —
 * showing the temperature at midnight of a whole-day event is misleading.
 */
async function fetchEventForecast(
  weatherService: WeatherService | undefined,
  timezone: string,
  eventStartAt: string,
  isAllDay: boolean,
  lang = 'en',
): Promise<EventForecast | null> {
  if (!weatherService) return null;
  try {
    return await weatherService.getForecastAt(timezone, new Date(eventStartAt).getTime(), lang, {
      allDay: isAllDay,
    });
  } catch (err) {
    notifyLogger.warn({ err, timezone }, 'Weather fetch failed for event reminder');
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

/** Preference row joined with the user's timezone/language and feature flags. */
type EnabledPref = NotificationPreferencesRow & UserContextFlags;

/** Users listed by `iterateTimezoneInfo` (only the columns the clock-change phase reads). */
type TimezoneUser = Pick<User, 'telegram_id' | 'timezone' | 'language'>;

type QuietHoursPrefs = Pick<
  NotificationPreferencesRow,
  'quiet_hours_enabled' | 'quiet_hours_start' | 'quiet_hours_end'
>;

/** Speech renderer shared by the morning agenda and evening review calls. */
type AgendaSpeechRenderer = typeof renderMorningAgendaForSpeech;

/** Everything the weekly-digest voice call needs beyond the user's prefs. */
interface WeeklyDigestContent {
  lang: Lang;
  weekRange: string;
  days: WeeklyDigestDay[];
  weekStr: string;
}

const DAY_MS = 86_400_000;

function isPrefQuietNow(prefs: QuietHoursPrefs, nowUtc: Date, timezone: string): boolean {
  return isQuietHours(
    { enabled: !!prefs.quiet_hours_enabled, start: prefs.quiet_hours_start, end: prefs.quiet_hours_end },
    nowUtc,
    timezone,
  );
}

function formatLocalHHmm(isoUtc: string, timezone: string): string {
  return format(new TZDate(isoUtc, timezone), 'HH:mm');
}

/** `interval_minutes === -1` marks the "day before" reminder of an all-day event. */
function isAllDayReminder(reminder: DueReminderRow): boolean {
  return reminder.interval_minutes === -1;
}

/** Group by (user_id, remind_at_utc): several reminders firing together become one batch. */
function groupRemindersByUserAndTime(dueReminders: DueReminderRow[]): Map<string, DueReminderRow[]> {
  const byKey = new Map<string, DueReminderRow[]>();
  for (const reminder of dueReminders) {
    const key = `${reminder.user_id}:${reminder.remind_at_utc}`;
    const group = byKey.get(key);
    if (group) {
      group.push(reminder);
    } else {
      byKey.set(key, [reminder]);
    }
  }
  return byKey;
}

function toBatchRenderItems(
  group: DueReminderRow[],
  forecasts: Array<EventForecast | null>,
  timezone: string,
): BatchReminderItem[] {
  return group.map((r, idx) => ({
    title: r.event_title,
    startTime: formatLocalHHmm(r.event_start_at, timezone),
    location: r.event_location,
    resolvedAddress: r.event_resolved_address,
    googleMapsUrl: r.event_google_maps_url,
    venueName: r.event_venue_name,
    locationVerified: r.event_location_verified === 1,
    intervalLabel: r.interval_label,
    isAllDay: isAllDayReminder(r),
    forecast: forecasts[idx] ?? null,
  }));
}

/** A calendar date (YYYY-MM-DD) at 12:00Z, shifted by whole days; noon keeps UTC date maths DST-proof. */
function calendarNoon(dateIso: string, plusDays = 0): Date {
  const d = new Date(`${dateIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d;
}

function isoWeekLabel(mondayIso: string): string {
  const monday = calendarNoon(mondayIso);
  return `${isoWeekYear(monday)}-W${String(isoWeekNumber(monday)).padStart(2, '0')}`;
}

function buildDigestDay(
  calDate: Date,
  weekOccurrences: EventOccurrence[],
  timezone: string,
  lang: string,
): WeeklyDigestDay {
  const { start: dayStart, end: dayEnd } = getDayRangeUtc(calDate, timezone);
  const dayOccs = weekOccurrences.filter((occ) => occ.occurrence_start >= dayStart && occ.occurrence_start < dayEnd);
  return {
    date: calDate.toISOString().slice(0, 10),
    dayLabel: makeDayLabel(calDate, lang),
    events: dayOccs.map((occ) => ({
      title: occ.event.title,
      startTime: formatLocalHHmm(occ.occurrence_start, timezone),
      isAllDay: occ.event.all_day === 1,
    })),
  };
}

/** Slice one range-query result into the Mon–Sun days starting at `mondayIso`. */
function buildWeekDigestDays(
  weekOccurrences: EventOccurrence[],
  mondayIso: string,
  timezone: string,
  lang: string,
): WeeklyDigestDay[] {
  const days: WeeklyDigestDay[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(buildDigestDay(calendarNoon(mondayIso, i), weekOccurrences, timezone, lang));
  }
  return days;
}

/** Tomorrow's forecast from the week forecast (day index 1), `null` when unavailable or failing. */
async function fetchTomorrowWeather(
  weatherService: WeatherService | undefined,
  timezone: string,
  lang: string,
  localTomorrowIso: string,
): Promise<DayWeather | null> {
  if (!weatherService) return null;
  try {
    const weekWeather = await weatherService.getWeekWeather(timezone, lang);
    return weekWeather?.days.find((d) => d.date === localTomorrowIso) ?? null;
  } catch (err) {
    notifyLogger.warn({ err, timezone }, 'Weather fetch failed for evening review');
    return null;
  }
}

/** Week forecast keyed by date for the digest, `undefined` when unavailable or failing. */
async function fetchWeatherByDate(
  weatherService: WeatherService | undefined,
  timezone: string,
  lang: string,
): Promise<{ [date: string]: DayWeather } | undefined> {
  if (!weatherService) return undefined;
  try {
    const weekWeather = await weatherService.getWeekWeather(timezone, lang);
    if (!weekWeather) return undefined;
    const weatherByDate: { [date: string]: DayWeather } = {};
    for (const d of weekWeather.days) {
      weatherByDate[d.date] = d;
    }
    return weatherByDate;
  } catch (err) {
    notifyLogger.warn({ err, timezone }, 'Weather fetch failed for weekly digest');
    return undefined;
  }
}

/**
 * Query 3 consecutive UTC dates to cover all timezone offsets (UTC-14 to UTC+14); the caller then
 * verifies each user's actual local tomorrow with getHolidayForUser.
 */
function collectEveHolidayCandidateIds(holidayRepo: HolidayRepository, minute: Date): number[] {
  const utcToday = minute.toISOString().slice(0, 10);
  const utcTomorrow = new Date(minute.getTime() + DAY_MS).toISOString().slice(0, 10);
  const utcDayAfter = new Date(minute.getTime() + 2 * DAY_MS).toISOString().slice(0, 10);
  const candidates = new Set<number>();
  for (const date of [utcToday, utcTomorrow, utcDayAfter]) {
    for (const row of holidayRepo.getUsersWithNotifyForDate(date)) {
      candidates.add(row.user_id);
    }
  }
  return [...candidates];
}

export class NotificationScheduler {
  private deps: SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  /**
   * One scheduler minute. Phases run in a fixed order (cleanup, reminders, morning agendas,
   * standalone clock changes, eve-holidays, evening reviews, weekly digest) because the
   * enqueue order is observable by the queue consumers.
   */
  async tick(nowUtc: Date): Promise<void> {
    const minute = truncateToMinute(nowUtc);

    this.runWeeklyLogCleanup(minute);
    await this.enqueueEventReminders(nowUtc, minute);
    const morningPrefs = await this.enqueueMorningAgendas(nowUtc);
    this.enqueueStandaloneClockChanges(nowUtc, morningPrefs);
    this.enqueueEveHolidays(nowUtc, minute);
    await this.enqueueEveningReviews(nowUtc);
    await this.enqueueWeeklyDigests(nowUtc, minute);
  }

  /** Weekly cleanup: Sundays at 03:00 UTC */
  private runWeeklyLogCleanup(minute: Date): void {
    if (minute.getUTCDay() !== 0 || minute.getUTCHours() !== 3) return;
    const deleted = this.deps.logRepo.cleanup(30);
    notifyLogger.info({ deleted }, 'Notification log cleanup ran');
  }

  /** Every notification type is delivered as telegram text; `null` means this reference key was already logged. */
  private insertTelegramLog(userId: number, type: string, referenceKey: string, payload: string): number | null {
    return this.deps.logRepo.insert({
      user_id: userId,
      type,
      reference_key: referenceKey,
      channel: 'telegram_text',
      payload,
    });
  }

  // ── 1. Event reminders ────────────────────────────────────────────────────

  private async enqueueEventReminders(nowUtc: Date, minute: Date): Promise<void> {
    const windowStart = minute.toISOString();
    const windowEnd = new Date(minute.getTime() + 60_000).toISOString();
    const dueReminders = this.deps.reminderRepo.getDue(windowStart, windowEnd);
    const byKey = groupRemindersByUserAndTime(dueReminders);

    // Batch-fetch users and prefs for all reminder groups in one query each
    const reminderUserIds = [...new Set([...byKey.values()].map((g) => g[0]!.user_id))];
    const usersMap = this.deps.userRepo.findManyByTelegramIds(reminderUserIds);
    const prefsMap = this.deps.prefsRepo.getMany(reminderUserIds);

    for (const group of byKey.values()) {
      const firstReminder = group[0]!;
      const user = usersMap.get(firstReminder.user_id);
      if (!user) continue;
      const prefs = prefsMap.get(firstReminder.user_id);
      if (prefs && isPrefQuietNow(prefs, nowUtc, user.timezone)) continue;

      if (group.length > 1) {
        await this.enqueueReminderBatch(group, user, nowUtc);
      } else {
        await this.enqueueSingleReminder(firstReminder, user, nowUtc);
      }
    }
  }

  /** Batch: one combined job for all reminders in this group. */
  private async enqueueReminderBatch(group: DueReminderRow[], user: User, nowUtc: Date): Promise<void> {
    const firstReminder = group[0]!;
    const lang = user.language ?? 'en';
    const refKey = `erb:${firstReminder.user_id}:${firstReminder.remind_at_utc}`;
    const forecasts = await Promise.all(
      group.map((r) =>
        fetchEventForecast(this.deps.weatherService, user.timezone, r.event_start_at, isAllDayReminder(r), lang),
      ),
    );
    const rendered = renderer.renderBatchReminder(lang, toBatchRenderItems(group, forecasts, user.timezone));
    const payload = JSON.stringify({ text: rendered.text, event_ids: group.map((r) => r.event_id) });
    const logId = this.insertTelegramLog(firstReminder.user_id, 'event_reminder_batch', refKey, payload);
    if (logId === null) return;
    for (const r of group) {
      this.deps.reminderRepo.markSent(r.id);
    }
    this.deps.enqueue('event_reminder_batch', firstReminder.user_id, logId, payload);
    notifyLogger.info({ userId: firstReminder.user_id, count: group.length }, 'Batch event reminder enqueued');

    this.enqueueBatchReminderCall(group, user, nowUtc);
  }

  private enqueueBatchReminderCall(group: DueReminderRow[], user: User, nowUtc: Date): void {
    const userId = group[0]!.user_id;
    if (!this.isCallAllowed(userId, nowUtc, user.timezone)) return;
    const ttsText = renderBatchReminderForSpeech({
      lang: user.language ?? 'en',
      items: group.map((r) => ({
        event_title: r.event_title,
        event_start_at: r.event_start_at,
        timezone: user.timezone,
      })),
    });
    this.deps.enqueueCall?.({ userId, ttsText, language: user.language ?? 'en' });
    notifyLogger.info({ userId, count: group.length }, 'Batch voice call enqueued');
  }

  private async enqueueSingleReminder(reminder: DueReminderRow, user: User, nowUtc: Date): Promise<void> {
    const refKey = `er:${reminder.id}`;
    const lang = user.language ?? 'en';
    const startTime = formatLocalHHmm(reminder.event_start_at, user.timezone);
    const endTime = reminder.event_end_at ? formatLocalHHmm(reminder.event_end_at, user.timezone) : undefined;
    const isAllDay = isAllDayReminder(reminder);
    const forecast = await fetchEventForecast(
      this.deps.weatherService,
      user.timezone,
      reminder.event_start_at,
      isAllDay,
      lang,
    );
    const rendered = renderer.renderEventReminder(lang, {
      title: reminder.event_title,
      startTime,
      endTime,
      location: reminder.event_location,
      resolvedAddress: reminder.event_resolved_address,
      googleMapsUrl: reminder.event_google_maps_url,
      venueName: reminder.event_venue_name,
      locationVerified: reminder.event_location_verified === 1,
      intervalLabel: reminder.interval_label,
      isAllDay,
      forecast,
    });
    const payload = JSON.stringify({ text: rendered.text, event_id: reminder.event_id });
    const logId = this.insertTelegramLog(reminder.user_id, 'event_reminder', refKey, payload);
    if (logId === null) return;
    this.deps.reminderRepo.markSent(reminder.id);
    this.deps.enqueue('event_reminder', reminder.user_id, logId, payload);
    notifyLogger.info({ userId: reminder.user_id, eventId: reminder.event_id }, 'Event reminder enqueued');

    this.enqueueSingleReminderCall(reminder, user, nowUtc);
  }

  private enqueueSingleReminderCall(reminder: DueReminderRow, user: User, nowUtc: Date): void {
    if (!this.isCallAllowed(reminder.user_id, nowUtc, user.timezone)) return;
    const ttsText = renderReminderForSpeech({
      title: reminder.event_title,
      startAt: reminder.event_start_at,
      timezone: user.timezone,
      location: reminder.event_location,
      // Only a confirmed venue is spoken; otherwise the typed text.
      venueName: reminder.event_location_verified === 1 ? reminder.event_venue_name : null,
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

  // ── 2. Morning agendas ────────────────────────────────────────────────────

  /** Returns the morning-enabled prefs so the clock-change phase can skip those users. */
  private async enqueueMorningAgendas(nowUtc: Date): Promise<EnabledPref[]> {
    const morningPrefs = this.deps.prefsRepo.getAllMorningEnabled();
    for (const pref of morningPrefs) {
      await this.enqueueMorningAgenda(pref, nowUtc);
    }
    return morningPrefs;
  }

  private async enqueueMorningAgenda(pref: EnabledPref, nowUtc: Date): Promise<void> {
    if (!isLocalTimeInWindow(nowUtc, pref.timezone, pref.morning_agenda_time, 5)) return;
    if (isPrefQuietNow(pref, nowUtc, pref.timezone)) return;
    const localTodayIso = new TZDate(nowUtc, pref.timezone).toISOString().slice(0, 10);
    const { start: dayStart, end: dayEnd } = getDayRangeUtc(nowUtc, pref.timezone);
    const occurrences = this.deps.getEventsInRange(pref.user_id, dayStart, dayEnd);
    const clockChange = detectClockChange(pref.timezone, localTodayIso);
    const refKey = `ma:${pref.user_id}:${localTodayIso}`;
    const lang = toLang(pref.language);
    const dateLabel = makeDateLabel(localTodayIso, pref.timezone, lang);
    const agendaEvents = toAgendaEvents(occurrences, pref.timezone, lang);
    const weather = await fetchDayWeather(this.deps.weatherService, pref.timezone, lang);
    const botTip = this.pickFreeDayTip(pref, lang, agendaEvents.length);
    // TODO: 'image' format requires sendPhoto (architectural change) — render as text for now
    let payload = renderer.renderMorningAgenda(lang, dateLabel, agendaEvents, { weather, botTip }).text;
    if (clockChange) {
      payload += `\n\n${formatClockChangeNotice(lang, clockChange)}`;
    }
    const logId = this.insertTelegramLog(pref.user_id, 'morning_agenda', refKey, payload);
    if (logId === null) return;
    this.deps.enqueue('morning_agenda', pref.user_id, logId, payload);
    notifyLogger.info({ userId: pref.user_id }, 'Morning agenda enqueued');

    this.enqueueAgendaCall(
      pref,
      nowUtc,
      renderMorningAgendaForSpeech,
      { lang, dateLabel, events: agendaEvents },
      'Morning agenda voice call enqueued',
    );
  }

  /** A bot tip / quote is only shown on free days (no events). Feature usage is read either way. */
  private pickFreeDayTip(pref: EnabledPref, lang: Lang, eventCount: number): string | null {
    const featureUsage = this.deps.featureUsageRepo?.getForUser(pref.user_id);
    const tipCtx = buildTipContext(pref, featureUsage);
    return eventCount === 0 ? pickBotTip(lang, tipCtx) : null;
  }

  /** Shared by the morning agenda and evening review: same call shape, different speech renderer. */
  private enqueueAgendaCall(
    pref: EnabledPref,
    nowUtc: Date,
    renderSpeech: AgendaSpeechRenderer,
    speech: { lang: Lang; dateLabel: string; events: AgendaEvent[] },
    logMessage: string,
  ): void {
    if (!this.isCallAllowed(pref.user_id, nowUtc, pref.timezone)) return;
    const ttsText = renderSpeech(speech);
    this.deps.enqueueCall?.({ userId: pref.user_id, ttsText, language: speech.lang });
    notifyLogger.info({ userId: pref.user_id }, logMessage);
  }

  // ── 2b. Standalone clock-change notifications ─────────────────────────────

  /**
   * For users without morning agenda; sent at 08:00 local time on the day of the DST transition.
   * Cursor-based batching: reads 100 users at a time, never loads full table.
   */
  private enqueueStandaloneClockChanges(nowUtc: Date, morningPrefs: EnabledPref[]): void {
    const morningUserIds = new Set(morningPrefs.map((p) => p.user_id));
    for (const batch of this.deps.userRepo.iterateTimezoneInfo(morningUserIds)) {
      for (const user of batch) {
        this.enqueueClockChange(user, nowUtc);
      }
    }
  }

  private enqueueClockChange(user: TimezoneUser, nowUtc: Date): void {
    if (!isLocalTimeInWindow(nowUtc, user.timezone, '08:00', 5)) return;
    const localTodayIso = new TZDate(nowUtc, user.timezone).toISOString().slice(0, 10);
    const clockChange = detectClockChange(user.timezone, localTodayIso);
    if (!clockChange) return;
    const lang = toLang(user.language);
    const refKey = `cc:${user.telegram_id}:${localTodayIso}`;
    const payload = formatClockChangeNotice(lang, clockChange);
    const logId = this.insertTelegramLog(user.telegram_id, 'clock_change', refKey, payload);
    if (logId === null) return;
    this.deps.enqueue('clock_change', user.telegram_id, logId, payload);
    notifyLogger.info(
      { userId: user.telegram_id, direction: clockChange.direction, minutes: clockChange.minutes },
      'Clock change notification enqueued',
    );
  }

  // ── 3. Eve-holiday notifications (per-user local tomorrow date) ───────────

  private enqueueEveHolidays(nowUtc: Date, minute: Date): void {
    const holidayRepo = this.deps.holidayRepo;
    if (!holidayRepo) return;
    const candidateIds = collectEveHolidayCandidateIds(holidayRepo, minute);
    const usersMap = this.deps.userRepo.findManyByTelegramIds(candidateIds);
    const prefsMap = this.deps.prefsRepo.getMany(candidateIds);

    for (const userId of candidateIds) {
      this.enqueueEveHoliday(holidayRepo, userId, usersMap.get(userId), prefsMap.get(userId), nowUtc, minute);
    }
  }

  private enqueueEveHoliday(
    holidayRepo: HolidayRepository,
    userId: number,
    user: User | undefined,
    prefs: NotificationPreferencesRow | undefined,
    nowUtc: Date,
    minute: Date,
  ): void {
    if (!user) return;
    const targetTime = prefs?.evening_review_time ?? DEFAULT_EVE_HOLIDAY_HHMM;
    if (!isLocalTimeInWindow(nowUtc, user.timezone, targetTime, 5)) return;
    const localTomorrowIso = new TZDate(new Date(minute.getTime() + DAY_MS), user.timezone).toISOString().slice(0, 10);
    const holiday = holidayRepo.getHolidayForUser(userId, localTomorrowIso);
    if (!holiday) return;
    const refKey = `eh:${userId}:${localTomorrowIso}`;
    const payload = JSON.stringify({ date: localTomorrowIso, holidayName: holiday.holiday_name });
    const logId = this.insertTelegramLog(userId, 'eve_holiday', refKey, payload);
    if (logId === null) return;
    this.deps.enqueue('eve_holiday', userId, logId, payload);
    notifyLogger.info({ userId, holiday: holiday.holiday_name }, 'Eve-holiday notification enqueued');
  }

  // ── 4. Evening reviews ────────────────────────────────────────────────────

  private async enqueueEveningReviews(nowUtc: Date): Promise<void> {
    for (const pref of this.deps.prefsRepo.getAllEveningEnabled()) {
      await this.enqueueEveningReview(pref, nowUtc);
    }
  }

  private async enqueueEveningReview(pref: EnabledPref, nowUtc: Date): Promise<void> {
    if (!isLocalTimeInWindow(nowUtc, pref.timezone, pref.evening_review_time, 5)) return;
    if (isPrefQuietNow(pref, nowUtc, pref.timezone)) return;
    const tomorrowUtc = new Date(nowUtc.getTime() + DAY_MS);
    const localTomorrowIso = new TZDate(tomorrowUtc, pref.timezone).toISOString().slice(0, 10);
    const { start: tmStart, end: tmEnd } = getDayRangeUtc(calendarNoon(localTomorrowIso), pref.timezone);
    const occurrences = this.deps.getEventsInRange(pref.user_id, tmStart, tmEnd);
    const refKey = `ev:${pref.user_id}:${localTomorrowIso}`;
    const lang = toLang(pref.language);
    const dateLabel = makeDateLabel(localTomorrowIso, pref.timezone, lang);
    const agendaEvents = toAgendaEvents(occurrences, pref.timezone, lang);
    const tomorrowWeather = await fetchTomorrowWeather(this.deps.weatherService, pref.timezone, lang, localTomorrowIso);
    const botTip = this.pickFreeDayTip(pref, lang, agendaEvents.length);
    // TODO: 'image' format requires sendPhoto (architectural change) — render as text for now
    const payload = renderer.renderEveningReview(lang, dateLabel, agendaEvents, {
      weather: tomorrowWeather,
      botTip,
    }).text;
    const logId = this.insertTelegramLog(pref.user_id, 'evening_review', refKey, payload);
    if (logId === null) return;
    this.deps.enqueue('evening_review', pref.user_id, logId, payload);
    notifyLogger.info({ userId: pref.user_id }, 'Evening review enqueued');

    this.enqueueAgendaCall(
      pref,
      nowUtc,
      renderEveningReviewForSpeech,
      { lang, dateLabel, events: agendaEvents },
      'Evening review voice call enqueued',
    );
  }

  // ── 5. Weekly digest (Sunday only, at user's evening_review_time) ─────────

  private async enqueueWeeklyDigests(nowUtc: Date, minute: Date): Promise<void> {
    if (minute.getUTCDay() !== 0) return;
    for (const pref of this.deps.prefsRepo.getAllEveningEnabled()) {
      await this.enqueueWeeklyDigest(pref, nowUtc, minute);
    }
  }

  private async enqueueWeeklyDigest(pref: EnabledPref, nowUtc: Date, minute: Date): Promise<void> {
    if (!isLocalTimeInWindow(nowUtc, pref.timezone, pref.evening_review_time, 5)) return;

    // Next Monday = tomorrow (Sunday + 1 day)
    const nextMonDate = new Date(minute.getTime() + DAY_MS);
    const nextMonLocalIso = new TZDate(nextMonDate, pref.timezone).toISOString().slice(0, 10);
    const weekStr = isoWeekLabel(nextMonLocalIso);
    const refKey = `wd:${pref.user_id}:${weekStr}`;
    const lang = toLang(pref.language);

    const days = this.loadDigestDays(pref, nextMonLocalIso, lang);
    const weekRange = makeWeekRangeLabel(calendarNoon(nextMonLocalIso), calendarNoon(nextMonLocalIso, 6), lang);
    const weatherByDate = await fetchWeatherByDate(this.deps.weatherService, pref.timezone, lang);
    const payload = renderer.renderWeeklyDigest(lang, weekRange, days, { weatherByDate }).text;

    const logId = this.insertTelegramLog(pref.user_id, 'weekly_digest', refKey, payload);
    if (logId === null) return;
    this.deps.enqueue('weekly_digest', pref.user_id, logId, payload);
    notifyLogger.info({ userId: pref.user_id, week: weekStr }, 'Weekly digest enqueued');

    this.enqueueDigestCall(pref, nowUtc, { lang, weekRange, days, weekStr });
  }

  /** Mon–Sun local calendar days of next week: one range query for all 7 days, sliced per day in memory. */
  private loadDigestDays(pref: EnabledPref, nextMonLocalIso: string, lang: string): WeeklyDigestDay[] {
    const { start: weekRangeStart } = getDayRangeUtc(calendarNoon(nextMonLocalIso), pref.timezone);
    const { end: weekRangeEnd } = getDayRangeUtc(calendarNoon(nextMonLocalIso, 6), pref.timezone);
    const allWeekOccurrences = this.deps.getEventsInRange(pref.user_id, weekRangeStart, weekRangeEnd);
    return buildWeekDigestDays(allWeekOccurrences, nextMonLocalIso, pref.timezone, lang);
  }

  private enqueueDigestCall(pref: EnabledPref, nowUtc: Date, digest: WeeklyDigestContent): void {
    if (!this.isCallAllowed(pref.user_id, nowUtc, pref.timezone)) return;
    const digestDays = digest.days.map((d) => ({
      dayLabel: d.dayLabel,
      events: d.events.map((e) => ({ title: e.title, startTime: e.startTime })),
    }));
    const ttsText = renderWeeklyDigestForSpeech({ lang: digest.lang, weekRange: digest.weekRange, days: digestDays });
    this.deps.enqueueCall?.({ userId: pref.user_id, ttsText, language: digest.lang });
    notifyLogger.info({ userId: pref.user_id, week: digest.weekStr }, 'Weekly digest voice call enqueued');
  }

  /** Call quiet hours and the daily cap are user-local: HH:MM on the user's clock, the day from local midnight. */
  private isCallAllowed(userId: number, nowUtc: Date, timezone: string): boolean {
    if (!this.deps.callSettingsRepo) return false;
    const callSettings = this.deps.callSettingsRepo.get(userId);
    if (!callSettings?.enabled) return false;

    const quiet = { enabled: true, start: callSettings.quiet_hours_start, end: callSettings.quiet_hours_end };
    if (isQuietHours(quiet, nowUtc, timezone)) {
      notifyLogger.info({ userId }, 'Voice call skipped (quiet hours)');
      return false;
    }

    const localDayStartUtc = getDayRangeUtc(nowUtc, timezone).start;
    const dailyCount = this.deps.callLogRepo?.countCallsSince(userId, localDayStartUtc) ?? 0;
    return dailyCount < callSettings.max_daily_calls;
  }
}
