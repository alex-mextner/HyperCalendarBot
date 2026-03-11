// src/services/event/formatters.ts
import type { CalendarEvent, EventOccurrence } from '../../database/types.ts';
import { formatTime, formatTimeRange, formatDateHeader, formatDateShort } from '../../utils/date.ts';
import { escapeHtml } from '../../utils/telegram.ts';

export function formatDayAgenda(
  occurrences: EventOccurrence[],
  dateIso: string,
  timezone: string,
  lang: string,
): string {
  const header = `📅 ${formatDateHeader(dateIso, timezone, lang)}`;

  if (occurrences.length === 0) {
    const noEvents = lang === 'ru' ? 'Нет событий. /add для создания.' : 'No events. Use /add to create one.';
    return `${header}\n\n${noEvents}`;
  }

  const lines = occurrences.map(occ => {
    const time = formatTimeRange(occ.occurrence_start, occ.occurrence_end, timezone);
    const title = escapeHtml(occ.event.title);
    const recur = occ.event.recurrence_rule ? ' 🔁' : '';
    return `  ${time}  ${title}${recur}`;
  });

  return `${header}\n\n${lines.join('\n')}`;
}

export function formatWeekAgenda(
  occurrences: EventOccurrence[],
  startDateIso: string,
  endDateIso: string,
  timezone: string,
  lang: string,
): string {
  const byDay = new Map<string, EventOccurrence[]>();
  for (const occ of occurrences) {
    const dayKey = occ.occurrence_start.slice(0, 10);
    const arr = byDay.get(dayKey) ?? [];
    arr.push(occ);
    byDay.set(dayKey, arr);
  }

  const start = new Date(startDateIso);
  const lines: string[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const dayKey = d.toISOString().slice(0, 10);
    const dayLabel = formatDateShort(d.toISOString(), timezone, lang);
    const dayEvents = byDay.get(dayKey) ?? [];

    if (dayEvents.length === 0) {
      const noEvents = lang === 'ru' ? '— нет событий' : '— no events';
      lines.push(`${dayLabel}  ${noEvents}`);
    } else {
      lines.push(`${dayLabel}  ▪ ${dayEvents.length} ${dayEvents.length === 1 ? (lang === 'ru' ? 'событие' : 'event') : (lang === 'ru' ? 'событий' : 'events')}`);
      for (const occ of dayEvents) {
        const time = formatTime(occ.occurrence_start, timezone);
        lines.push(`  ${time} ${escapeHtml(occ.event.title)}`);
      }
    }
    lines.push('');
  }

  const headerStart = formatDateShort(startDateIso, timezone, lang);
  const headerEnd = formatDateShort(endDateIso, timezone, lang);
  return `📅 ${lang === 'ru' ? 'Неделя' : 'Week'} ${headerStart}–${headerEnd}\n\n${lines.join('\n').trim()}`;
}

export function formatEventDetail(event: CalendarEvent, timezone: string, lang: string): string {
  const lines: string[] = [];
  lines.push(`📌 <b>${escapeHtml(event.title)}</b>`);

  if (event.all_day) {
    lines.push(`📅 ${lang === 'ru' ? 'Весь день' : 'All day'}`);
  } else {
    const time = formatTimeRange(event.start_at, event.end_at, timezone);
    lines.push(`🕐 ${time}`);
  }

  if (event.description) {
    lines.push(`📝 ${escapeHtml(event.description)}`);
  }
  if (event.location) {
    lines.push(`📍 ${escapeHtml(event.location)}`);
  }
  if (event.category) {
    lines.push(`🏷 ${escapeHtml(event.category)}`);
  }
  if (event.recurrence_rule) {
    lines.push(`🔁 ${formatRecurrenceHuman(event.recurrence_rule, lang)}`);
  }

  return lines.join('\n');
}

export function formatEventListItem(event: CalendarEvent, timezone: string, index: number): string {
  const time = formatTime(event.start_at, timezone);
  return `${index + 1}. ${time} — ${escapeHtml(event.title)}`;
}

function formatRecurrenceHuman(rrule: string, lang: string): string {
  if (rrule.includes('FREQ=DAILY')) return lang === 'ru' ? 'Ежедневно' : 'Daily';
  if (rrule.includes('FREQ=WEEKLY')) return lang === 'ru' ? 'Еженедельно' : 'Weekly';
  if (rrule.includes('FREQ=MONTHLY')) return lang === 'ru' ? 'Ежемесячно' : 'Monthly';
  if (rrule.includes('FREQ=YEARLY')) return lang === 'ru' ? 'Ежегодно' : 'Yearly';
  return rrule;
}
