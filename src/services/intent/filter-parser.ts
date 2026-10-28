// src/services/intent/filter-parser.ts

import { format as dateFnsFormat, parseISO } from 'date-fns';
import { type HumanTimeContext, humanDay, humanDuration, humanWhen } from './human-time.ts';
import { type Token, tokenize } from './lexer.ts';

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export interface FilterCall {
  name: string;
  args: Array<string | number>;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('Unexpected end of filter expression');
    this.pos++;
    return t;
  }

  private expect(type: Token['type']): Token {
    const t = this.consume();
    if (t.type !== type) throw new Error(`Expected ${type}, got ${t.type}`);
    return t;
  }

  parseChain(): FilterCall[] {
    if (this.tokens.length === 0) throw new Error('Empty filter expression');

    const filters: FilterCall[] = [];
    filters.push(this.parseFilter());

    while (this.peek()?.type === 'pipe') {
      this.consume(); // |
      filters.push(this.parseFilter());
    }

    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token at position ${this.pos}`);
    }

    return filters;
  }

  private parseFilter(): FilterCall {
    const nameTok = this.expect('ident');
    const name = (nameTok as { type: 'ident'; value: string }).value;

    if (this.peek()?.type !== 'lparen') {
      return { name, args: [] };
    }

    this.consume(); // (
    const args: Array<string | number> = [];

    if (this.peek()?.type !== 'rparen') {
      args.push(this.parseArg());
      while (this.peek()?.type === 'comma') {
        this.consume(); // ,
        args.push(this.parseArg());
      }
    }

    this.expect('rparen');
    return { name, args };
  }

  private parseArg(): string | number {
    const t = this.peek();
    if (!t) throw new Error('Expected argument, got end of expression');

    if (t.type === 'number') {
      this.consume();
      return t.value;
    }
    if (t.type === 'string') {
      this.consume();
      return t.value;
    }
    if (t.type === 'ident') {
      this.consume();
      return t.value;
    }

    throw new Error(`Expected argument (number, string, or identifier), got ${t.type}`);
  }
}

// ---------------------------------------------------------------------------
// Public API: parse
// ---------------------------------------------------------------------------

export function parseFilterChain(input: string): FilterCall[] {
  const tokens = tokenize(input);
  return new Parser(tokens).parseChain();
}

// ---------------------------------------------------------------------------
// Public API: apply
// ---------------------------------------------------------------------------

type FilterArgs = FilterCall['args'];
type FilterImpl = (current: unknown, args: FilterArgs, context: HumanTimeContext | undefined) => unknown;

/** null/undefined render as the empty string; everything else is stringified. */
function textOf(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function numericArg(filterName: string, args: FilterArgs): number {
  const n = args[0];
  if (typeof n !== 'number') throw new Error(`${filterName}() requires a numeric argument`);
  return n;
}

/**
 * Offset (minutes east of UTC) written in an ISO string, `0` for a `Z` suffix,
 * or `null` when the string carries no explicit timezone.
 */
function explicitOffsetMinutes(isoStr: string): number | null {
  const offsetMatch = isoStr.match(/([+-])(\d{2}):(\d{2})$/);
  if (offsetMatch) return (offsetMatch[1] === '+' ? 1 : -1) * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
  return isoStr.endsWith('Z') ? 0 : null;
}

function dateFilter(current: unknown, args: FilterArgs): string {
  const fmt = String(args[0] ?? 'yyyy-MM-dd');
  if (current === undefined || current === null) return '';
  try {
    const isoStr = String(current);
    const parsed = parseISO(isoStr);
    // When the ISO string has an explicit timezone offset (e.g. +03:00),
    // parseISO normalizes to UTC and format() uses system timezone.
    // Adjust so formatting shows the original local wall-clock time.
    const targetOffsetMinutes = explicitOffsetMinutes(isoStr);
    if (targetOffsetMinutes === null) return dateFnsFormat(parsed, fmt);
    const adjusted = new Date(parsed.getTime() + (targetOffsetMinutes + parsed.getTimezoneOffset()) * 60000);
    return dateFnsFormat(adjusted, fmt);
  } catch {
    return String(current);
  }
}

function arithmeticFilter(name: string, apply: (left: number, n: number) => number): FilterImpl {
  return (current, args) => {
    const n = numericArg(name, args);
    return apply(Number(current ?? 0), n);
  };
}

const FILTER_IMPLS: Record<string, FilterImpl> = {
  pad: (current, args) => {
    const width = numericArg('pad', args);
    return textOf(current).padStart(width, '0');
  },
  upper: (current) => textOf(current).toUpperCase(),
  lower: (current) => textOf(current).toLowerCase(),
  trim: (current) => textOf(current).trim(),
  truncate: (current, args) => {
    const max = numericArg('truncate', args);
    const str = textOf(current);
    return str.length > max ? `${str.slice(0, max)}…` : str;
  },
  default: (current, args) => {
    const fallback = String(args[0] ?? '');
    return current === undefined || current === null ? fallback : current;
  },
  replace: (current, args) => {
    const from = String(args[0] ?? '');
    const to = String(args[1] ?? '');
    return current === undefined || current === null ? '' : String(current).replaceAll(from, to);
  },
  date: dateFilter,
  ternary: (current, args) => {
    const ifTrue = String(args[0] ?? '');
    const ifFalse = String(args[1] ?? '');
    return current ? ifTrue : ifFalse;
  },
  eq: (current, args) => {
    const match = String(args[0] ?? '');
    const ifMatch = String(args[1] ?? '');
    const ifNoMatch = String(args[2] ?? '');
    return String(current) === match ? ifMatch : ifNoMatch;
  },
  add: arithmeticFilter('add', (left, n) => left + n),
  sub: arithmeticFilter('sub', (left, n) => left - n),
  mul: arithmeticFilter('mul', (left, n) => left * n),
  div: (current, args) => {
    const n = numericArg('div', args);
    if (n === 0) throw new Error('div() by zero');
    return Math.floor(Number(current ?? 0) / n);
  },
  human_day: (current, _args, context) => {
    if (!context) throw new Error("human_day() needs the user's language and zone");
    return humanDay(textOf(current), context);
  },
  human_when: (current, _args, context) => {
    if (!context) throw new Error("human_when() needs the user's language and zone");
    return humanWhen(textOf(current), context);
  },
  human_duration: (current, _args, context) => {
    const minutes = Number(current);
    if (!context) throw new Error("human_duration() needs the user's language");
    if (!Number.isFinite(minutes)) throw new Error('human_duration() needs a number of minutes');
    return humanDuration(minutes, context.language);
  },
};

const KNOWN_FILTERS = new Set(Object.keys(FILTER_IMPLS));

/** `context` carries the reader's language, zone and clock for the wording filters (human_day, human_when). */
export function applyFilters(value: unknown, filters: FilterCall[], context?: HumanTimeContext): string {
  let current: unknown = value;

  for (const filter of filters) {
    if (!KNOWN_FILTERS.has(filter.name)) {
      throw new Error(`Unknown filter: ${filter.name}`);
    }
    current = FILTER_IMPLS[filter.name]!(current, filter.args, context);
  }

  return textOf(current);
}

// ---------------------------------------------------------------------------
// Validator helper: list of known filter names for workflow validation
// ---------------------------------------------------------------------------

export { KNOWN_FILTERS };
