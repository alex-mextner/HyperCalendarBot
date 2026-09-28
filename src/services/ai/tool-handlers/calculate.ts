import { TZDate } from '@date-fns/tz';
import { addMonths, addYears, subMonths, subYears } from 'date-fns';
import type { ToolHandlerMeta, ToolResult } from '../types.ts';
import { formatLocalIso, validateAndGetOffset } from './timezone.ts';

const ISO_DT_RE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})';
/** Same shape as ISO_DT_RE, with every component captured. */
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(?:Z|([+-])(\d{2}):?(\d{2}))$/i;
const DATETIME_LIKE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/;
const DATE_TOKEN_RE = /(?<!\d)\d{4}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])(?!\d)/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DURATION_UNITS = 'min|minutes?|h|hr|hours?|d|days?|w|weeks?|mo|months?|y|years?';
const IANA_ZONE = '[A-Za-z_]+(?:\\/[A-Za-z0-9_+.-]+)+';
const DATED_WALL_CLOCK = '(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?';
const UTC_SOURCE_RE = new RegExp(`^${DATED_WALL_CLOCK}\\s+UTC(?:([+-])(\\d{1,2})(?::?(\\d{2}))?)?$`, 'i');
const IANA_SOURCE_RE = new RegExp(`^${DATED_WALL_CLOCK}\\s+(${IANA_ZONE})$`);
const CONVERSION_RE = new RegExp(`^(.+?)\\s+to\\s+(UTC|${IANA_ZONE})$`, 'i');
const DATELESS_SOURCE_RE = new RegExp(
  `^\\d{1,2}:\\d{2}(?::\\d{2})?\\s+(?:UTC(?:[+-]\\d{1,2}(?::?\\d{2})?)?|${IANA_ZONE})$`,
  'i',
);
const TIME_FIXED_TO_UTC_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s+UTC([+-])(\d{1,2})(?::?(\d{2}))?\s+to\s+UTC$/i;
const WEEKDAY_KEYWORD = '(?:day[_\\s]+of[_\\s]+week|weekday)';
const WEEKDAY_RE = new RegExp(
  `^(?:${WEEKDAY_KEYWORD}\\s*\\(\\s*(.+?)\\s*\\)|${WEEKDAY_KEYWORD}\\s+(.+)|(.+?)\\s+${WEEKDAY_KEYWORD})$`,
  'i',
);
const WEEKDAY_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });

// Every double-quoted example below must execute successfully: the model
// retries with exactly these strings (pinned by calculate-model-forms.test.ts).
const DATETIME_SYNTAX_HINT =
  'Datetime arithmetic requires ISO 8601 with T and an explicit Z/offset, e.g. "2026-09-17T10:49:00+02:00 + 2hours". Local-to-UTC conversion accepts a dated IANA zone, e.g. "2026-09-23 12:30 Europe/Belgrade to UTC", or an explicit fixed UTC offset. UTC to local: "2026-09-27 10:30 UTC to Europe/Belgrade". Weekday of a date: "2026-09-28 day_of_week". For arithmetic forms, do not append "to UTC".';
const DATE_REQUIRED_HINT =
  'Conversion with an IANA timezone needs the calendar date because the UTC offset depends on DST on that date, e.g. "2026-09-23 12:00 Europe/Belgrade to UTC".';
const WEEKDAY_HINT =
  'Weekday needs the local calendar date as YYYY-MM-DD, e.g. "2026-09-28 day_of_week". For a datetime, first convert it to the user timezone, e.g. "2026-09-27T22:30:00Z to Europe/Belgrade", and pass the local date it returns.';
const DATE_SYNTAX_HINT =
  'A YYYY-MM-DD date is not a number. Date forms: weekday "2026-09-28 day_of_week", shift "2026-09-28 + 7days", days between "2026-10-10 - 2026-09-28", dated conversion "2026-09-28 12:30 Europe/Belgrade to UTC".';

