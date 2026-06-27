import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';

interface ReminderSpeechInput {
  title: string;
  startAt: string;
  timezone: string;
  /** Raw user-typed location (fallback when no venue resolved). */
  location?: string | null;
  /** Resolved venue/organization name from Google Places — preferred for TTS. */
  venueName?: string | null;
  language: string;
}

function stripHtml(text: string): string {
  // Strip tags to a fixpoint: one greedy, non-recursive pass can leave a partial or
  // overlapping `<...>` sequence behind, so repeat until the string stops shrinking.
  let stripped = text;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/<[^>]*>/g, '');
  } while (stripped !== prev);
  return stripped;
}

/**
 * Pick the best-sounding location text for TTS.
 * Prefer venue name ("Кофемания") over raw user text ("кофемания на никитской")
 * over full formatted address (too long for voice).
 */
function pickSpeakableLocation(
  venueName: string | null | undefined,
  location: string | null | undefined,
): string | null {
  if (venueName && venueName.trim().length > 0) return venueName;
  if (location && location.trim().length > 0) return location;
  return null;
}

export function renderReminderForSpeech(input: ReminderSpeechInput): string {
  const { title, startAt, timezone, location, venueName, language } = input;
  const cleanTitle = stripHtml(title);
  const start = new TZDate(startAt, timezone);
  const timeStr = format(start, 'HH:mm');
  const s = t(language as Lang).speech;

  const parts = [s.reminderIntro(cleanTitle, timeStr)];
  const spoken = pickSpeakableLocation(venueName, location);
  if (spoken) parts.push(s.location(stripHtml(spoken)));
  return parts.join(' ');
}

type SpeechEvent = { title: string; startTime: string; duration: string; isAllDay?: boolean };

function formatEventsSpeech(events: SpeechEvent[], lang: Lang): string {
  const s = t(lang).speech;
  return events
    .map((e) => (e.isAllDay ? `${e.title}, ${s.allDay}.` : `${e.startTime} — ${e.title}, ${e.duration}.`))
    .join(' ');
}

export function renderMorningAgendaForSpeech(input: {
  lang: string;
  dateLabel: string;
  events: SpeechEvent[];
}): string {
  const lang = input.lang as Lang;
  const s = t(lang).speech;
  const items = formatEventsSpeech(input.events, lang);
  return `${s.morningIntro(input.dateLabel)} ${items} ${s.morningOutro}`;
}

export function renderEveningReviewForSpeech(input: {
  lang: string;
  dateLabel: string;
  events: SpeechEvent[];
}): string {
  const lang = input.lang as Lang;
  const s = t(lang).speech;
  const items = formatEventsSpeech(input.events, lang);
  return `${s.eveningIntro(input.dateLabel)} ${items} ${s.eveningOutro}`;
}

type DigestEvent = { title: string; startTime: string; isAllDay?: boolean };

function formatDigestDay(dayLabel: string, events: DigestEvent[], lang: Lang): string {
  const s = t(lang).speech;
  if (events.length === 0) return `${dayLabel}: ${s.noEvents}.`;
  const items = events
    .map((e) => (e.isAllDay ? `${e.title}, ${s.allDay}` : `${e.title} ${s.at} ${e.startTime}`))
    .join(', ');
  return `${dayLabel}: ${items}.`;
}

export function renderWeeklyDigestForSpeech(input: {
  lang: string;
  weekRange: string;
  days: Array<{ dayLabel: string; events: DigestEvent[] }>;
}): string {
  const lang = input.lang as Lang;
  const s = t(lang).speech;
  const dayParts = input.days.map((d) => formatDigestDay(d.dayLabel, d.events, lang));
  return `${s.weeklyDigestIntro(input.weekRange)} ${dayParts.join(' ')}`;
}

export function renderBatchReminderForSpeech(input: {
  lang: string;
  items: Array<{ event_title: string; event_start_at: string; timezone: string }>;
}): string {
  const lang = input.lang as Lang;
  const s = t(lang).speech;
  const intro = s.batchIntro(input.items.length);
  const lines = input.items.map((item) => {
    const timeStr = format(new TZDate(item.event_start_at, item.timezone), 'HH:mm');
    return s.eventAt(item.event_title, timeStr);
  });
  return `${intro} ${lines.join(' ')}`;
}
