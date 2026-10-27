/**
 * Shared lexer for the template filter language and the `when` expression evaluator.
 *
 * Tokenizes strings like:
 *   pad(2)|upper                              — filter chain (filter-parser.ts)
 *   ampm == "утра" && isPastHour($1) == false — boolean expression (expression-evaluator.ts)
 *
 * Token stream is consumed by filter-parser.ts (FilterCall[]) or
 * expression-evaluator.ts (boolean result).
 *
 * Character classes:
 *   identifier  — ASCII letters/digits/underscore/$ + Cyrillic (а-яёА-ЯЁ)
 *   bool        — bare `true` or `false` keyword
 *   number      — ASCII digits only, parsed as integer
 *   string      — double or single quoted, backslash escapes supported
 *   op          — comparison/logical operators: == != >= <= > < && ||
 *   punctuation — | ( ) , . [ ]
 *   whitespace  — space, tab (silently skipped)
 */

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export type Token =
  | { type: 'ident'; value: string }
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'op'; value: '||' | '&&' | '==' | '!=' | '>=' | '<=' | '>' | '<' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' }
  | { type: 'pipe' }
  | { type: 'dot' }
  | { type: 'lbracket' }
  | { type: 'rbracket' };

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type OperatorValue = Extract<Token, { type: 'op' }>['value'];
type PunctuationType = 'lparen' | 'rparen' | 'comma' | 'pipe' | 'dot' | 'lbracket' | 'rbracket';

/** Two-character operators — must be checked before single-char. */
const TWO_CHAR_OPERATORS: ReadonlySet<string> = new Set(['||', '&&', '==', '!=', '>=', '<=']);

const PUNCTUATION: Record<string, PunctuationType> = {
  '(': 'lparen',
  ')': 'rparen',
  ',': 'comma',
  '|': 'pipe',
  '.': 'dot',
  '[': 'lbracket',
  ']': 'rbracket',
};

/** One token plus the input index right after it. */
interface Scanned {
  token: Token;
  next: number;
}

/** Quoted string — double or single quotes, backslash escapes. `start` is the opening quote. */
function scanString(input: string, start: number): Scanned {
  const quote = input[start];
  let i = start + 1;
  let str = '';
  while (i < input.length && input[i] !== quote) {
    if (input[i] === '\\' && i + 1 < input.length) i++;
    str += input[i];
    i++;
  }
  if (i >= input.length) throw new Error(`Unterminated string literal in filter: ${input}`);
  return { token: { type: 'string', value: str }, next: i + 1 }; // skip closing quote
}

/** Number — ASCII digits, parsed as integer. */
function scanNumber(input: string, start: number): Scanned {
  let i = start;
  let num = '';
  while (i < input.length && input[i]! >= '0' && input[i]! <= '9') {
    num += input[i];
    i++;
  }
  return { token: { type: 'number', value: Number.parseInt(num, 10) }, next: i };
}

/** Identifier — ASCII letters/underscore/$/digits + Cyrillic; $ allowed for $N capture refs. */
function scanIdentifier(input: string, start: number): Scanned {
  let i = start;
  let ident = '';
  while (i < input.length && /[a-zA-Z0-9_$а-яёА-ЯЁ]/.test(input[i]!)) {
    ident += input[i];
    i++;
  }
  if (ident === 'true') return { token: { type: 'bool', value: true }, next: i };
  if (ident === 'false') return { token: { type: 'bool', value: false }, next: i };
  return { token: { type: 'ident', value: ident }, next: i };
}

/** Scan the (non-whitespace) token that starts at `i`. */
function scanToken(input: string, i: number): Scanned {
  const ch = input[i]!;

  const two = input.slice(i, i + 2);
  if (TWO_CHAR_OPERATORS.has(two)) return { token: { type: 'op', value: two as OperatorValue }, next: i + 2 };

  if (ch === '>' || ch === '<') return { token: { type: 'op', value: ch }, next: i + 1 };

  const punctuation = PUNCTUATION[ch];
  if (punctuation !== undefined) return { token: { type: punctuation }, next: i + 1 };

  if (ch === '"' || ch === "'") return scanString(input, i);
  if (ch >= '0' && ch <= '9') return scanNumber(input, i);
  if (/[a-zA-Z_$а-яёА-ЯЁ]/.test(ch)) return scanIdentifier(input, i);

  throw new Error(`Unexpected character '${ch}' in filter: ${input}`);
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    // Whitespace — silently skip
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    const { token, next } = scanToken(input, i);
    tokens.push(token);
    i = next;
  }

  return tokens;
}
