import { TZDate } from '@date-fns/tz';
import { addMonths, addYears, subMonths, subYears } from 'date-fns';
import type { ToolHandlerMeta, ToolResult } from '../types.ts';

const ISO_DT_RE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})';
const DATETIME_LIKE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/;
const DURATION_UNITS = 'min|minutes?|h|hr|hours?|d|days?|w|weeks?|mo|months?|y|years?';
const IANA_LOCAL_TO_UTC_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s+([A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)\s+to\s+UTC$/i;
const FIXED_LOCAL_TO_UTC_RE =
  /^(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s+UTC([+-])(\d{1,2})(?::?(\d{2}))?\s+to\s+UTC$/i;
const DATETIME_SYNTAX_HINT =
  'Datetime arithmetic requires ISO 8601 with T and an explicit Z/offset, e.g. "2026-09-17T10:49:00+02:00 + 2hours". Local-to-UTC conversion accepts a dated IANA zone, e.g. "2026-09-23 12:30 Europe/Belgrade to UTC", or an explicit fixed UTC offset. For arithmetic forms, do not append "to UTC".';

function evalArithmetic(expr: string): number {
  let pos = 0;

  function skipWs(): void {
    while (pos < expr.length && expr[pos] === ' ') pos++;
  }

  function parseNumber(): number {
    skipWs();
    const start = pos;
    if (expr[pos] === '-') pos++;
    while (pos < expr.length && /[\d.]/.test(expr[pos]!)) pos++;
    const n = Number(expr.slice(start, pos));
    if (Number.isNaN(n)) throw new Error(`Invalid number at position ${start}`);
    return n;
  }

  function parseFactor(): number {
    skipWs();
    if (expr[pos] === '(') {
      pos++;
      const val = parseAddSub();
      skipWs();
      if (expr[pos] !== ')') throw new Error('Expected )');
      pos++;
      return val;
    }
    return parseNumber();
  }

  function parseMulDiv(): number {
    let left = parseFactor();
    while (true) {
      skipWs();
      const op = expr[pos];
      if (op !== '*' && op !== '/') break;
      pos++;
      const right = parseFactor();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  function parseAddSub(): number {
    let left = parseMulDiv();
    while (true) {
      skipWs();
      const op = expr[pos];
      if (op !== '+' && op !== '-') break;
      pos++;
      const right = parseMulDiv();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  const result = parseAddSub();
  skipWs();
  if (pos !== expr.length) throw new Error(`Unexpected character at position ${pos}: ${expr[pos]}`);
  return result;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function sameWallClock(
  date: TZDate,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getSeconds() === second
  );
}

function localTimeIsAmbiguous(
  instant: number,
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  for (let deltaMinutes = -180; deltaMinutes <= 180; deltaMinutes += 15) {
    if (deltaMinutes === 0) continue;
    const candidate = new TZDate(instant + deltaMinutes * 60_000, timezone);
    if (sameWallClock(candidate, year, month, day, hour, minute, second)) return true;
  }
  return false;
}

function formatDiffMs(absMs: number): string {
  const totalMin = Math.round(absMs / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (h < 24) return min === 0 ? `${h}h` : `${h}h ${min}min`;
  const days = Math.floor(h / 24);
  const remH = h % 24;
  const dayLabel = days === 1 ? 'day' : 'days';
  return remH === 0 ? `${days} ${dayLabel}` : `${days} ${dayLabel} ${remH}h`;
}

export function handleCalculate(input: { expression: string }): ToolResult {
  const expr = input.expression.trim();

  // Local wall clock + IANA timezone → UTC. TZDate resolves the offset for
  // the requested calendar date, so future DST changes never reuse today's offset.
  const ianaMatch = expr.match(IANA_LOCAL_TO_UTC_RE);
  if (ianaMatch) {
    const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, timezone] = ianaMatch;
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const second = Number(secondRaw ?? '0');
    if (!validCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59)
      return { success: false, error: `Invalid local datetime: ${expr}` };
    try {
      const local = TZDate.tz(timezone!, year, month - 1, day, hour, minute, second, 0);
      if (!sameWallClock(local, year, month, day, hour, minute, second))
        return { success: false, error: `Local time does not exist in ${timezone} because of a clock change.` };
      if (localTimeIsAmbiguous(local.getTime(), timezone!, year, month, day, hour, minute, second))
        return { success: false, error: `Local time is ambiguous in ${timezone} because of a clock change; specify an explicit UTC offset.` };
      return { success: true, output: new Date(local.getTime()).toISOString() };
    } catch {
      return { success: false, error: `Invalid timezone: ${timezone}` };
    }
  }

  // Fixed offsets are deterministic and retained for explicit user input and
  // backward compatibility with the old prompt.
  const fixedMatch = expr.match(FIXED_LOCAL_TO_UTC_RE);
  if (fixedMatch) {
    const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, signRaw, offsetHourRaw, offsetMinuteRaw] =
      fixedMatch;
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const second = Number(secondRaw ?? '0');
    const offsetHours = Number(offsetHourRaw);
    const offsetMinutesPart = Number(offsetMinuteRaw ?? '0');
    if (
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHours > 14 ||
      (offsetHours === 14 && offsetMinutesPart !== 0) ||
      (offsetMinuteRaw !== undefined && offsetMinutesPart > 59)
    )
      return { success: false, error: `Invalid fixed-offset datetime: ${expr}` };
    const offsetMinutes = (signRaw === '+' ? 1 : -1) * (offsetHours * 60 + offsetMinutesPart);
    if (!yearRaw) {
      const utcMinutes = ((hour * 60 + minute - offsetMinutes) % 1440 + 1440) % 1440;
      const hhmm = `${Math.floor(utcMinutes / 60).toString().padStart(2, '0')}:${(utcMinutes % 60).toString().padStart(2, '0')}`;
      return { success: true, output: secondRaw === undefined ? hhmm : `${hhmm}:${String(second).padStart(2, '0')}` };
    }
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (!validCalendarDate(year, month, day)) return { success: false, error: `Invalid date: ${expr}` };
    const offset = `${signRaw}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutesPart).padStart(2, '0')}`;
    const parsed = new Date(
      `${yearRaw}-${monthRaw}-${dayRaw}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${offset}`,
    );
    if (Number.isNaN(parsed.getTime())) return { success: false, error: `Cannot parse datetime: ${expr}` };
    return { success: true, output: parsed.toISOString() };
  }

  // ISO datetime difference: "2026-03-21T18:00:00Z - 2026-03-21T17:00:00Z"
  const isoDatetimeDiffMatch = expr.match(new RegExp(`^(${ISO_DT_RE})\\s*-\\s*(${ISO_DT_RE})$`));
  if (isoDatetimeDiffMatch) {
    const [, aStr, bStr] = isoDatetimeDiffMatch;
    const a = new Date(aStr!);
    const b = new Date(bStr!);
    if (Number.isNaN(a.getTime())) return { success: false, error: `Cannot parse datetime: ${aStr}` };
    if (Number.isNaN(b.getTime())) return { success: false, error: `Cannot parse datetime: ${bStr}` };
    return { success: true, output: formatDiffMs(Math.abs(a.getTime() - b.getTime())) };
  }

  // Date-only difference: "2026-04-10 - 2026-03-21"
  const dateOnlyDiffMatch = expr.match(/^(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})$/);
  if (dateOnlyDiffMatch) {
    const [, aStr, bStr] = dateOnlyDiffMatch;
    const a = new Date(`${aStr}T12:00:00Z`);
    const b = new Date(`${bStr}T12:00:00Z`);
    if (Number.isNaN(a.getTime())) return { success: false, error: `Cannot parse date: ${aStr}` };
    if (Number.isNaN(b.getTime())) return { success: false, error: `Cannot parse date: ${bStr}` };
    const days = Math.round(Math.abs(a.getTime() - b.getTime()) / 86_400_000);
    return { success: true, output: `${days} days` };
  }

  // ISO datetime ± duration: "2026-03-18T22:34:00Z + 31min", "+ 1month", "+ 2weeks"
  const isoDatetimeMatch = expr.match(
    new RegExp(`^(${ISO_DT_RE})\\s*([+-])\\s*(\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNITS})\\s*$`, 'i'),
  );
  if (isoDatetimeMatch) {
    const [, dateStr, op, amtStr, unit] = isoDatetimeMatch;
    const date = new Date(dateStr!);
    if (Number.isNaN(date.getTime())) return { success: false, error: `Cannot parse datetime: ${dateStr}` };
    const amt = parseFloat(amtStr!);
    const unitL = unit!.toLowerCase();
    if (unitL.startsWith('mo') || unitL.startsWith('month')) {
      const n = Math.trunc(amt);
      const result = op === '+' ? addMonths(date, n) : subMonths(date, n);
      return { success: true, output: result.toISOString() };
    }
    if (unitL === 'y' || unitL.startsWith('year')) {
      const n = Math.trunc(amt);
      const result = op === '+' ? addYears(date, n) : subYears(date, n);
      return { success: true, output: result.toISOString() };
    }
    const sign = op === '+' ? 1 : -1;
    let deltaMs: number;
    if (unitL.startsWith('min')) deltaMs = amt * 60_000;
    else if (unitL === 'h' || unitL.startsWith('hr') || unitL.startsWith('hour')) deltaMs = amt * 3_600_000;
    else if (unitL === 'w' || unitL.startsWith('week')) deltaMs = amt * 7 * 86_400_000;
    else deltaMs = amt * 86_400_000;
    return { success: true, output: new Date(date.getTime() + sign * deltaMs).toISOString() };
  }

  // Date-only ± duration: "2026-03-18 + 7days", "+ 2weeks", "+ 1month"
  const dateOnlyMatch = expr.match(
    new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\s*([+-])\\s*(\\d+)\\s*(${DURATION_UNITS})\\b`, 'i'),
  );
  if (dateOnlyMatch) {
    const [, dateStr, op, amtStr, unit] = dateOnlyMatch;
    const date = new Date(`${dateStr}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return { success: false, error: `Cannot parse date: ${dateStr}` };
    const amt = Number.parseInt(amtStr!, 10);
    const unitL = unit!.toLowerCase();
    if (unitL.startsWith('mo') || unitL.startsWith('month')) {
      const result = op === '+' ? addMonths(date, amt) : subMonths(date, amt);
      return { success: true, output: result.toISOString().slice(0, 10) };
    }
    if (unitL === 'y' || unitL.startsWith('year')) {
      const result = op === '+' ? addYears(date, amt) : subYears(date, amt);
      return { success: true, output: result.toISOString().slice(0, 10) };
    }
    const sign = op === '+' ? 1 : -1;
    const weeks = unitL === 'w' || unitL.startsWith('week') ? 7 : 1;
    const result = new Date(date.getTime() + sign * amt * weeks * 86_400_000);
    return { success: true, output: result.toISOString().slice(0, 10) };
  }

  // HH:MM ± duration: "22:34 + 31min"
  const timeMatch = expr.match(/^(\d{1,2}):(\d{2})\s*([+-])\s*(\d+(?:\.\d+)?)\s*(min|minutes?|h|hr|hours?)\b/i);
  if (timeMatch) {
    const [, h, m, op, amtStr, unit] = timeMatch;
    let totalMin = Number.parseInt(h!, 10) * 60 + Number.parseInt(m!, 10);
    const amt = parseFloat(amtStr!);
    const sign = op === '+' ? 1 : -1;
    if (unit!.toLowerCase().startsWith('min')) totalMin += sign * amt;
    else totalMin += sign * amt * 60;
    totalMin = ((totalMin % 1440) + 1440) % 1440;
    const rh = Math.floor(totalMin / 60)
      .toString()
      .padStart(2, '0');
    const rm = (totalMin % 60).toString().padStart(2, '0');
    return { success: true, output: `${rh}:${rm}` };
  }

  // Datetime-looking input should fail with a self-correcting contract instead
  // of a generic parser error. In particular, never guess the user's timezone
  // from an offset-free local datetime or from phrases such as "UTC+2 to UTC".
  if (DATETIME_LIKE_RE.test(expr)) {
    return { success: false, error: DATETIME_SYNTAX_HINT };
  }

  // Numeric arithmetic: digits, whitespace, operators, parentheses only
  if (/^[\d\s+\-*/.()]+$/.test(expr)) {
    try {
      const result = evalArithmetic(expr);
      if (!Number.isFinite(result)) {
        return { success: false, error: 'Result is not a finite number' };
      }
      return { success: true, output: String(result) };
    } catch {
      return { success: false, error: `Cannot evaluate: ${expr}` };
    }
  }

  return {
    success: false,
    error: `Cannot parse: "${expr}". Supported: numbers (+,-,*,/), HH:MM ± N min/hours, ISO datetime ± N min/hours/days/weeks/months/years, YYYY-MM-DD ± N days/weeks/months/years, ISO datetime - ISO datetime`,
  };
}
handleCalculate.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;
