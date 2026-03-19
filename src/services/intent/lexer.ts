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

    // Two-character operators — must be checked before single-char
    const two = input.slice(i, i + 2);
    if (two === '||' || two === '&&' || two === '==' || two === '!=' || two === '>=' || two === '<=') {
      tokens.push({ type: 'op', value: two as '||' | '&&' | '==' | '!=' | '>=' | '<=' });
      i += 2;
      continue;
    }

    // Single-character operators
    if (ch === '>' || ch === '<') {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    // Single-character punctuation
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
    if (ch === '.') {
      tokens.push({ type: 'dot' });
      i++;
      continue;
    }
    if (ch === '[') {
      tokens.push({ type: 'lbracket' });
      i++;
      continue;
    }
    if (ch === ']') {
      tokens.push({ type: 'rbracket' });
      i++;
      continue;
    }

    // Quoted string — double or single quotes, backslash escapes
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
      i++; // skip closing quote
      tokens.push({ type: 'string', value: str });
      continue;
    }

    // Number — ASCII digits, parsed as integer
    if (ch >= '0' && ch <= '9') {
      let num = '';
      while (i < input.length && input[i]! >= '0' && input[i]! <= '9') {
        num += input[i];
        i++;
      }
      tokens.push({ type: 'number', value: Number.parseInt(num, 10) });
      continue;
    }

    // Identifier — ASCII letters/underscore/$/digits + Cyrillic; $ allowed for $N capture refs
    if (/[a-zA-Z_$а-яёА-ЯЁ]/.test(ch)) {
      let ident = '';
      while (i < input.length && /[a-zA-Z0-9_$а-яёА-ЯЁ]/.test(input[i]!)) {
        ident += input[i];
        i++;
      }
      if (ident === 'true') {
        tokens.push({ type: 'bool', value: true });
      } else if (ident === 'false') {
        tokens.push({ type: 'bool', value: false });
      } else {
        tokens.push({ type: 'ident', value: ident });
      }
      continue;
    }

    throw new Error(`Unexpected character '${ch}' in filter: ${input}`);
  }

  return tokens;
}
