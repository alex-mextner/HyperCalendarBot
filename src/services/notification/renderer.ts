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
  endTime: string;
  location: string | null;
  intervalLabel: string;
}

const LABELS = {
  en: {
    morning: "Good morning! Here's your day:",
    evening: "Tomorrow's schedule:",
    reminder: 'Reminder:',
    inLabel: 'in',
    eventsCount: (n: number) => `${n} event${n === 1 ? '' : 's'}`,
    goodNight: 'Good night!',
    haveADay: 'Have a productive day!',
    eveHoliday: (name: string) => `🎉 Tomorrow is a holiday: ${name}`,
  },
  ru: {
    morning: 'Доброе утро! Ваш день:',
    evening: 'Расписание на завтра:',
    reminder: 'Напоминание:',
    inLabel: 'через',
    eventsCount: (n: number) => {
      if (n === 1) return '1 событие';
      if (n >= 2 && n <= 4) return `${n} события`;
      return `${n} событий`;
    },
    goodNight: 'Спокойной ночи!',
    haveADay: 'Продуктивного дня!',
    eveHoliday: (name: string) => `🎉 Завтра праздник: ${name}`,
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
    const lines: string[] = [];
    lines.push(`⏰ ${l.reminder} ${data.title} ${l.inLabel} ${data.intervalLabel}`);
    lines.push('');
    lines.push(`🕐 ${data.startTime} — ${data.endTime}`);
    if (data.location) {
      lines.push(`📍 ${data.location}`);
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
