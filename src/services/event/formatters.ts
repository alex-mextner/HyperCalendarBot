// src/services/event/formatters.ts
import { TZDate } from '@date-fns/tz';
import type { CalendarEvent, EventOccurrence } from '../../database/types.ts';
import {
  formatDateHeader,
  formatDateShort,
  formatDuration,
  formatTime,
  formatTimeRange,
  formatTimeWithTimezones,
  localCalendarWeekDays,
} from '../../utils/date.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import type { HolidayEntry } from '../holiday/holiday-service.ts';

function birthdayAge(birthYear: number | null | undefined, occurrenceStart: string): number | null {
  if (birthYear == null) return null;
  return new Date(occurrenceStart).getUTCFullYear() - birthYear;
}

export function formatDayAgenda(
  occurrences: EventOccurrence[],
  dateIso: string,
  timezone: string,
  lang: string,
  holidays?: HolidayEntry[],
  calendarColors?: Map<string, string>,
): string {
  const header = `📅 ${formatDateHeader(dateIso, timezone, lang)}`;

  const holidayLines = (holidays ?? []).map((h) => `  🎉 ${escapeHtml(h.name)}`);

  if (occurrences.length === 0 && holidayLines.length === 0) {
    const noEvents = lang === 'ru' ? 'Нет событий. /add для создания.' : 'No events. Use /add to create one.';
    return `${header}\n\n${noEvents}`;
  }

  const eventLines = occurrences.map((occ) => {
    const time = formatTimeRange(occ.occurrence_start, occ.occurrence_end, timezone);
    const isBirthday = occ.event.event_type === 'birthday';
    const isRecurring = !isBirthday && !!(occ.event.recurrence_rule || occ.event.parent_event_id);
    let title = escapeHtml(occ.event.title);
    if (isBirthday) {
      const age = birthdayAge(occ.event.birth_year, occ.occurrence_start);
      const suffix =
        age !== null ? (lang === 'ru' ? ` — ${age} ${ruPlural(age, 'год', 'года', 'лет')}` : ` — turns ${age}`) : '';
      title = `🎁 ${title}${escapeHtml(suffix)}`;
    }
    const colorDot =
      calendarColors && occ.event.google_calendar_id ? (calendarColors.get(occ.event.google_calendar_id) ?? '') : '';
    const dotPrefix = colorDot ? `${colorDot} ` : '';
    return `  ${time}  ${dotPrefix}${title}${isRecurring ? ' 🔁' : ''}`;
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
    const dayKey = new TZDate(new Date(occ.occurrence_start), timezone).toISOString().slice(0, 10);
    const arr = byDay.get(dayKey) ?? [];
    arr.push(occ);
    byDay.set(dayKey, arr);
  }

  const days = localCalendarWeekDays(startDateIso, timezone);
  const lines: string[] = [];

  for (const dayKey of days) {
    const dayLabel = formatDateShort(`${dayKey}T12:00:00Z`, timezone, lang);
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
        `${dayLabel}  ▪ ${dayEvents.length} ${lang === 'ru' ? ruPlural(dayEvents.length, 'событие', 'события', 'событий') : dayEvents.length === 1 ? 'event' : 'events'}`,
      );
      for (const occ of dayEvents) {
        const time = formatTime(occ.occurrence_start, timezone);
        const isBirthday = occ.event.event_type === 'birthday';
        const isRecurring = !isBirthday && !!(occ.event.recurrence_rule || occ.event.parent_event_id);
        let title = escapeHtml(occ.event.title);
        if (isBirthday) {
          const age = birthdayAge(occ.event.birth_year, occ.occurrence_start);
          const suffix =
            age !== null
              ? lang === 'ru'
                ? ` — ${age} ${ruPlural(age, 'год', 'года', 'лет')}`
                : ` — turns ${age}`
              : '';
          title = `🎁 ${title}${escapeHtml(suffix)}`;
        }
        lines.push(`  ${time} ${title}${isRecurring ? ' 🔁' : ''}`);
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
  const isBirthday = event.event_type === 'birthday';

  if (isBirthday) {
    const age = birthdayAge(event.birth_year, event.start_at);
    const ageSuffix =
      age !== null ? (lang === 'ru' ? ` — ${age} ${ruPlural(age, 'год', 'года', 'лет')}` : ` — turns ${age}`) : '';
    lines.push(`🎁 <b>${escapeHtml(event.title)}${escapeHtml(ageSuffix)}</b>`);
  } else {
    lines.push(`📌 <b>${escapeHtml(event.title)}</b>`);
  }

  const dateStr = formatDateShort(event.start_at, timezone, lang);
  if (event.all_day) {
    lines.push(`📅 ${dateStr}, ${lang === 'ru' ? 'весь день' : 'all day'}`);
  } else {
    const time = formatTimeRange(event.start_at, event.end_at, timezone);
    if (event.end_at) {
      const duration = formatDuration(event.start_at, event.end_at, lang);
      lines.push(`🕐 ${dateStr}, ${time} (${duration})`);
    } else {
      lines.push(`🕐 ${dateStr}, ${time}`);
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
  if (event.recurrence_rule && !isBirthday) {
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

export function formatEventListItem(event: CalendarEvent, timezone: string, index: number, lang = 'en'): string {
  const time = formatTime(event.start_at, timezone);
  const isBirthday = event.event_type === 'birthday';
  const isRecurring = !isBirthday && !!(event.recurrence_rule || event.parent_event_id);
  let title = escapeHtml(event.title);
  if (isBirthday) {
    const age = birthdayAge(event.birth_year, event.start_at);
    const suffix =
      age !== null ? (lang === 'ru' ? ` — ${age} ${ruPlural(age, 'год', 'года', 'лет')}` : ` — turns ${age}`) : '';
    title = `🎁 ${title}${escapeHtml(suffix)}`;
  }
  return `${index + 1}. ${time} — ${title}${isRecurring ? ' 🔁' : ''}`;
}

export function formatRecurrenceHuman(rrule: string, lang: string): string {
  // recurrence_rule may contain multiple lines (RRULE + EXDATE/RDATE from Google).
  // Extract only the RRULE line for human formatting; ignore EXDATE/RDATE.
  const ruleLine = rrule.split('\n').find((l) => l.startsWith('RRULE:')) ?? rrule;
  const ruleBody = ruleLine.startsWith('RRULE:') ? ruleLine.slice(6) : ruleLine;
  const parts = new Map(
    ruleBody.split(';').map((p) => {
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

export function ruPlural(n: number, one: string, few: string, many: string): string {
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
