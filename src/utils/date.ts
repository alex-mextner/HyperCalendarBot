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

  // Bare time: "15:30", "в 19:00", "at 8" → today
  const bareTimeMatch = trimmed.match(/^(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?$/);
  if (bareTimeMatch) {
    const [, h, m] = bareTimeMatch;
    const d = startOfDay(ref);
    const result = addMinutes(d, Number(h) * 60 + Number(m ?? 0));
    return new Date(result.toISOString());
  }

  const todayMatch = trimmed.match(/^(today|сегодня)\s+(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?$/);
  if (todayMatch) {
    const [, , h, m] = todayMatch;
    const d = startOfDay(ref);
    const result = addMinutes(d, Number(h) * 60 + Number(m ?? 0));
    return new Date(result.toISOString());
  }

  const tomorrowMatch = trimmed.match(/^(tomorrow|завтра)(?:\s+(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?)?$/);
  if (tomorrowMatch) {
    const [, , h, m] = tomorrowMatch;
    const d = startOfDay(addDays(ref, 1));
    const result = addMinutes(d, Number(h ?? 0) * 60 + Number(m ?? 0));
    return new Date(result.toISOString());
  }

  // "послезавтра" / "day after tomorrow" — with optional time
  const dayAfterMatch = trimmed.match(
    /^(послезавтра|day after tomorrow)(?:\s+(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?)?$/,
  );
  if (dayAfterMatch) {
    const [, , h, m] = dayAfterMatch;
    const d = startOfDay(addDays(ref, 2));
    const result = addMinutes(d, Number(h ?? 0) * 60 + Number(m ?? 0));
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
    понедельник: 1,
    вторник: 2,
    среда: 3,
    четверг: 4,
    пятница: 5,
    суббота: 6,
    воскресенье: 0,
  };

  const nextDayMatch = trimmed.match(/^(?:next\s+)?([a-zа-яё]+)\s+(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?$/);
  if (nextDayMatch) {
    const [, dayStr, h, m] = nextDayMatch;
    const targetDay = dayNames[dayStr!];
    if (targetDay !== undefined) {
      const currentDay = ref.getDay();
      let daysToAdd = targetDay - currentDay;
      if (daysToAdd <= 0) daysToAdd += 7;
      const d = startOfDay(addDays(ref, daysToAdd));
      const result = addMinutes(d, Number(h) * 60 + Number(m ?? 0));
      return new Date(result.toISOString());
    }
  }

  // Match both "mar 15 19:30" and "15 mar 19:30" (day-first)
  const monthDateMatch =
    trimmed.match(/^([a-zа-яё]+)\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/) ??
    trimmed.match(/^(\d{1,2})\s+([a-zа-яё]+)(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (monthDateMatch) {
    let [, part1, part2, h, m] = monthDateMatch;
    // Swap if day-first format (part1 is digits, part2 is month name)
    if (/^\d+$/.test(part1!) && !/^\d+$/.test(part2!)) {
      [part1, part2] = [part2, part1];
    }
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
      // Full Russian — nominative
      январь: 0,
      февраль: 1,
      март: 2,
      апрель: 3,
      июнь: 5,
      июль: 6,
      август: 7,
      сентябрь: 8,
      октябрь: 9,
      ноябрь: 10,
      декабрь: 11,
      // Full Russian — genitive
      января: 0,
      февраля: 1,
      марта: 2,
      апреля: 3,
      мая: 4,
      июня: 5,
      июля: 6,
      августа: 7,
      сентября: 8,
      октября: 9,
      ноября: 10,
      декабря: 11,
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

export function formatDuration(startUtc: string, endUtc: string, lang: string): string {
  const diffMs = new Date(endUtc).getTime() - new Date(startUtc).getTime();
  const totalMinutes = Math.round(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return lang === 'ru' ? `${minutes}мин` : `${minutes}m`;
  if (minutes === 0) return lang === 'ru' ? `${hours}ч` : `${hours}h`;
  return lang === 'ru' ? `${hours}ч ${minutes}мин` : `${hours}h ${minutes}m`;
}

export function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();

  // Special forms (check before regex)
  if (trimmed === 'полчаса' || trimmed === 'half an hour' || trimmed === 'half hour') return 30;
  if (trimmed === 'полтора часа') return 90;

  // Colon format: "1:30", "0:45", "10:30"
  const colonMatch = trimmed.match(/^(\d+):(\d{2})$/);
  if (colonMatch) {
    const total = Number(colonMatch[1]) * 60 + Number(colonMatch[2]);
    return total > 0 ? total : null;
  }

  // Suffix format with full-word support
  const hourPattern = '(?:hours?|hr|час(?:а|ов)?|[hч])';
  const minPattern = '(?:minutes?|min|минут[аыу]?|мин|[mм])';
  const suffixRegex = new RegExp(`^(?:(\\d+)\\s*${hourPattern})?\\s*(?:(\\d+)\\s*${minPattern})?$`);
  const suffixMatch = trimmed.match(suffixRegex);
  if (suffixMatch && (suffixMatch[1] || suffixMatch[2])) {
    const hours = suffixMatch[1] ? Number(suffixMatch[1]) : 0;
    const mins = suffixMatch[2] ? Number(suffixMatch[2]) : 0;
    return hours * 60 + mins || null;
  }

  // Plain number: treat as minutes
  const plainMatch = trimmed.match(/^(\d+)$/);
  if (plainMatch) {
    const mins = Number(plainMatch[1]);
    return mins > 0 ? mins : null;
  }

  return null;
}

export interface RecurrenceParsed {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
}

export function parseRecurrence(input: string): RecurrenceParsed | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const simple: Record<string, RecurrenceParsed> = {
    daily: { freq: 'DAILY', interval: 1 },
    'every day': { freq: 'DAILY', interval: 1 },
    'каждый день': { freq: 'DAILY', interval: 1 },
    ежедневно: { freq: 'DAILY', interval: 1 },
    weekly: { freq: 'WEEKLY', interval: 1 },
    'every week': { freq: 'WEEKLY', interval: 1 },
    'каждую неделю': { freq: 'WEEKLY', interval: 1 },
    еженедельно: { freq: 'WEEKLY', interval: 1 },
    monthly: { freq: 'MONTHLY', interval: 1 },
    'every month': { freq: 'MONTHLY', interval: 1 },
    'каждый месяц': { freq: 'MONTHLY', interval: 1 },
    ежемесячно: { freq: 'MONTHLY', interval: 1 },
    yearly: { freq: 'YEARLY', interval: 1 },
    'every year': { freq: 'YEARLY', interval: 1 },
    'каждый год': { freq: 'YEARLY', interval: 1 },
    ежегодно: { freq: 'YEARLY', interval: 1 },
    'через неделю': { freq: 'WEEKLY', interval: 2 },
  };

  if (simple[trimmed]) return simple[trimmed];

  // "every N <unit>" pattern
  const everyN = trimmed.match(/^every\s+(\d+)\s+(days?|weeks?|months?|years?)$/);
  if (everyN) {
    const n = Number(everyN[1]);
    const unit = everyN[2]!;
    if (unit.startsWith('day')) return { freq: 'DAILY', interval: n };
    if (unit.startsWith('week')) return { freq: 'WEEKLY', interval: n };
    if (unit.startsWith('month')) return { freq: 'MONTHLY', interval: n };
    if (unit.startsWith('year')) return { freq: 'YEARLY', interval: n };
  }

  // "каждые N <unit>" pattern
  const kazhdyeN = trimmed.match(
    /^кажд(?:ый|ую|ые|ое)\s+(\d+)\s+(дн(?:я|ей|и)|день|недел[юиь]|месяц(?:а|ев)?|год[аов]?)$/,
  );
  if (kazhdyeN) {
    const n = Number(kazhdyeN[1]);
    const unit = kazhdyeN[2]!;
    if (unit.startsWith('дн') || unit === 'день') return { freq: 'DAILY', interval: n };
    if (unit.startsWith('недел')) return { freq: 'WEEKLY', interval: n };
    if (unit.startsWith('месяц')) return { freq: 'MONTHLY', interval: n };
    if (unit.startsWith('год')) return { freq: 'YEARLY', interval: n };
  }

  return null;
}
