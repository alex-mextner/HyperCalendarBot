// src/bot/scenes/add-event-input.ts
// Pure parsing of add-event wizard answers: dates, clock times and recurrence-end values.

import { TZDate } from '@date-fns/tz';
import { addDays, addMinutes, endOfDay } from 'date-fns';
import { handleCalculate } from '../../services/ai/tool-handlers/calculate.ts';
import { parseSimpleDate } from '../../utils/date.ts';

export function applyDefaultDuration(startAt: string, defaultMinutes: number): string {
  return addMinutes(new Date(startAt), defaultMinutes).toISOString();
}

export type WizardDateTimeResult =
  | { kind: 'complete'; startAt: string }
  | { kind: 'needs_time'; localDate: string }
  | { kind: 'ambiguous_number' }
  | { kind: 'invalid' };

function localDateKey(date: Date, timezone: string): string {
  const local = new TZDate(date.getTime(), timezone);
  return [
    local.getFullYear(),
    String(local.getMonth() + 1).padStart(2, '0'),
    String(local.getDate()).padStart(2, '0'),
  ].join('-');
}

function parseClockInput(input: string): { hour: number; minute: number } | null {
  const match = input
    .trim()
    .toLowerCase()
    .match(/^(?:(?:at|в)\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|утра|дня|вечера|ночи)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const period = match[3];
  if (minute > 59 || hour > 23 || (period && (hour < 1 || hour > 12))) return null;
  if (period === 'pm' || period === 'дня' || period === 'вечера') {
    if (hour < 12) hour += 12;
  } else if (period && hour === 12) hour = 0;
  return { hour, minute };
}

function calendarDate(year: number, month: number, day: number, timezone: string): Date | null {
  const date = new TZDate(year, month - 1, day, 12, 0, 0, 0, timezone);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? new Date(date.getTime())
    : null;
}

function parseWizardDate(input: string, timezone: string, refDate = new Date(), bareDay = false): Date | null {
  const ref = new TZDate(refDate.getTime(), timezone);
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^(?:на|в)\s+/, '');
  const relative: { [key: string]: number } = {
    today: 0,
    сегодня: 0,
    tomorrow: 1,
    завтра: 1,
    послезавтра: 2,
    'day after tomorrow': 2,
  };
  const offset = relative[text];
  if (offset !== undefined) return addDays(ref, offset);
  const weekdays: { [key: string]: number } = {
    пн: 1,
    понедельник: 1,
    mon: 1,
    monday: 1,
    вт: 2,
    вторник: 2,
    tue: 2,
    tuesday: 2,
    ср: 3,
    среда: 3,
    среду: 3,
    wed: 3,
    wednesday: 3,
    чт: 4,
    четверг: 4,
    thu: 4,
    thursday: 4,
    пт: 5,
    пятница: 5,
    пятницу: 5,
    fri: 5,
    friday: 5,
    сб: 6,
    суббота: 6,
    субботу: 6,
    sat: 6,
    saturday: 6,
    вс: 0,
    воскресенье: 0,
    sun: 0,
    sunday: 0,
  };
  const weekday = weekdays[text];
  if (weekday !== undefined) return addDays(ref, (weekday - ref.getDay() + 7) % 7 || 7);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), timezone);
  const numeric = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?$/.exec(text);
  if (numeric)
    return calendarDate(Number(numeric[3] ?? ref.getFullYear()), Number(numeric[2]), Number(numeric[1]), timezone);
  if (bareDay && /^\d{1,2}$/.test(text))
    return calendarDate(ref.getFullYear(), ref.getMonth() + 1, Number(text), timezone);
  const withYear = /^(.*[a-zа-яё])\s+(\d{4})$/i.exec(text);
  const monthText = withYear ? withYear[1]! : text;
  if (!/^(?:[a-zа-яё]+\s+\d{1,2}|\d{1,2}\s+[a-zа-яё]+)$/.test(monthText)) return null;
  const monthRef = withYear ? new TZDate(Number(withYear[2]), 0, 1, 12, timezone) : ref;
  return parseSimpleDate(monthText, timezone, monthRef);
}

function completeWizardTime(
  localDate: string,
  clock: { hour: number; minute: number },
  timezone: string,
): WizardDateTimeResult {
  const time = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
  const result = handleCalculate({ expression: `${localDate} ${time} ${timezone} to UTC` });
  return result.success && result.output ? { kind: 'complete', startAt: result.output } : { kind: 'invalid' };
}

export function parseWizardDateTime(
  input: string,
  timezone: string,
  pendingDate?: string,
  refDate = new Date(),
): WizardDateTimeResult {
  const text = input.trim();
  const clock = parseClockInput(text);
  if (pendingDate && clock) return completeWizardTime(pendingDate, clock, timezone);
  if (/^\d{1,2}$/.test(text)) {
    const value = Number(text);
    if (value >= 1 && value <= 23) return { kind: 'ambiguous_number' };
    const date = parseWizardDate(text, timezone, refDate, true);
    return date ? { kind: 'needs_time', localDate: localDateKey(date, timezone) } : { kind: 'invalid' };
  }
  if (clock) return completeWizardTime(localDateKey(refDate, timezone), clock, timezone);
  const combined = /^(.*?)\s+(?:(?:at|в)\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm|утра|дня|вечера|ночи)?)$/i.exec(text);
  if (combined) {
    const day = parseWizardDate(combined[1]!, timezone, refDate, true);
    const time = parseClockInput(combined[2]!);
    if (day && time) return completeWizardTime(localDateKey(day, timezone), time, timezone);
  }
  const date = parseWizardDate(text, timezone, refDate);
  if (date) return { kind: 'needs_time', localDate: localDateKey(date, timezone) };
  return { kind: 'invalid' };
}

export function recurrenceUntilDate(input: string, timezone: string, startAt?: string): Date | null {
  return parseWizardDate(input, timezone, startAt && /\d/.test(input) ? new Date(startAt) : new Date(), true);
}

export function stripRecurrenceEnd(rule: string): string {
  return rule
    .split(';')
    .filter((part) => !part.startsWith('UNTIL=') && !part.startsWith('COUNT='))
    .join(';');
}

export function withRecurrenceEnd(rule: string, suffix: string): string {
  return `${stripRecurrenceEnd(rule)};${suffix}`;
}

export function recurrenceUntilValue(date: Date, timezone: string): string {
  const localEnd = endOfDay(new TZDate(date.getTime(), timezone));
  return new Date(localEnd.getTime())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
