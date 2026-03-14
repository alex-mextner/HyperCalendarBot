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
  Theme,
  WeeklyOverviewData,
} from '../../worker/templates/types.ts';

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
  return labels.weekDaysFull[idx];
}

function mapToAgendaEvent(occ: EventOccurrence, tz: string, colorIdx: number, colors: string[]): AgendaEvent {
  const ev = occ.event;
  return {
    id: ev.id,
    title: ev.title,
    startMinutes: toMinutes(occ.occurrence_start, tz),
    endMinutes: occ.occurrence_end ? toMinutes(occ.occurrence_end, tz) : toMinutes(occ.occurrence_start, tz) + 60,
    location: ev.location ?? undefined,
    calendarColor: colors[colorIdx % colors.length],
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
      dayName: labels.weekDaysShort[i],
      eventCount: occs.length,
      isWeekend: i >= 5,
      events: occs.map(
        (o): MiniEvent => ({
          startMinutes: o.event.all_day === 1 ? 0 : toMinutes(o.occurrence_start, timezone),
          endMinutes:
            o.event.all_day === 1
              ? 1440
              : o.occurrence_end
                ? toMinutes(o.occurrence_end, timezone)
                : toMinutes(o.occurrence_start, timezone) + 60,
          color: theme.eventColors[occs.indexOf(o) % theme.eventColors.length],
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
    calendarColor: theme.eventColors[0],
    isAllDay: ev.all_day === 1,
    theme,
    locale,
  };
}
