import { TZDate } from '@date-fns/tz';
import { addDays, addMinutes, endOfDay, endOfWeek, format, startOfDay, startOfWeek } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';

export function toUserTime(isoUtc: string, timezone: string): string {
  const d = new TZDate(isoUtc, timezone);
  return format(d, 'HH:mm');
}

export function formatTime(isoUtc: string, timezone: string): string {
  return toUserTime(isoUtc, timezone);
}

export function formatDateHeader(isoUtc: string, timezone: string, lang: string): string {
  const d = new TZDate(isoUtc, timezone);
  const locale = lang === 'ru' ? ru : enUS;
  return format(d, 'EEEE, MMMM d', { locale });
}

export function formatDateShort(isoUtc: string, timezone: string, lang: string): string {
  const d = new TZDate(isoUtc, timezone);
  const locale = lang === 'ru' ? ru : enUS;
  return format(d, 'EEE d', { locale });
}

export function formatTimeRange(startUtc: string, endUtc: string | null, timezone: string): string {
  const start = toUserTime(startUtc, timezone);
  if (!endUtc) return start;
  return `${start}–${toUserTime(endUtc, timezone)}`;
}

export function getDayRangeUtc(date: Date, timezone: string): { start: string; end: string } {
  const localDate = new TZDate(date.getTime(), timezone);
  const start = startOfDay(localDate);
  const end = endOfDay(localDate);
  return { start: new Date(start.getTime()).toISOString(), end: new Date(end.getTime()).toISOString() };
}

export function getWeekRangeUtc(date: Date, timezone: string): { start: string; end: string } {
  const localDate = new TZDate(date.getTime(), timezone);
  const start = startOfWeek(localDate, { weekStartsOn: 1 });
  const end = endOfWeek(localDate, { weekStartsOn: 1 });
  return {
    start: new Date(startOfDay(start).getTime()).toISOString(),
    end: new Date(endOfDay(end).getTime()).toISOString(),
  };
}

export function getNDayRangeUtc(date: Date, days: number, timezone: string): { start: string; end: string } {
  const localDate = new TZDate(date.getTime(), timezone);
  const start = startOfDay(localDate);
  const end = endOfDay(addDays(localDate, days - 1));
  return { start: new Date(start.getTime()).toISOString(), end: new Date(end.getTime()).toISOString() };
}

export function parseSimpleDate(input: string, timezone: string, refDate?: Date): Date | null {
  const ref = refDate ? new TZDate(refDate.getTime(), timezone) : TZDate.tz(timezone);
  const trimmed = input.trim().toLowerCase();

  const todayMatch = trimmed.match(/^(today|сегодня)\s+(\d{1,2}):(\d{2})$/);
  if (todayMatch) {
    const [, , h, m] = todayMatch;
    const d = startOfDay(ref);
    const result = addMinutes(d, Number(h) * 60 + Number(m));
    return new Date(result.toISOString());
  }

  const tomorrowMatch = trimmed.match(/^(tomorrow|завтра)\s+(\d{1,2}):(\d{2})$/);
  if (tomorrowMatch) {
    const [, , h, m] = tomorrowMatch;
    const d = startOfDay(addDays(ref, 1));
    const result = addMinutes(d, Number(h) * 60 + Number(m));
    return new Date(result.toISOString());
  }

  const dayNames: Record<string, number> = {
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
    sun: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
    sunday: 0,
    пн: 1,
    вт: 2,
    ср: 3,
    чт: 4,
    пт: 5,
    сб: 6,
    вс: 0,
  };

  const nextDayMatch = trimmed.match(/^(?:next\s+)?(\w+)\s+(\d{1,2}):(\d{2})$/);
  if (nextDayMatch) {
    const [, dayStr, h, m] = nextDayMatch;
    const targetDay = dayNames[dayStr!];
    if (targetDay !== undefined) {
      const currentDay = ref.getDay();
      let daysToAdd = targetDay - currentDay;
      if (daysToAdd <= 0) daysToAdd += 7;
      const d = startOfDay(addDays(ref, daysToAdd));
      const result = addMinutes(d, Number(h) * 60 + Number(m));
      return new Date(result.toISOString());
    }
  }

  const monthDateMatch = trimmed.match(/^(\w+)\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (monthDateMatch) {
    const [, part1, part2, h, m] = monthDateMatch;
    const months: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
      january: 0,
      february: 1,
      march: 2,
      april: 3,
      june: 5,
      july: 6,
      august: 7,
      september: 8,
      october: 9,
      november: 10,
      december: 11,
      янв: 0,
      фев: 1,
      мар: 2,
      апр: 3,
      май: 4,
      июн: 5,
      июл: 6,
      авг: 7,
      сен: 8,
      окт: 9,
      ноя: 10,
      дек: 11,
    };
    const monthNum = months[part1!];
    if (monthNum !== undefined) {
      const year = ref.getFullYear();
      const day = Number(part2);
      const hour = h ? Number(h) : 0;
      const min = m ? Number(m) : 0;
      const d = new TZDate(year, monthNum, day, hour, min, 0, 0, timezone);
      return new Date(d.toISOString());
    }
  }

  return null;
}

export function parseDuration(input: string): number | null {
  const match = input
    .trim()
    .toLowerCase()
    .match(/^(?:(\d+)\s*[hч])?\s*(?:(\d+)\s*[mм])?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const mins = match[2] ? Number(match[2]) : 0;
  return hours * 60 + mins;
}
