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

export function renderMorningAgendaForSpeech(input: {
  lang: string;
  dateLabel: string;
  events: Array<{ title: string; startTime: string; duration: string; isAllDay?: boolean }>;
}): string {
  const { lang, dateLabel, events } = input;

  if (lang === 'ru') {
    const intro = `Доброе утро. Сегодня, ${dateLabel}.`;
    const items = events
      .map((e) => (e.isAllDay ? `${e.title}, весь день.` : `${e.startTime} — ${e.title}, ${e.duration}.`))
      .join(' ');
    return `${intro} ${items} Продуктивного дня!`;
  }

  const intro = `Good morning. Today, ${dateLabel}.`;
  const items = events
    .map((e) => (e.isAllDay ? `${e.title}, all day.` : `${e.startTime} — ${e.title}, ${e.duration}.`))
    .join(' ');
  return `${intro} ${items} Have a productive day!`;
}

export function renderEveningReviewForSpeech(input: {
  lang: string;
  dateLabel: string;
  events: Array<{ title: string; startTime: string; duration: string; isAllDay?: boolean }>;
}): string {
  const { lang, dateLabel, events } = input;

  if (lang === 'ru') {
    const intro = `Добрый вечер. Завтра, ${dateLabel}.`;
    const items = events
      .map((e) => (e.isAllDay ? `${e.title}, весь день.` : `${e.startTime} — ${e.title}, ${e.duration}.`))
      .join(' ');
    return `${intro} ${items} Спокойной ночи!`;
  }

  const intro = `Good evening. Tomorrow, ${dateLabel}.`;
  const items = events
    .map((e) => (e.isAllDay ? `${e.title}, all day.` : `${e.startTime} — ${e.title}, ${e.duration}.`))
    .join(' ');
  return `${intro} ${items} Good night!`;
}

export function renderWeeklyDigestForSpeech(input: {
  lang: string;
  weekRange: string;
  days: Array<{ dayLabel: string; events: Array<{ title: string; startTime: string; isAllDay?: boolean }> }>;
}): string {
  const { lang, weekRange, days } = input;

  if (lang === 'ru') {
    const intro = `Еженедельный дайджест на неделю ${weekRange}.`;
    const dayParts = days.map((d) => {
      if (d.events.length === 0) return `${d.dayLabel}: нет событий.`;
      const items = d.events
        .map((e) => (e.isAllDay ? `${e.title}, весь день` : `${e.title} в ${e.startTime}`))
        .join(', ');
      return `${d.dayLabel}: ${items}.`;
    });
    return `${intro} ${dayParts.join(' ')}`;
  }

  const intro = `Weekly digest for the week of ${weekRange}.`;
  const dayParts = days.map((d) => {
    if (d.events.length === 0) return `${d.dayLabel}: no events.`;
    const items = d.events.map((e) => (e.isAllDay ? `${e.title}, all day` : `${e.title} at ${e.startTime}`)).join(', ');
    return `${d.dayLabel}: ${items}.`;
  });
  return `${intro} ${dayParts.join(' ')}`;
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
