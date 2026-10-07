import { TZDate } from '@date-fns/tz';
import { addMonths, addYears, subMonths, subYears } from 'date-fns';
import type { ToolHandlerMeta, ToolResult } from '../types.ts';
import { formatLocalIso, validateAndGetOffset } from './timezone.ts';

const ISO_DT_RE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})';
/** Same shape as ISO_DT_RE, with every component captured by name. */
const ISO_INSTANT_RE =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?(?:\.(?<fraction>\d+))?(?:Z|(?<sign>[+-])(?<offsetHour>\d{2}):?(?<offsetMinute>\d{2}))$/i;
const DATETIME_LIKE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/;
/** Anything date-shaped, valid or not: "2026-13-01" must not become 2026 - 13 - 1. */
const DATE_TOKEN_RE = /(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DURATION_UNITS = 'min|minutes?|h|hr|hours?|d|days?|w|weeks?|mo|months?|y|years?';
const IANA_ZONE = '[A-Za-z_]+(?:\\/[A-Za-z0-9_+.-]+)+';
const DATED_WALL_CLOCK =
  '(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})[ T](?<hour>\\d{1,2}):(?<minute>\\d{2})(?::(?<second>\\d{2}))?';
const UTC_SOURCE_RE = new RegExp(
  `^${DATED_WALL_CLOCK}\\s+UTC(?:(?<sign>[+-])(?<offsetHour>\\d{1,2})(?::?(?<offsetMinute>\\d{2}))?)?$`,
  'i',
);
const IANA_SOURCE_RE = new RegExp(`^${DATED_WALL_CLOCK}\\s+(?<zone>${IANA_ZONE})$`);
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
const WEEKDAY_HINT =
  'Weekday needs the local calendar date as YYYY-MM-DD, e.g. "2026-09-28 day_of_week". For a datetime, first convert it with "<datetime> to <user IANA timezone>" and pass the local date it returns.';
const DATE_SYNTAX_HINT =
  'A YYYY-MM-DD date is not a number. Date forms: weekday "2026-09-28 day_of_week", shift "2026-09-28 + 7days", days between "2026-10-10 - 2026-09-28", dated conversion "2026-09-28 12:30 Europe/Belgrade to UTC".';

/** Exact rational: numerator over a positive denominator, always reduced. */
interface Rational {
  n: bigint;
  d: bigint;
}

/** Decimal places rendered for a non-terminating quotient (half away from zero). */
const MAX_FRACTION_DIGITS = 40;
const ARITHMETIC_RE = /^[\d\s+\-*/×÷.()%]+$/;
const PERCENT_RE = /^(.+?)\s*([+-])\s*(\d+(?:\.\d+)?|\.\d+)\s*%$/;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function rational(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new Error('Division by zero');
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d);
  return { n: (sign * n) / g, d: (sign * d) / g };
}

function parseDecimal(token: string): Rational {
  const [whole = '', fraction = ''] = token.split('.');
  return rational(BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length));
}

/** Exact decimal; only a non-terminating quotient is rounded, to MAX_FRACTION_DIGITS, and only here. */
function formatRational({ n, d }: Rational): string {
  const negative = n < 0n;
  const scale = 10n ** BigInt(MAX_FRACTION_DIGITS);
  const scaled = ((negative ? -n : n) * scale * 2n + d) / (2n * d);
  const whole = (scaled / scale).toString();
  const fraction = (scaled % scale).toString().padStart(MAX_FRACTION_DIGITS, '0').replace(/0+$/, '');
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative && scaled !== 0n ? `-${text}` : text;
}

/**
 * Recursive-descent evaluator over exact rationals, so "0.1 + 0.2" is 0.3 and
 * "1 / 3 * 3" is 1: no binary floating point and no intermediate rounding.
 * The 500-character input cap bounds both nesting depth and operand size.
 */
