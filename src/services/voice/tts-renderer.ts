import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { ruPlural } from '../event/formatters.ts';

interface ReminderSpeechInput {
  title: string;
  startAt: string;
  timezone: string;
  location?: string | null;
  language: string;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

export function renderReminderForSpeech(input: ReminderSpeechInput): string {
  const { title, startAt, timezone, location, language } = input;
  const cleanTitle = stripHtml(title);
  const start = new TZDate(startAt, timezone);
  const timeStr = format(start, 'HH:mm');

  if (language === 'ru') {
    const parts = [`Календарное напоминание. ${cleanTitle} в ${timeStr}.`];
    if (location) parts.push(`Место: ${stripHtml(location)}.`);
    return parts.join(' ');
  }

  const parts = [`Calendar reminder. ${cleanTitle} at ${timeStr}.`];
  if (location) parts.push(`Location: ${stripHtml(location)}.`);
  return parts.join(' ');
}

type SpeechEvent = { title: string; startTime: string; duration: string; isAllDay?: boolean };

function formatEventsSpeech(events: SpeechEvent[], lang: string): string {
  const allDay = lang === 'ru' ? 'весь день' : 'all day';
  return events
    .map((e) => (e.isAllDay ? `${e.title}, ${allDay}.` : `${e.startTime} — ${e.title}, ${e.duration}.`))
    .join(' ');
}

export function renderMorningAgendaForSpeech(input: {
  lang: string;
  dateLabel: string;
  events: SpeechEvent[];
}): string {
  const { lang, dateLabel, events } = input;
  const items = formatEventsSpeech(events, lang);
  if (lang === 'ru') return `Доброе утро. Сегодня, ${dateLabel}. ${items} Продуктивного дня!`;
  return `Good morning. Today, ${dateLabel}. ${items} Have a productive day!`;
}

export function renderEveningReviewForSpeech(input: {
  lang: string;
  dateLabel: string;
  events: SpeechEvent[];
}): string {
  const { lang, dateLabel, events } = input;
  const items = formatEventsSpeech(events, lang);
  if (lang === 'ru') return `Добрый вечер. Завтра, ${dateLabel}. ${items} Спокойной ночи!`;
  return `Good evening. Tomorrow, ${dateLabel}. ${items} Good night!`;
}

type DigestEvent = { title: string; startTime: string; isAllDay?: boolean };

function formatDigestDay(dayLabel: string, events: DigestEvent[], lang: string): string {
  const allDay = lang === 'ru' ? 'весь день' : 'all day';
  const noEvents = lang === 'ru' ? 'нет событий' : 'no events';
  const at = lang === 'ru' ? 'в' : 'at';
  if (events.length === 0) return `${dayLabel}: ${noEvents}.`;
  const items = events
    .map((e) => (e.isAllDay ? `${e.title}, ${allDay}` : `${e.title} ${at} ${e.startTime}`))
    .join(', ');
  return `${dayLabel}: ${items}.`;
}

export function renderWeeklyDigestForSpeech(input: {
  lang: string;
  weekRange: string;
  days: Array<{ dayLabel: string; events: DigestEvent[] }>;
}): string {
  const { lang, weekRange, days } = input;
  const dayParts = days.map((d) => formatDigestDay(d.dayLabel, d.events, lang));
  if (lang === 'ru') return `Еженедельный дайджест на неделю ${weekRange}. ${dayParts.join(' ')}`;
  return `Weekly digest for the week of ${weekRange}. ${dayParts.join(' ')}`;
}

export function renderBatchReminderForSpeech(input: {
  lang: string;
  items: Array<{ event_title: string; event_start_at: string; timezone: string }>;
}): string {
  const { lang, items } = input;
  const count = items.length;

  if (lang === 'ru') {
    const countLabel = `${count} ${ruPlural(count, 'событие', 'события', 'событий')}`;
    const intro = `Календарное напоминание. ${countLabel} начинаются скоро:`;
    const lines = items.map((item) => {
      const timeStr = format(new TZDate(item.event_start_at, item.timezone), 'HH:mm');
      return `${item.event_title} в ${timeStr}.`;
    });
    return `${intro} ${lines.join(' ')}`;
  }

  const intro = `Calendar reminder. ${count} ${count === 1 ? 'event' : 'events'} starting soon:`;
  const lines = items.map((item) => {
    const timeStr = format(new TZDate(item.event_start_at, item.timezone), 'HH:mm');
    return `${item.event_title} at ${timeStr}.`;
  });
  return `${intro} ${lines.join(' ')}`;
}
