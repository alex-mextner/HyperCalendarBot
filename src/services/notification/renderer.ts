import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { buildGoogleMapsSearchUrl } from '../location/geocoding-service.ts';
import { renderReminderForSpeech } from '../voice/tts-renderer.ts';
import { formatDayWeatherLine, formatEventWeatherLine } from '../weather/format.ts';
import type { DayWeather, EventForecast } from '../weather/types.ts';
import { weatherEmoji } from '../weather/weather-service.ts';

/**
 * Format location as HTML link to Google Maps.
 * Display text priority: venue name → resolved address → raw location.
 * When venue exists AND differs from resolved address, show both: "Venue — Address".
 */
function locationLink(
  location: string | null,
  resolvedAddress?: string | null,
  googleMapsUrl?: string | null,
  venueName?: string | null,
): string {
  if (!location) return '';
  let displayText: string;
  if (venueName) {
    displayText = resolvedAddress ? `${escapeHtml(venueName)} — ${escapeHtml(resolvedAddress)}` : escapeHtml(venueName);
  } else if (resolvedAddress) {
    displayText = escapeHtml(resolvedAddress);
  } else {
    displayText = escapeHtml(location);
  }
  const url = googleMapsUrl ?? buildGoogleMapsSearchUrl(location);
  return `<a href="${escapeHtml(url)}">${displayText}</a>`;
}

export interface VoiceRenderInput {
  title: string;
  startAt: string;
  timezone: string;
  location?: string | null;
  venueName?: string | null;
  language: string;
}

export interface RenderedNotification {
  channel: 'telegram_text' | 'telegram_voice_call';
  text: string;
}

export interface AgendaEvent {
  title: string;
  startTime: string;
  endTime: string;
  location: string | null;
  resolvedAddress?: string | null;
  googleMapsUrl?: string | null;
  venueName?: string | null;
  duration: string;
  isAllDay?: boolean;
}

export interface ReminderData {
  title: string;
  startTime: string;
  endTime?: string;
  location: string | null;
  resolvedAddress?: string | null;
  googleMapsUrl?: string | null;
  venueName?: string | null;
  intervalLabel: string;
  isAllDay?: boolean;
  /** Weather forecast anchored to the event's start time (hourly when possible) */
  forecast?: EventForecast | null;
}

export interface BatchReminderItem {
  title: string;
  startTime: string;
  location: string | null;
  resolvedAddress?: string | null;
  googleMapsUrl?: string | null;
  venueName?: string | null;
  intervalLabel: string;
  isAllDay?: boolean;
  /** Weather forecast anchored to the event's start time (hourly when possible) */
  forecast?: EventForecast | null;
}

export interface WeeklyDigestEvent {
  title: string;
  startTime: string;
  isAllDay?: boolean;
}

export interface WeeklyDigestDay {
  date: string;
  dayLabel: string;
  events: WeeklyDigestEvent[];
}

const INTERVAL_RU: Record<string, string> = {
  'at start': 'сейчас',
  '5 minutes': '5 минут',
  '10 minutes': '10 минут',
  '15 minutes': '15 минут',
  '30 minutes': '30 минут',
  '1 hour': '1 час',
  '2 hours': '2 часа',
  '1 day': '1 день',
  '7 days before': '7 дней',
  'day before': 'завтра',
  'day of': 'сегодня',
};

export function localizeInterval(lang: string, label: string): string {
  if (lang !== 'ru') return label;
  if (INTERVAL_RU[label]) return INTERVAL_RU[label]!;
  const minMatch = label.match(/^(\d+) min$/);
  if (minMatch) return `${minMatch[1]} мин`;
  const hourMatch = label.match(/^(\d+(?:\.\d+)?)h$/);
  if (hourMatch) return `${Math.round(Number.parseFloat(hourMatch[1]!))} ч`;
  return label;
}

type NotificationLabels = ReturnType<typeof t>['notifications'];

