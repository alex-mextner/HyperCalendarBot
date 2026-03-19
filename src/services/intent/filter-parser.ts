// src/services/intent/filter-parser.ts

import { format as dateFnsFormat, parseISO } from 'date-fns';

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

type Token =
  | { type: 'ident'; value: string }
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' }
  | { type: 'pipe' };

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Skip whitespace
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    // Single-char punctuation
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i++;
      continue;
    }
    if (ch === '|') {
      tokens.push({ type: 'pipe' });
      i++;
      continue;
    }

    // Quoted string (double or single quotes)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let str = '';
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) {
          i++;
          str += input[i];
        } else {
          str += input[i];
        }
        i++;
      }
      if (i >= input.length) throw new Error(`Unterminated string literal in filter: ${input}`);
      i++; // closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }

    // Number
    if (ch >= '0' && ch <= '9') {
      let num = '';
      while (i < input.length && input[i]! >= '0' && input[i]! <= '9') {
        num += input[i];
        i++;
      }
      tokens.push({ type: 'number', value: Number.parseInt(num, 10) });
      continue;
    }

    // Identifier (ASCII + Cyrillic)
    if (/[a-zA-Z_а-яёА-ЯЁ]/.test(ch)) {
      let ident = '';
      while (i < input.length && /[a-zA-Z0-9_а-яёА-ЯЁ]/.test(input[i]!)) {
        ident += input[i];
        i++;
      }
      tokens.push({ type: 'ident', value: ident });
      continue;
    }

    throw new Error(`Unexpected character '${ch}' in filter: ${input}`);
  }

  return tokens;
}

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

const KNOWN_FILTERS = new Set(['pad', 'upper', 'lower', 'trim', 'truncate', 'default', 'replace', 'date', 'ternary']);

export function applyFilters(value: unknown, filters: FilterCall[]): string {
  let current: unknown = value;

  for (const filter of filters) {
    if (!KNOWN_FILTERS.has(filter.name)) {
      throw new Error(`Unknown filter: ${filter.name}`);
    }

    switch (filter.name) {
      case 'pad': {
        const width = filter.args[0];
        if (typeof width !== 'number') throw new Error('pad() requires a numeric argument');
        const str = current === undefined || current === null ? '' : String(current);
        current = str.padStart(width, '0');
        break;
      }
      case 'upper':
        current = current === undefined || current === null ? '' : String(current).toUpperCase();
        break;
      case 'lower':
        current = current === undefined || current === null ? '' : String(current).toLowerCase();
        break;
      case 'trim':
        current = current === undefined || current === null ? '' : String(current).trim();
        break;
      case 'truncate': {
        const max = filter.args[0];
        if (typeof max !== 'number') throw new Error('truncate() requires a numeric argument');
        const str = current === undefined || current === null ? '' : String(current);
        current = str.length > max ? `${str.slice(0, max)}…` : str;
        break;
      }
      case 'default': {
        const fallback = String(filter.args[0] ?? '');
        if (current === undefined || current === null) current = fallback;
        break;
      }
      case 'replace': {
        const from = String(filter.args[0] ?? '');
        const to = String(filter.args[1] ?? '');
        current = current === undefined || current === null ? '' : String(current).replaceAll(from, to);
        break;
      }
      case 'date': {
        const fmt = String(filter.args[0] ?? 'yyyy-MM-dd');
        if (current === undefined || current === null) {
          current = '';
        } else {
          try {
            current = dateFnsFormat(parseISO(String(current)), fmt);
          } catch {
            current = String(current);
          }
        }
        break;
      }
      case 'ternary': {
        const ifTrue = String(filter.args[0] ?? '');
        const ifFalse = String(filter.args[1] ?? '');
        current = current ? ifTrue : ifFalse;
        break;
      }
    }
  }

  return current === undefined || current === null ? '' : String(current);
}

// ---------------------------------------------------------------------------
// Validator helper: list of known filter names for workflow validation
// ---------------------------------------------------------------------------

export { KNOWN_FILTERS };