function evalArithmetic(source: string): Rational {
  const expr = source.replace(/×/g, '*').replace(/÷/g, '/');
  let pos = 0;

  function skipWs(): void {
    while (pos < expr.length && /\s/.test(expr[pos]!)) pos++;
  }

  function parseNumber(): Rational {
    const start = pos;
    while (pos < expr.length && /[\d.]/.test(expr[pos]!)) pos++;
    const token = expr.slice(start, pos);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) throw new Error(`Expected a number at position ${start}`);
    return parseDecimal(token);
  }

  function parseUnary(): Rational {
    skipWs();
    const op = expr[pos];
    if (op === '-' || op === '+') {
      pos++;
      const value = parseUnary();
      return op === '-' ? { n: -value.n, d: value.d } : value;
    }
    if (op === '(') {
      pos++;
      const value = parseAddSub();
      skipWs();
      if (expr[pos] !== ')') throw new Error('Expected )');
      pos++;
      return value;
    }
    return parseNumber();
  }

  function parseMulDiv(): Rational {
    let left = parseUnary();
    while (true) {
      skipWs();
      const op = expr[pos];
      if (op !== '*' && op !== '/') break;
      pos++;
      const right = parseUnary();
      left = op === '*' ? rational(left.n * right.n, left.d * right.d) : rational(left.n * right.d, left.d * right.n);
    }
    return left;
  }

  function parseAddSub(): Rational {
    let left = parseMulDiv();
    while (true) {
      skipWs();
      const op = expr[pos];
      if (op !== '+' && op !== '-') break;
      pos++;
      const right = parseMulDiv();
      const sign = op === '+' ? 1n : -1n;
      left = rational(left.n * right.d + sign * right.n * left.d, left.d * right.d);
    }
    return left;
  }

  const result = parseAddSub();
  skipWs();
  if (pos !== expr.length) throw new Error(`Unexpected character at position ${pos}: ${expr[pos]}`);
  return result;
}