function formatAgendaEventLine(e: AgendaEvent, l: NotificationLabels): string {
  const safeTitle = escapeHtml(e.title);
  const line = e.isAllDay ? `📅 ${safeTitle} (${l.allDay})` : `${e.startTime} — ${safeTitle} (${e.duration})`;
  return e.location
    ? `${line}\n        📍 ${locationLink(e.location, e.resolvedAddress, e.googleMapsUrl, e.venueName)}`
    : line;
}

interface AgendaConfig {
  emoji: string;
  greeting: string;
  greetingFree: string;
  freeDay: string;
  footer: string;
  lang: Lang;
  weather?: DayWeather | null;
  botTip?: string | null;
}

function renderAgenda(
  l: NotificationLabels,
  dateLabel: string,
  events: AgendaEvent[],
  config: AgendaConfig,
): RenderedNotification {
  const lines: string[] = [];
  const countLabel = events.length === 0 ? l.noEvents : l.eventsCount(events.length);
  lines.push(`📅 ${dateLabel} (${countLabel})`);
  if (config.weather) {
    lines.push(formatDayWeatherLine(config.lang, config.weather));
  }
  if (events.length === 0) {
    lines.push(`${config.emoji} ${config.greetingFree}`);
    lines.push('', config.freeDay);
    if (config.botTip) {
      lines.push('', config.botTip);
    }
  } else {
    lines.push(`${config.emoji} ${config.greeting}`);
    lines.push('');
    for (const e of events) {
      lines.push(formatAgendaEventLine(e, l));
    }
    lines.push('', config.footer);
  }
  return { channel: 'telegram_text', text: lines.join('\n') };
}

export interface AgendaWeatherOpts {
  weather?: DayWeather | null;
  botTip?: string | null;
}

export class NotificationRenderer {
  renderMorningAgenda(
    lang: string,
    dateLabel: string,
    events: AgendaEvent[],
    opts?: AgendaWeatherOpts,
  ): RenderedNotification {
    const langKey = lang as Lang;
    const l = t(langKey).notifications;
    return renderAgenda(l, dateLabel, events, {
      emoji: '👋',
      greeting: l.morning,
      greetingFree: l.morningFree,
      freeDay: l.freeDayMorning,
      footer: l.haveADay,
      lang: langKey,
      weather: opts?.weather,
      botTip: opts?.botTip,
    });
  }

