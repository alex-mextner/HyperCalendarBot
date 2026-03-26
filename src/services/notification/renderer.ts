import { renderReminderForSpeech } from '../voice/tts-renderer.ts';

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
}

export interface ReminderData {
  title: string;
  startTime: string;
  endTime?: string;
  location: string | null;
  intervalLabel: string;
}

export interface BatchReminderItem {
  title: string;
  startTime: string;
  location: string | null;
  intervalLabel: string;
}

export interface WeeklyDigestEvent {
  title: string;
  startTime: string;
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

const LABELS = {
  en: {
    morning: "Good morning! Here's your day:",
    evening: "Tomorrow's schedule:",
    reminder: 'Reminder:',
    reminders: 'Reminders',
    inLabel: 'in',
    startingNow: 'starting now!',
    eventsCount: (n: number) => `${n} event${n === 1 ? '' : 's'}`,
    goodNight: 'Good night!',
    haveADay: 'Have a productive day!',
    eveHoliday: (name: string) => `🎉 Tomorrow is a holiday: ${name}`,
    weeklyDigest: (range: string) => `📅 Week ${range}:`,
    noEvents: 'no events',
  },
  ru: {
    morning: 'Доброе утро! Ваш день:',
    evening: 'Расписание на завтра:',
    reminder: 'Напоминание:',
    reminders: 'Напоминания',
    inLabel: 'через',
    startingNow: 'начинается!',
    eventsCount: (n: number) => {
      if (n === 1) return '1 событие';
      if (n >= 2 && n <= 4) return `${n} события`;
      return `${n} событий`;
    },
    goodNight: 'Спокойной ночи!',
    haveADay: 'Продуктивного дня!',
    eveHoliday: (name: string) => `🎉 Завтра праздник: ${name}`,
    weeklyDigest: (range: string) => `📅 Неделя ${range}:`,
    noEvents: 'нет событий',
  },
};

export class NotificationRenderer {
  renderMorningAgenda(lang: string, dateLabel: string, events: AgendaEvent[]): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const lines: string[] = [];
    lines.push(`☀️ ${l.morning}`);
    lines.push('');
    lines.push(`📅 ${dateLabel}`);
    lines.push('');
    for (const e of events) {
      let line = `${e.startTime} — ${e.title} (${e.duration})`;
      if (e.location) line += `\n        📍 ${e.location}`;
      lines.push(line);
    }
    lines.push('');
    lines.push(l.haveADay);
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderEventReminder(lang: string, data: ReminderData): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const localized = localizeInterval(lang, data.intervalLabel);
    const lines: string[] = [];
    if (data.intervalLabel === 'at start') {
      lines.push(`⏰ ${data.title} — ${l.startingNow}`);
    } else {
      lines.push(`⏰ ${l.reminder} ${data.title} ${l.inLabel} ${localized}`);
    }
    lines.push('');
    if (data.endTime && data.endTime !== data.startTime) {
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
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const lines: string[] = [];
    lines.push(`⏰ ${l.reminders}:`);
    lines.push('');
    for (const item of items) {
      const localized = localizeInterval(lang, item.intervalLabel);
      const intervalText = item.intervalLabel === 'at start' ? l.startingNow : `${l.inLabel} ${localized}`;
      let line = `• ${item.title} — ${item.startTime} (${intervalText})`;
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

  renderWeeklyDigest(lang: string, weekRange: string, days: WeeklyDigestDay[]): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const lines: string[] = [];
    lines.push(l.weeklyDigest(weekRange));
    lines.push('');
    for (const day of days) {
      if (day.events.length === 0) {
        lines.push(`${day.dayLabel}: (${l.noEvents})`);
      } else {
        const eventList = day.events.map((e) => `${e.startTime} ${e.title}`).join(', ');
        lines.push(`${day.dayLabel}: ${eventList}`);
      }
    }
    return { channel: 'telegram_text', text: lines.join('\n') };
  }

  renderEveHoliday(lang: string, holidayName: string): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    return { channel: 'telegram_text', text: l.eveHoliday(holidayName) };
  }

  renderEveningReview(lang: string, dateLabel: string, events: AgendaEvent[]): RenderedNotification {
    const l = lang === 'ru' ? LABELS.ru : LABELS.en;
    const lines: string[] = [];
    lines.push(`🌙 ${l.evening}`);
    lines.push('');
    lines.push(`📅 ${dateLabel}`);
    lines.push('');
    for (const e of events) {
      let line = `${e.startTime} — ${e.title} (${e.duration})`;
      if (e.location) line += `\n        📍 ${e.location}`;
      lines.push(line);
    }
    lines.push('');
    lines.push(`${l.eventsCount(events.length)} tomorrow. ${l.goodNight}`);
    return { channel: 'telegram_text', text: lines.join('\n') };
  }
}
