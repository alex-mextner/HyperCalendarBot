import { addMonths, addYears, subMonths, subYears } from 'date-fns';
import { ExactDecimal as Big } from '../../currency/exact-decimal.ts';
import type { ToolHandlerMeta, ToolResult } from '../types.ts';

const ISO_DT_RE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?';
const DURATION_UNITS = 'min|minutes?|h|hr|hours?|d|days?|w|weeks?|mo|months?|y|years?';

function evalArithmetic(expr: string): Big {
  const normalized = expr.replace(/×/g, '*').replace(/÷/g, '/');
  let pos = 0;
  function skipWs(): void {
    while (pos < normalized.length && /\s/.test(normalized[pos]!)) pos++;
  }
  function parseNumber(): Big {
    skipWs();
    const start = pos;
    if (normalized[pos] === '-') pos++;
    while (pos < normalized.length && /[\d.]/.test(normalized[pos]!)) pos++;
    const raw = normalized.slice(start, pos);
    if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Error(`Invalid number at position ${start}`);
    return new Big(raw);
  }
  function parseFactor(): Big {
    skipWs();
    if (normalized[pos] === '(') {
      pos++;
      const value = parseAddSub();
      skipWs();
      if (normalized[pos] !== ')') throw new Error('Expected )');
      pos++;
      return value;
    }
    return parseNumber();
  }
  function parseMulDiv(): Big {
    let left = parseFactor();
    while (true) {
      skipWs();
      const op = normalized[pos];
      if (op !== '*' && op !== '/') break;
      pos++;
      const right = parseFactor();
      if (op === '/' && right.eq(0)) throw new Error('Division by zero');
      left = op === '*' ? left.times(right) : left.div(right);
    }
    return left;
  }
  function parseAddSub(): Big {
    let left = parseMulDiv();
    while (true) {
      skipWs();
      const op = normalized[pos];
      if (op !== '+' && op !== '-') break;
      pos++;
      const right = parseMulDiv();
      left = op === '+' ? left.plus(right) : left.minus(right);
    }
    return left;
  }
  const result = parseAddSub();
  skipWs();
  if (pos !== normalized.length) throw new Error(`Unexpected character at position ${pos}: ${normalized[pos]}`);
  return result;
}

function formatBig(value: Big): string {
  return value.toFixed();
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
  if (input.expression.length > 500) return { success: false, error: 'Expression too long (max 500 chars)' };
  const expr = input.expression.trim();

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
    new RegExp(`^(${ISO_DT_RE})\\s*([+-])\\s*(\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNITS})\\b`, 'i'),
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

  // Numeric arithmetic and percentages. Keep intermediate ratios exact and round only the final output.
  const pctMatch = expr.match(/^(.+?)\s*([+-])\s*(\d+(?:[.,]\d+)?)%\s*$/);
  if (pctMatch) {
    try {
      const base = evalArithmetic(pctMatch[1]!.replace(',', '.'));
      const pct = new Big(pctMatch[3]!.replace(',', '.')).div(100);
      const delta = base.times(pct);
      return { success: true, output: formatBig(pctMatch[2] === '+' ? base.plus(delta) : base.minus(delta)) };
    } catch {
      return { success: false, error: `Cannot evaluate: ${expr}` };
    }
  }
  if (/^[\d\s+\-*/×÷.(),]+$/.test(expr)) {
    try {
      return { success: true, output: formatBig(evalArithmetic(expr.replace(/,/g, '.'))) };
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
