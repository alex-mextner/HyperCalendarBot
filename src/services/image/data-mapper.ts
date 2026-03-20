import { TZDate } from '@date-fns/tz';
import { addDays } from 'date-fns';
import type { EventOccurrence } from '../../database/types.ts';
import { formatDuration, formatTime } from '../../worker/templates/helpers.ts';
import { getLabels } from '../../worker/templates/labels.ts';
import type {
  AgendaEvent,
  DailyAgendaData,
  EventCardData,
  MiniEvent,
  MonthDay,
  MonthlyCalendarData,
  Theme,
  WeeklyOverviewData,
} from '../../worker/templates/types.ts';

const BIRTHDAY_COLOR = '#EC4899';

function toMinutes(isoUtc: string, timezone: string): number {
  const d = new TZDate(new Date(isoUtc), timezone);
  return d.getHours() * 60 + d.getMinutes();
}

function formatDateLocale(dateIso: string, locale: string): string {
  const labels = getLabels(locale);
  const d = new Date(`${dateIso}T12:00:00Z`);
  const month = labels.monthNames[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  return locale === 'ru' ? `${day} ${month} ${year}` : `${month} ${day}, ${year}`;
}

function getDayOfWeek(dateIso: string, locale: string): string {
  const labels = getLabels(locale);
  const d = new Date(`${dateIso}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun
  const idx = dow === 0 ? 6 : dow - 1; // Monday-based
  return labels.weekDaysFull[idx]!;
}

function mapToAgendaEvent(occ: EventOccurrence, tz: string, colorIdx: number, colors: string[]): AgendaEvent {
  const ev = occ.event;
  const isBirthday = ev.event_type === 'birthday';
  return {
    id: ev.id,
    title: isBirthday ? `🎁 ${ev.title}` : ev.title,
    startMinutes: toMinutes(occ.occurrence_start, tz),
    endMinutes: occ.occurrence_end ? toMinutes(occ.occurrence_end, tz) : toMinutes(occ.occurrence_start, tz) + 60,
    location: ev.location ?? undefined,
    calendarColor: isBirthday ? BIRTHDAY_COLOR : colors[colorIdx % colors.length]!,
    isAllDay: ev.all_day === 1,
  };
}

export function mapDailyAgendaData(params: {
  occurrences: EventOccurrence[];
  dateIso: string;
  timezone: string;
  locale: 'ru' | 'en';
  theme: Theme;
  currentTimeMinutes?: number;
  isHoliday?: boolean;
  holidayName?: string;
}): DailyAgendaData {
  const { occurrences, dateIso, timezone, locale, theme } = params;
  const allDay = occurrences.filter((o) => o.event.all_day === 1);
  const timed = occurrences.filter((o) => o.event.all_day !== 1);

  return {
    date: dateIso,
    dayOfWeek: getDayOfWeek(dateIso, locale),
    dateFormatted: formatDateLocale(dateIso, locale),
    relativeDay: params.currentTimeMinutes !== undefined ? getLabels(locale).today : undefined,
    eventCount: occurrences.length,
    currentTimeMinutes: params.currentTimeMinutes,
    isHoliday: params.isHoliday,
    holidayName: params.holidayName,
    allDayEvents: allDay.map((o, i) => mapToAgendaEvent(o, timezone, i, theme.eventColors)),
    timedEvents: timed.map((o, i) => mapToAgendaEvent(o, timezone, allDay.length + i, theme.eventColors)),
    theme,
    locale,
  };
}

function formatWeekLabel(start: Date, end: Date, locale: string): string {
  const labels = getLabels(locale);
  const sm = labels.monthNames[start.getUTCMonth()];
  const sd = start.getUTCDate();
  const ed = end.getUTCDate();
  const y = start.getUTCFullYear();
  if (start.getUTCMonth() === end.getUTCMonth()) {
    return locale === 'ru' ? `${sd}–${ed} ${sm} ${y}` : `${sm} ${sd}–${ed}, ${y}`;
  }
  const em = labels.monthNames[end.getUTCMonth()];
  return locale === 'ru' ? `${sd} ${sm} – ${ed} ${em} ${y}` : `${sm} ${sd} – ${em} ${ed}, ${y}`;
}

export function mapWeeklyOverviewData(params: {
  occurrencesByDay: Map<string, EventOccurrence[]>;
  weekStartIso: string;
  timezone: string;
  locale: 'ru' | 'en';
  theme: Theme;
  todayIso?: string;
}): WeeklyOverviewData {
  const { weekStartIso, timezone, locale, theme, occurrencesByDay } = params;
  const labels = getLabels(locale);
  const start = new Date(`${weekStartIso}T12:00:00Z`);

  const days = Array.from({ length: 7 }, (_, i) => {
    const dayDate = addDays(start, i);
    const iso = dayDate.toISOString().slice(0, 10);
    const occs = occurrencesByDay.get(iso) ?? [];
    return {
      dayNumber: dayDate.getUTCDate(),
      dayName: labels.weekDaysShort[i]!,
      eventCount: occs.length,
      isWeekend: i >= 5,
      events: occs.map(
        (o): MiniEvent => ({
          title: o.event.event_type === 'birthday' ? `🎁 ${o.event.title}` : o.event.title,
          startMinutes: o.event.all_day === 1 ? 0 : toMinutes(o.occurrence_start, timezone),
          endMinutes:
            o.event.all_day === 1
              ? 1440
              : o.occurrence_end
                ? toMinutes(o.occurrence_end, timezone)
                : toMinutes(o.occurrence_start, timezone) + 60,
          color:
            o.event.event_type === 'birthday'
              ? BIRTHDAY_COLOR
              : theme.eventColors[occs.indexOf(o) % theme.eventColors.length]!,
          isAllDay: o.event.all_day === 1,
        }),
      ),
    };
  });

  const todayIndex = params.todayIso
    ? days.findIndex((_, i) => addDays(start, i).toISOString().slice(0, 10) === params.todayIso)
    : undefined;

  return {
    weekLabel: formatWeekLabel(start, addDays(start, 6), locale),
    days,
    todayIndex: todayIndex !== undefined && todayIndex >= 0 ? todayIndex : undefined,
    theme,
    locale,
  };
}

export function mapEventCardData(params: {
  occurrence: EventOccurrence;
  timezone: string;
  locale: 'ru' | 'en';
  theme: Theme;
}): EventCardData {
  const { occurrence, timezone, locale, theme } = params;
  const ev = occurrence.event;
  const startMin = toMinutes(occurrence.occurrence_start, timezone);
  const endMin = occurrence.occurrence_end ? toMinutes(occurrence.occurrence_end, timezone) : startMin + 60;

  const d = new TZDate(new Date(occurrence.occurrence_start), timezone);
  const dateIso = d.toISOString().slice(0, 10);
  const dateStr = formatDateLocale(dateIso, locale);
  const dayOfWeek = getDayOfWeek(dateIso, locale);

  return {
    title: ev.title,
    dateFormatted: `${dayOfWeek}, ${dateStr}`,
    timeFormatted: ev.all_day === 1 ? '' : `${formatTime(startMin)} – ${formatTime(endMin)}`,
    duration: ev.all_day === 1 ? '' : formatDuration(endMin - startMin),
    location: ev.location ?? undefined,
    description: ev.description?.slice(0, 200) ?? undefined,
    calendarName: 'HyperCalendar',
    calendarColor: theme.eventColors[0]!,
    isAllDay: ev.all_day === 1,
    theme,
    locale,
  };
}

export function mapMonthlyCalendarData(params: {
  occurrencesByDay: Map<string, EventOccurrence[]>;
  year: number;
  month: number; // 0-based
  timezone: string;
  locale: 'ru' | 'en';
  theme: Theme;
  todayIso?: string;
}): MonthlyCalendarData {
  const { year, month, locale, theme } = params;
  const labels = getLabels(locale);

  const monthLabel = `${labels.monthNamesNom[month]} ${year}`;

  // First day of month (Monday-based: 0=Mon..6=Sun)
  const firstDate = new Date(Date.UTC(year, month, 1));
  const firstDow = (firstDate.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const prevMonthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const allDays: MonthDay[] = [];

  // Previous month padding
  for (let i = firstDow - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const iso = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dow = allDays.length % 7;
    allDays.push(makeDay(d, true, dow >= 5, iso, params));
  }

  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dow = allDays.length % 7;
    allDays.push(makeDay(d, false, dow >= 5, iso, params));
  }

  // Next month padding (fill to complete last week)
  let nextD = 1;
  while (allDays.length % 7 !== 0) {
    const nextMonth = month === 11 ? 0 : month + 1;
    const nextYear = month === 11 ? year + 1 : year;
    const iso = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(nextD).padStart(2, '0')}`;
    const dow = allDays.length % 7;
    allDays.push(makeDay(nextD, true, dow >= 5, iso, params));
    nextD++;
  }

  // Split into weeks
  const weeks: MonthDay[][] = [];
  for (let i = 0; i < allDays.length; i += 7) {
    weeks.push(allDays.slice(i, i + 7));
  }

  return {
    monthLabel,
    weekDays: labels.weekDaysShort,
    weeks,
    theme,
    locale,
  };
}

function makeDay(
  dayNumber: number,
  isOtherMonth: boolean,
  isWeekend: boolean,
  iso: string,
  params: {
    occurrencesByDay: Map<string, EventOccurrence[]>;
    timezone: string;
    theme: Theme;
    todayIso?: string;
  },
): MonthDay {
  const occs = params.occurrencesByDay.get(iso) ?? [];
  return {
    dayNumber,
    isOtherMonth,
    isWeekend,
    isToday: iso === params.todayIso,
    eventCount: occs.length,
    events: occs.map(
      (o, i): MiniEvent => ({
        title: o.event.event_type === 'birthday' ? `🎁 ${o.event.title}` : o.event.title,
        startMinutes: o.event.all_day === 1 ? 0 : toMinutes(o.occurrence_start, params.timezone),
        endMinutes:
          o.event.all_day === 1
            ? 1440
            : o.occurrence_end
              ? toMinutes(o.occurrence_end, params.timezone)
              : toMinutes(o.occurrence_start, params.timezone) + 60,
        color:
          o.event.event_type === 'birthday'
            ? BIRTHDAY_COLOR
            : params.theme.eventColors[i % params.theme.eventColors.length]!,
        isAllDay: o.event.all_day === 1,
      }),
    ),
  };
}
