import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';
import { renderReminderForSpeech } from '../voice/tts-renderer.ts';
import { formatDayWeatherLine } from '../weather/format.ts';
import type { DayWeather } from '../weather/types.ts';
import { weatherEmoji } from '../weather/weather-service.ts';

export interface VoiceRenderInput {
  title: string;
  startAt: string;
  timezone: string;
  location?: string | null;
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
  duration: string;
  isAllDay?: boolean;
}

export interface ReminderData {
  title: string;
  startTime: string;
  endTime?: string;
  location: string | null;
  intervalLabel: string;
  isAllDay?: boolean;
}

export interface BatchReminderItem {
  title: string;
  startTime: string;
  location: string | null;
  intervalLabel: string;
  isAllDay?: boolean;
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
  const line = e.isAllDay ? `📅 ${e.title} (${l.allDay})` : `${e.startTime} — ${e.title} (${e.duration})`;
  return e.location ? `${line}\n        📍 ${e.location}` : line;
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
      emoji: '☀️',
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
    const l = t(lang as Lang).notifications;
    const localized = localizeInterval(lang, data.intervalLabel);
    const lines: string[] = [];
    if (data.intervalLabel === 'at start') {
      lines.push(`⏰ ${data.title} — ${l.startingNow}`);
    } else if (data.isAllDay) {
      lines.push(`⏰ ${l.reminder} ${data.title} — ${localized}`);
    } else {
      lines.push(`⏰ ${l.reminder} ${data.title} ${l.inLabel} ${localized}`);
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
      lines.push(`📍 ${data.location}`);
    }
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderBatchReminder(lang: string, items: BatchReminderItem[]): RenderedNotification {
    const l = t(lang as Lang).notifications;
    const lines: string[] = [];
    lines.push(`⏰ ${l.reminders}:`);
    lines.push('');
    for (const item of items) {
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
      let line = `• ${item.title} — ${timeInfo} (${intervalText})`;
      if (item.location) line += `\n  📍 ${item.location}`;
      lines.push(line);
    }
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderForVoice(input: VoiceRenderInput): RenderedNotification {
    const text = renderReminderForSpeech({
      title: input.title,
      startAt: input.startAt,
      timezone: input.timezone,
      location: input.location,
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
          .map((e) => (e.isAllDay ? `${l.allDay}: ${e.title}` : `${e.startTime} ${e.title}`))
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