function evalArithmetic(expr: string): number {
  let pos = 0;

  function skipWs(): void {
    while (pos < expr.length && /\s/.test(expr[pos]!)) pos++;
  }

  function parseNumber(): number {
    skipWs();
    const start = pos;
    if (expr[pos] === '-') pos++;
    while (pos < expr.length && /[\d.]/.test(expr[pos]!)) pos++;
    const token = expr.slice(start, pos);
    if (!/^[-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) throw new Error(`Expected a number at position ${start}`);
    const n = Number(token);
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

interface IsoInstant {
  ms: number;
  offsetMinutes: number;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Six captured "YYYY MM DD HH MM [SS]" groups; an absent seconds group means :00. */
function wallClock(groups: readonly (string | undefined)[]): WallClock {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = groups.map((group) => Number(group ?? '0'));
  return { year, month, day, hour, minute, second };
}

function validWallClock({ year, month, day, hour, minute, second }: WallClock): boolean {
  return validCalendarDate(year, month, day) && hour <= 23 && minute <= 59 && second <= 59;
}

/** Signed minutes of a "±H[:MM]" UTC offset; null outside the real-world ±14:00 range. */
function fixedOffsetMinutes(sign: string, hoursRaw: string, minutesRaw: string | undefined): number | null {
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw ?? '0');
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  return (sign === '+' ? 1 : -1) * (hours * 60 + minutes);
}

/** ISO 8601 instant with an explicit Z/offset. Null when `text` has another shape. */
function parseIsoInstant(text: string): IsoInstant | { error: string } | null {
  const match = text.match(ISO_INSTANT_RE);
  if (!match) return null;
  const clock = wallClock(match.slice(1, 7));
  const [fractionRaw, signRaw, offsetHourRaw, offsetMinuteRaw] = match.slice(7);
  const offsetMinutes = signRaw ? fixedOffsetMinutes(signRaw, offsetHourRaw!, offsetMinuteRaw) : 0;
  if (!validWallClock(clock) || offsetMinutes === null) return { error: `Invalid datetime: ${text}` };
  const { year, month, day, hour, minute, second } = clock;
  const millis = Number((fractionRaw ?? '').padEnd(3, '0').slice(0, 3));
  return { ms: Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60_000, offsetMinutes };
}

/**
 * The instant a conversion starts from: an ISO instant with Z/offset, a dated
 * wall clock at UTC or UTC±H, or a dated wall clock in an IANA zone. Null when
 * `source` is none of these.
 */
function parseSourceInstant(source: string): { ms: number } | { error: string } | null {
  const iso = parseIsoInstant(source);
  if (iso) return iso;

  const utcMatch = source.match(UTC_SOURCE_RE);
  if (utcMatch) {
    const clock = wallClock(utcMatch.slice(1, 7));
    const [signRaw, offsetHourRaw, offsetMinuteRaw] = utcMatch.slice(7);
    const offsetMinutes = signRaw ? fixedOffsetMinutes(signRaw, offsetHourRaw!, offsetMinuteRaw) : 0;
    const { year, month, day, hour, minute, second } = clock;
    if (offsetMinutes === null || hour > 23 || minute > 59 || second > 59)
      return { error: `Invalid fixed-offset datetime: ${source}` };
    if (!validCalendarDate(year, month, day)) return { error: `Invalid date: ${source}` };
    return { ms: Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000 };
  }

  // TZDate resolves the offset for the requested calendar date, so future DST
  // changes never reuse today's offset.
  const ianaMatch = source.match(IANA_SOURCE_RE);
  if (!ianaMatch) return null;
  const clock = wallClock(ianaMatch.slice(1, 7));
  const timezone = ianaMatch[7]!;
  if (!validWallClock(clock)) return { error: `Invalid local datetime: ${source}` };
  const { year, month, day, hour, minute, second } = clock;
  // An unknown zone name does not throw: TZDate yields an Invalid Date (NaN).
  const local = TZDate.tz(timezone, year, month - 1, day, hour, minute, second, 0);
  if (Number.isNaN(local.getTime())) return { error: `Invalid timezone: ${timezone}` };
  if (!sameWallClock(local, year, month, day, hour, minute, second))
    return { error: `Local time does not exist in ${timezone} because of a clock change.` };
  if (localTimeIsAmbiguous(local.getTime(), timezone, year, month, day, hour, minute, second))
    return {
      error: `Local time is ambiguous in ${timezone} because of a clock change; specify an explicit UTC offset.`,
    };
  return { ms: local.getTime() };
}

/**
 * "2026-09-19T13:00:00+02:00 - 2hours": the offset already converts the local
 * time to UTC, so shifting by that same offset toward UTC converts it twice.
 * Models did this for "to UTC" and stored events two hours early.
 */
function doubleConversionError(
  operand: string,
  instant: IsoInstant,
  op: string,
  shift: { amount: number; unit: 'hour' | 'minute'; token: string },
): string {
  const abs = Math.abs(instant.offsetMinutes);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const offsetStr = `${instant.offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const utc = new Date(instant.ms).toISOString();
  const doubled = new Date(instant.ms + (op === '+' ? 1 : -1) * abs * 60_000);
  const doubledLocal = formatLocalIso(doubled, { offsetStr, offsetMinutes: instant.offsetMinutes }).slice(11, 16);
  const amount = `${shift.amount} ${shift.unit}${shift.amount === 1 ? '' : 's'}`;
  return (
    `The ${offsetStr} offset is already applied: ${operand} is ${utc}. ` +
    `${op === '+' ? 'Adding' : 'Subtracting'} ${amount} again would give ${doubled.toISOString()} (${doubledLocal} local) — a double conversion. ` +
    `To convert local time to UTC send "${operand}" alone. ` +
    `If you really need ${amount} ${op === '+' ? 'later' : 'earlier'}, restate in UTC: "${utc.replace(/\.000Z$/, 'Z')} ${op} ${shift.token}".`
  );
}

export function handleCalculate(input: { expression: string }): ToolResult {
  if (input.expression.length > 500) return { success: false, error: 'Expression exceeds the 500 character limit' };
  const expr = input.expression.trim();

  const weekdayMatch = expr.match(WEEKDAY_RE);
  if (weekdayMatch) {
    const dateMatch = (weekdayMatch[1] ?? weekdayMatch[2] ?? weekdayMatch[3] ?? '').match(DATE_ONLY_RE);
    if (!dateMatch) return { success: false, error: WEEKDAY_HINT };
    const year = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const day = Number(dateMatch[3]);
    if (!validCalendarDate(year, month, day)) return { success: false, error: `Invalid date: ${dateMatch[0]}` };
    return { success: true, output: WEEKDAY_FORMAT.format(new Date(Date.UTC(year, month - 1, day))) };
  }

  // Date-less fixed offsets are deterministic and retained for explicit user
  // input and backward compatibility with the old prompt.
  const timeFixedMatch = expr.match(TIME_FIXED_TO_UTC_RE);
  if (timeFixedMatch) {
    const [, hourRaw, minuteRaw, secondRaw, signRaw, offsetHourRaw, offsetMinuteRaw] = timeFixedMatch;
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const second = Number(secondRaw ?? '0');
    const offsetMinutes = fixedOffsetMinutes(signRaw!, offsetHourRaw!, offsetMinuteRaw);
    if (hour > 23 || minute > 59 || second > 59 || offsetMinutes === null)
      return { success: false, error: `Invalid fixed-offset datetime: ${expr}` };
    const utcMinutes = (((hour * 60 + minute - offsetMinutes) % 1440) + 1440) % 1440;
    const hhmm = `${Math.floor(utcMinutes / 60)
      .toString()
      .padStart(2, '0')}:${(utcMinutes % 60).toString().padStart(2, '0')}`;
    return { success: true, output: secondRaw === undefined ? hhmm : `${hhmm}:${String(second).padStart(2, '0')}` };
  }

  // Instant → UTC (ISO Z) or → IANA zone (local ISO with that instant's offset,
  // so a DST fold on the target side is unambiguous).
  const conversionMatch = expr.match(CONVERSION_RE);
  if (conversionMatch) {
    const [, source, target] = conversionMatch;
    const instant = parseSourceInstant(source!);
    if (instant && 'error' in instant) return { success: false, error: instant.error };
    if (instant) {
      const date = new Date(instant.ms);
      if (/^(?:etc\/)?utc$/i.test(target!)) return { success: true, output: date.toISOString() };
      try {
        return { success: true, output: formatLocalIso(date, validateAndGetOffset(target!, date)) };
      } catch {
        // Intl throws RangeError for an unknown zone name: the model's input error.
        return { success: false, error: `Invalid timezone: ${target}` };
      }
    }
    if (DATELESS_SOURCE_RE.test(source!)) return { success: false, error: DATE_REQUIRED_HINT };
  }

  // A bare ISO instant with Z/offset is already unambiguous: normalize to UTC.
  const bareInstant = parseIsoInstant(expr);
  if (bareInstant)
    return 'error' in bareInstant
      ? { success: false, error: bareInstant.error }
      : { success: true, output: new Date(bareInstant.ms).toISOString() };

  // ISO datetime difference: "2026-03-21T18:00:00Z - 2026-03-21T17:00:00Z"
  const isoDatetimeDiffMatch = expr.match(new RegExp(`^(${ISO_DT_RE})\\s*-\\s*(${ISO_DT_RE})$`));
  if (isoDatetimeDiffMatch) {
    const [, aStr, bStr] = isoDatetimeDiffMatch;
    // Same validation as the other instant forms: "2026-02-31T…" is refused, not rolled over.
    const a = parseIsoInstant(aStr!);
    const b = parseIsoInstant(bStr!);
    if (!a || 'error' in a) return { success: false, error: `Cannot parse datetime: ${aStr}` };
    if (!b || 'error' in b) return { success: false, error: `Cannot parse datetime: ${bStr}` };
    return { success: true, output: formatDiffMs(Math.abs(a.ms - b.ms)) };
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
    const instant = parseIsoInstant(dateStr!);
    if (!instant || 'error' in instant) return { success: false, error: `Cannot parse datetime: ${dateStr}` };
    const date = new Date(instant.ms);
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
    const isMinutes = unitL.startsWith('min');
    const isHours = unitL === 'h' || unitL.startsWith('hr') || unitL.startsWith('hour');
    let deltaMs: number;
    if (isMinutes) deltaMs = amt * 60_000;
    else if (isHours) deltaMs = amt * 3_600_000;
    else if (unitL === 'w' || unitL.startsWith('week')) deltaMs = amt * 7 * 86_400_000;
    else deltaMs = amt * 86_400_000;
    const towardUtc = instant.offsetMinutes !== 0 && (instant.offsetMinutes > 0 ? op === '-' : op === '+');
    if ((isMinutes || isHours) && towardUtc && deltaMs === Math.abs(instant.offsetMinutes) * 60_000)
      return {
        success: false,
        error: doubleConversionError(dateStr!, instant, op!, {
          amount: amt,
          unit: isHours ? 'hour' : 'minute',
          token: `${amtStr}${unit}`,
        }),
      };
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

  // A date is never an arithmetic operand: "2026-09-24" would evaluate to 1993.
  if (DATE_TOKEN_RE.test(expr)) return { success: false, error: DATE_SYNTAX_HINT };

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
    error: `Cannot parse: "${expr}". Supported: numbers (+,-,*,/), HH:MM ± N min/hours, ISO datetime ± N min/hours/days/weeks/months/years, YYYY-MM-DD ± N days/weeks/months/years, ISO datetime - ISO datetime, "YYYY-MM-DD HH:MM <zone> to UTC", "<UTC instant> to <IANA zone>", "YYYY-MM-DD day_of_week"`,
  };
}
handleCalculate.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;