  renderEventReminder(lang: string, data: ReminderData): RenderedNotification {
    const langKey = lang as Lang;
    const l = t(langKey).notifications;
    const localized = localizeInterval(lang, data.intervalLabel);
    const safeTitle = escapeHtml(data.title);
    const lines: string[] = [];
    if (data.intervalLabel === 'at start') {
      lines.push(`⏰ ${safeTitle} — ${l.startingNow}`);
    } else if (data.isAllDay) {
      lines.push(`⏰ ${safeTitle} — ${localized}`);
    } else {
      lines.push(`⏰ ${safeTitle} ${l.inLabel} ${localized}`);
    }
    lines.push('');
    if (data.isAllDay) {
      lines.push(`📅 ${l.allDay}`);
    } else if (data.endTime && data.endTime !== data.startTime) {
      lines.push(`🕐 ${data.startTime} — ${data.endTime}`);
    } else {
      lines.push(`🕐 ${data.startTime}`);
    }
    if (data.location) {
      lines.push(`📍 ${locationLink(data.location, data.resolvedAddress, data.googleMapsUrl, data.venueName)}`);
    }
    if (data.forecast) {
      lines.push(formatEventWeatherLine(langKey, data.forecast));
    }
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderBatchReminder(lang: string, items: BatchReminderItem[]): RenderedNotification {
    const langKey = lang as Lang;
    const l = t(langKey).notifications;
    const lines: string[] = [];
    const first = items[0];
    if (!first) return { channel: 'telegram_text', text: '' };
    const header =
      items.length === 1 ? escapeHtml(first.title) : l.batchHeader(escapeHtml(first.title), items.length - 1);
    lines.push(`⏰ ${header}`);

    // When every item shares the same forecast, show it once at the bottom
    const formattedForecasts = items.map((item) =>
      item.forecast ? formatEventWeatherLine(langKey, item.forecast) : null,
    );
    const allHaveForecast = formattedForecasts.every(Boolean);
    const uniqueNonNull = new Set(formattedForecasts.filter(Boolean));
    const sharedWeather = allHaveForecast && uniqueNonNull.size === 1 ? [...uniqueNonNull][0]! : null;

    lines.push('');
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const localized = localizeInterval(lang, item.intervalLabel);
      let intervalText: string;
      if (item.intervalLabel === 'at start') {
        intervalText = l.startingNow;
      } else if (item.isAllDay) {
        intervalText = localized;
      } else {
        intervalText = `${l.inLabel} ${localized}`;
      }
      const timeInfo = item.isAllDay ? l.allDay : item.startTime;
      const safeTitle = escapeHtml(item.title);
      let line = `• ${safeTitle} — ${timeInfo} (${intervalText})`;
      if (item.location) {
        line += `\n  📍 ${locationLink(item.location, item.resolvedAddress, item.googleMapsUrl, item.venueName)}`;
      }
      // Per-item weather only when forecasts differ across items
      if (!sharedWeather && formattedForecasts[i]) {
        line += `\n  ${formattedForecasts[i]}`;
      }
      lines.push(line);
    }
    if (sharedWeather) {
      lines.push('', sharedWeather);
    }
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderForVoice(input: VoiceRenderInput): RenderedNotification {
    const text = renderReminderForSpeech({
      title: input.title,
      startAt: input.startAt,
      timezone: input.timezone,
      location: input.location,
      venueName: input.venueName,
      language: input.language,
    });
    return { channel: 'telegram_voice_call', text };
  }

  renderWeeklyDigest(
    lang: string,
    weekRange: string,
    days: WeeklyDigestDay[],
    opts?: { weatherByDate?: { [date: string]: DayWeather } },
  ): RenderedNotification {
    const langKey = lang as Lang;
    const l = t(langKey).notifications;
    const weatherMap = opts?.weatherByDate;
    const lines: string[] = [];
    lines.push(l.weeklyDigest(weekRange));
    lines.push('');
    for (const day of days) {
      const dayW = weatherMap?.[day.date];
      const weatherSuffix = dayW ? ` ${weatherEmoji(dayW.conditionCode)} ${dayW.tempMin}..${dayW.tempMax}°` : '';
      if (day.events.length === 0) {
        lines.push(`${day.dayLabel}: (${l.noEvents})${weatherSuffix}`);
      } else {
        const eventList = day.events
          .map((e) => {
            const safeTitle = escapeHtml(e.title);
            return e.isAllDay ? `${l.allDay}: ${safeTitle}` : `${e.startTime} ${safeTitle}`;
          })
          .join(', ');
        lines.push(`${day.dayLabel}: ${eventList}${weatherSuffix}`);
      }
    }
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderEveHoliday(lang: string, holidayName: string): RenderedNotification {
    const l = t(lang as Lang).notifications;
    return { channel: 'telegram_text', text: l.eveHoliday(holidayName) };
  }

  renderEveningReview(
    lang: string,
    dateLabel: string,
    events: AgendaEvent[],
    opts?: AgendaWeatherOpts,
  ): RenderedNotification {
    const langKey = lang as Lang;
    const l = t(langKey).notifications;
    return renderAgenda(l, dateLabel, events, {
      emoji: '🌙',
      greeting: l.evening,
      greetingFree: l.eveningFree,
      freeDay: l.freeDayEvening,
      footer: `${l.eventsCount(events.length)} ${l.tomorrow}. ${l.goodNight}`,
      lang: langKey,
      weather: opts?.weather,
      botTip: opts?.botTip,
    });
  }
}
