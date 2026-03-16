import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

interface ReminderSpeechInput {
  title: string;
  startAt: string;
  timezone: string;
  location?: string | null;
  description?: string | null;
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