/** "EXPR ± N%" changes EXPR by N percent of itself; anything else is plain arithmetic. */
function evalWithPercent(expr: string): Rational {
  const percent = expr.match(PERCENT_RE);
  if (!percent) return evalArithmetic(expr);
  const base = evalArithmetic(percent[1]!);
  const rate = parseDecimal(percent[3]!);
  const sign = percent[2] === '+' ? 1n : -1n;
  // base × (1 ± rate/100) = base × (100·rate.d ± rate.n) / (100·rate.d)
  return rational(base.n * (100n * rate.d + sign * rate.n), base.d * 100n * rate.d);
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

/** Other instants (within ±3 h) that show the same wall clock in `timezone`: non-empty only in a DST fold. */
function otherInstantsWithSameWallClock(
  instant: number,
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number[] {
  const others: number[] = [];
  for (let deltaMinutes = -180; deltaMinutes <= 180; deltaMinutes += 15) {
    if (deltaMinutes === 0) continue;
    const candidate = new TZDate(instant + deltaMinutes * 60_000, timezone);
    if (sameWallClock(candidate, year, month, day, hour, minute, second)) others.push(candidate.getTime());
  }
  return others;
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

type RegExpGroups = { [name: string]: string | undefined };

/** Named year/month/day/hour/minute[/second] groups; an absent second means :00. */
function parseWallClock(groups: RegExpGroups): WallClock {
  const read = (name: string) => Number(groups[name] ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function validWallClock({ year, month, day, hour, minute, second }: WallClock): boolean {
  return validCalendarDate(year, month, day) && hour <= 23 && minute <= 59 && second <= 59;
}

/** Signed minutes of the named sign/offsetHour/offsetMinute groups (0 when absent); null outside ±14:00. */
function parseOffsetMinutes(groups: RegExpGroups): number | null {
  if (!groups.sign) return 0;
  const hours = Number(groups.offsetHour);
  const minutes = Number(groups.offsetMinute ?? '0');
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  return (groups.sign === '+' ? 1 : -1) * (hours * 60 + minutes);
}

/** "YYYY-MM-DD" as UTC noon, or null for an impossible date such as 2026-02-31 (never rolled over). */
function parseCalendarDate(text: string): Date | null {
  const match = text.match(DATE_ONLY_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return validCalendarDate(year, month, day) ? new Date(Date.UTC(year, month - 1, day, 12)) : null;
}

/** ISO 8601 instant with an explicit Z/offset. Null when `text` has another shape. */
function parseIsoInstant(text: string): IsoInstant | { error: string } | null {
  const groups = text.match(ISO_INSTANT_RE)?.groups;
  if (!groups) return null;
  const clock = parseWallClock(groups);
  const offsetMinutes = parseOffsetMinutes(groups);
  if (!validWallClock(clock) || offsetMinutes === null) return { error: `Invalid datetime: ${text}` };
  const { year, month, day, hour, minute, second } = clock;
  const millis = Number((groups.fraction ?? '').padEnd(3, '0').slice(0, 3));
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

  const utcGroups = source.match(UTC_SOURCE_RE)?.groups;
  if (utcGroups) {
    const clock = parseWallClock(utcGroups);
    const offsetMinutes = parseOffsetMinutes(utcGroups);
    if (offsetMinutes === null || !validWallClock(clock)) return { error: `Invalid datetime: ${source}` };
    const { year, month, day, hour, minute, second } = clock;
    return { ms: Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000 };
  }

  // TZDate resolves the offset for the requested calendar date, so future DST
  // changes never reuse today's offset.
  const ianaGroups = source.match(IANA_SOURCE_RE)?.groups;
  if (!ianaGroups) return null;
  const clock = parseWallClock(ianaGroups);
  const timezone = ianaGroups.zone ?? '';
  if (!validWallClock(clock)) return { error: `Invalid local datetime: ${source}` };
  // TZDate does not validate the name: "A/B" gives NaN and "Etc/GMT+99" a
  // made-up offset. Intl rejects both, as it does for the target zone.
  try {
    validateAndGetOffset(timezone, new Date(0));
  } catch {
    return { error: `Invalid timezone: ${timezone}` };
  }
  const { year, month, day, hour, minute, second } = clock;
  const local = TZDate.tz(timezone, year, month - 1, day, hour, minute, second, 0);
  if (!sameWallClock(local, year, month, day, hour, minute, second))
    return { error: `Local time does not exist in ${timezone} because of a clock change.` };
  const others = otherInstantsWithSameWallClock(local.getTime(), timezone, year, month, day, hour, minute, second);
  if (others.length > 0) {
    const offsets = [local.getTime(), ...others]
      .sort((a, b) => a - b)
      .map((ms) => `UTC${validateAndGetOffset(timezone, new Date(ms)).offsetStr}`);
    const wallClock = source.slice(0, source.length - timezone.length).trimEnd();
    return {
      error: `Local time is ambiguous in ${timezone} because of a clock change: it occurs at ${offsets.join(' and again at ')}. Specify the offset, e.g. "${wallClock} ${offsets[0]} to UTC".`,
    };
  }
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
    const dateStr = weekdayMatch[1] ?? weekdayMatch[2] ?? weekdayMatch[3] ?? '';
    if (!DATE_ONLY_RE.test(dateStr)) return { success: false, error: WEEKDAY_HINT };
    const date = parseCalendarDate(dateStr);
    if (!date) return { success: false, error: `Invalid date: ${dateStr}` };
    return { success: true, output: WEEKDAY_FORMAT.format(date) };
  }

  // Date-less fixed offsets are deterministic and retained for explicit user
  // input and backward compatibility with the old prompt.
  const timeFixedMatch = expr.match(TIME_FIXED_TO_UTC_RE);
  if (timeFixedMatch) {
    const [, hourRaw, minuteRaw, secondRaw, signRaw, offsetHourRaw, offsetMinuteRaw] = timeFixedMatch;
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const second = Number(secondRaw ?? '0');
    const offsetMinutes = parseOffsetMinutes({
      sign: signRaw,
      offsetHour: offsetHourRaw,
      offsetMinute: offsetMinuteRaw,
    });
    if (hour > 23 || minute > 59 || second > 59 || offsetMinutes === null)
      return { success: false, error: `Invalid fixed-offset datetime: ${expr}` };
    // A date-less result must say when it crossed midnight: "00:30 UTC+2" is 22:30 UTC the day before.
    const rawUtcMinutes = hour * 60 + minute - offsetMinutes;
    const utcMinutes = ((rawUtcMinutes % 1440) + 1440) % 1440;
    const hhmm = `${Math.floor(utcMinutes / 60)
      .toString()
      .padStart(2, '0')}:${(utcMinutes % 60).toString().padStart(2, '0')}`;
    const time = secondRaw === undefined ? hhmm : `${hhmm}:${String(second).padStart(2, '0')}`;
    const daySuffix = rawUtcMinutes < 0 ? ' (previous day)' : rawUtcMinutes >= 1440 ? ' (next day)' : '';
    return { success: true, output: `${time}${daySuffix}` };
  }

  // Instant → UTC (ISO Z) or → IANA zone (local ISO with that instant's offset,
  // so a DST fold on the target side is unambiguous).
  const conversionMatch = expr.match(CONVERSION_RE);
  if (conversionMatch) {
    const [, source, target] = conversionMatch;
    const targetIsUtc = /^(?:etc\/)?utc$/i.test(target!);
    const instant = parseSourceInstant(source!);
    if (instant && 'error' in instant) return { success: false, error: instant.error };
    if (instant) {
      const date = new Date(instant.ms);
      if (targetIsUtc) return { success: true, output: date.toISOString() };
      try {
        return { success: true, output: formatLocalIso(date, validateAndGetOffset(target!, date)) };
      } catch {
        // Intl throws RangeError for an unknown zone name: the model's input error.
        return { success: false, error: `Invalid timezone: ${target}` };
      }
    }
    // Only an IANA zone on either side makes the offset date-dependent; the
    // example keeps the model's own time and zones and only adds a date.
    if (DATELESS_SOURCE_RE.test(source!) && (source!.includes('/') || !targetIsUtc))
      return {
        success: false,
        error: `Conversion with an IANA timezone needs the calendar date because the UTC offset depends on DST on that date. Put the event's date first, e.g. "2026-09-23 ${source} to ${target}".`,
      };
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
    const a = parseCalendarDate(aStr!);
    const b = parseCalendarDate(bStr!);
    if (!a) return { success: false, error: `Invalid date: ${aStr}` };
    if (!b) return { success: false, error: `Invalid date: ${bStr}` };
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
    const date = parseCalendarDate(dateStr!);
    if (!date) return { success: false, error: `Invalid date: ${dateStr}` };
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

  // Exact decimal arithmetic: digits, operators (incl. × ÷), parentheses and "EXPR ± N%".
  if (ARITHMETIC_RE.test(expr)) {
    try {
      return { success: true, output: formatRational(evalWithPercent(expr)) };
    } catch (error) {
      if (error instanceof Error && error.message === 'Division by zero')
        return { success: false, error: `Division by zero: ${expr}` };
      return { success: false, error: `Cannot evaluate: ${expr}` };
    }
  }

  return {
    success: false,
    error: `Cannot parse: "${expr}". Supported: numbers (+,-,*,/,×,÷, parentheses, percent change "100 - 7.5%"), HH:MM ± N min/hours, ISO datetime ± N min/hours/days/weeks/months/years, YYYY-MM-DD ± N days/weeks/months/years, ISO datetime - ISO datetime, "YYYY-MM-DD HH:MM <zone> to UTC", "<UTC instant> to <IANA zone>", "YYYY-MM-DD day_of_week"`,
  };
}
handleCalculate.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;
