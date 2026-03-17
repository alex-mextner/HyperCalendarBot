// src/services/event/formatters.ts
import type { CalendarEvent, EventOccurrence } from '../../database/types.ts';
import {
  formatDateHeader,
  formatDateShort,
  formatDuration,
  formatTime,
  formatTimeRange,
  formatTimeWithTimezones,
} from '../../utils/date.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import type { HolidayEntry } from '../holiday/holiday-service.ts';

export function formatDayAgenda(
  occurrences: EventOccurrence[],
  dateIso: string,
  timezone: string,
  lang: string,
  holidays?: HolidayEntry[],
): string {
  const header = `📅 ${formatDateHeader(dateIso, timezone, lang)}`;

  const holidayLines = (holidays ?? []).map((h) => `  🎉 ${escapeHtml(h.name)}`);

  if (occurrences.length === 0 && holidayLines.length === 0) {
    const noEvents = lang === 'ru' ? 'Нет событий. /add для создания.' : 'No events. Use /add to create one.';
    return `${header}\n\n${noEvents}`;
  }

  const eventLines = occurrences.map((occ) => {
    const time = formatTimeRange(occ.occurrence_start, occ.occurrence_end, timezone);
    const title = escapeHtml(occ.event.title);
    const recur = occ.event.recurrence_rule ? ' 🔁' : '';
    return `  ${time}  ${title}${recur}`;
  });

  const allLines = [...holidayLines, ...eventLines];
  return `${header}\n\n${allLines.join('\n')}`;
}

export function formatWeekAgenda(
  occurrences: EventOccurrence[],
  startDateIso: string,
  endDateIso: string,
  timezone: string,
  lang: string,
  holidaysByDate?: Map<string, HolidayEntry[]>,
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
    const dayHolidays = holidaysByDate?.get(dayKey) ?? [];

    if (dayHolidays.length > 0) {
      for (const h of dayHolidays) {
        lines.push(`${dayLabel}  🎉 ${escapeHtml(h.name)}`);
      }
    }

    if (dayEvents.length === 0 && dayHolidays.length === 0) {
      const noEvents = lang === 'ru' ? '— нет событий' : '— no events';
      lines.push(`${dayLabel}  ${noEvents}`);
    } else if (dayEvents.length > 0) {
      lines.push(
        `${dayLabel}  ▪ ${dayEvents.length} ${dayEvents.length === 1 ? (lang === 'ru' ? 'событие' : 'event') : lang === 'ru' ? 'событий' : 'events'}`,
      );
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
    if (event.end_at) {
      const duration = formatDuration(event.start_at, event.end_at, lang);
      lines.push(`🕐 ${time} (${duration})`);
    } else {
      lines.push(`🕐 ${time}`);
    }
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

export function formatInvitation(
  event: CalendarEvent,
  timezone: string,
  lang: string,
  inviterName: string,
  inviterId: number,
  inviterUsername?: string | null,
  recipientTimezone?: string | null,
  recipientOnboarded?: boolean,
): string {
  const inviterLink = inviterUsername
    ? `@${escapeHtml(inviterUsername)}`
    : `<a href="tg://user?id=${inviterId}">${escapeHtml(inviterName)}</a>`;
  const header = lang === 'ru' ? `📨 <b>Приглашение</b> от ${inviterLink}` : `📨 <b>Invitation</b> from ${inviterLink}`;

  if (!event.all_day) {
    const timeLabel = formatTimeWithTimezones(
      event.start_at,
      timezone,
      recipientTimezone ?? null,
      recipientOnboarded ?? false,
    );
    const eventDetail = formatEventDetail(event, timezone, lang);
    // Replace the plain time in the event detail with the timezone-annotated one
    const plainTime = event.end_at
      ? `${formatTime(event.start_at, timezone)}–${formatTime(event.end_at, timezone)}`
      : formatTime(event.start_at, timezone);
    const annotatedDetail = eventDetail.replace(plainTime, timeLabel);
    return `${header}\n\n${annotatedDetail}`;
  }

  return `${header}\n\n${formatEventDetail(event, timezone, lang)}`;
}

export function formatEventListItem(event: CalendarEvent, timezone: string, index: number): string {
  const time = formatTime(event.start_at, timezone);
  return `${index + 1}. ${time} — ${escapeHtml(event.title)}`;
}

export function formatRecurrenceHuman(rrule: string, lang: string): string {
  const parts = new Map(
    rrule.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k!, v!] as [string, string];
    }),
  );

  const freq = parts.get('FREQ');
  const interval = Number(parts.get('INTERVAL') ?? 1);
  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');

  let base: string;

  if (interval > 1) {
    const unitMap: Record<string, Record<string, string>> = {
      DAILY: { en: 'days', ru: ruPlural(interval, 'день', 'дня', 'дней') },
      WEEKLY: { en: 'weeks', ru: ruPlural(interval, 'неделю', 'недели', 'недель') },
      MONTHLY: { en: 'months', ru: ruPlural(interval, 'месяц', 'месяца', 'месяцев') },
      YEARLY: { en: 'years', ru: ruPlural(interval, 'год', 'года', 'лет') },
    };
    const unit = unitMap[freq!]?.[lang] ?? freq;
    base = lang === 'ru' ? `Каждые ${interval} ${unit}` : `Every ${interval} ${unit}`;
  } else {
    const freqMap: Record<string, Record<string, string>> = {
      DAILY: { en: 'Daily', ru: 'Ежедневно' },
      WEEKLY: { en: 'Weekly', ru: 'Еженедельно' },
      MONTHLY: { en: 'Monthly', ru: 'Ежемесячно' },
      YEARLY: { en: 'Yearly', ru: 'Ежегодно' },
    };
    base = freqMap[freq!]?.[lang] ?? rrule;
  }

  if (count) {
    base += lang === 'ru' ? `, ${count} раз` : `, ${count} times`;
  }

  if (until) {
    const untilDate = parseUntilDate(until);
    if (untilDate) {
      const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthsRu = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
      const day = untilDate.getUTCDate();
      const mon = lang === 'ru' ? monthsRu[untilDate.getUTCMonth()]! : monthsEn[untilDate.getUTCMonth()]!;
      base += lang === 'ru' ? ` до ${day} ${mon}` : ` until ${mon} ${day}`;
    }
  }

  return base;
}

function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 19) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function parseUntilDate(until: string): Date | null {
  const match = until.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
}
