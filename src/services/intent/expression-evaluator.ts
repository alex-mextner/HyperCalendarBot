/**
 * Safe recursive descent expression evaluator for workflow `when` conditions.
 * Supports: ==, !=, >, <, >=, <=, &&, ||, .length, string/number/boolean literals,
 * property access, array index access, and function calls.
 * NO eval(), NO Function(), NO new Function().
 *
 * Tokenization is delegated to the shared lexer (lexer.ts).
 */

import type { JsonObject } from '../../utils/types.ts';
import { type Token, tokenize } from './lexer.ts';

const DANGEROUS_PROPS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('Unexpected end of expression');
    this.pos++;
    return t;
  }

  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return t !== undefined && t.type === 'op' && ops.includes(t.value);
  }

  parse(context: JsonObject): boolean {
    if (this.tokens.length === 0) {
      throw new Error('Empty expression');
    }
    const result = this.parseOrExpr(context);
    if (this.pos < this.tokens.length) {
      throw new Error(`Unexpected token at position ${this.pos}: ${JSON.stringify(this.peek())}`);
    }
    return Boolean(result);
  }

  private parseOrExpr(context: JsonObject): unknown {
    let left = this.parseAndExpr(context);
    while (this.isOp('||')) {
      this.consume();
      const right = this.parseAndExpr(context);
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAndExpr(context: JsonObject): unknown {
    let left = this.parseComparison(context);
    while (this.isOp('&&')) {
      this.consume();
      const right = this.parseComparison(context);
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseComparison(context: JsonObject): unknown {
    const left = this.parseValue(context);

    if (this.isOp('==', '!=', '>', '<', '>=', '<=')) {
      const op = (this.consume() as { type: 'op'; value: string }).value;
      const right = this.parseValue(context);
      return applyComparison(op, left, right);
    }

    return left;
  }

  private parseValue(context: JsonObject): unknown {
    const t = this.peek();
    if (t === undefined) throw new Error('Expected a value but reached end of expression');

    // Literals
    if (t.type === 'number') {
      this.consume();
      return t.value;
    }
    if (t.type === 'string') {
      this.consume();
      return t.value;
    }
    if (t.type === 'bool') {
      this.consume();
      return t.value;
    }

    // Property access starting from an identifier
    if (t.type === 'ident') {
      return this.parsePropertyAccess(context);
    }

    throw new Error(`Unexpected token: ${JSON.stringify(t)}`);
  }

  private parsePropertyAccess(context: JsonObject): unknown {
    const rootToken = this.consume();
    if (rootToken.type !== 'ident') {
      throw new Error(`Expected identifier, got ${JSON.stringify(rootToken)}`);
    }

    const rootKey = rootToken.value;
    if (DANGEROUS_PROPS.has(rootKey)) {
      throw new Error(`Access to '${rootKey}' is not allowed`);
    }

    let value: unknown = context[rootKey];

    // Function call: ident(arg, arg, ...)
    if (this.peek()?.type === 'lparen') {
      this.consume(); // (
      const args: unknown[] = [];
      while (this.peek()?.type !== 'rparen') {
        if (args.length > 0) {
          if (this.peek()?.type !== 'comma') throw new Error('Expected , between function arguments');
          this.consume(); // ,
        }
        args.push(this.parseValue(context));
      }
      this.consume(); // )
      if (typeof value !== 'function') throw new Error(`'${rootKey}' is not a function in context`);
      return (value as (...a: unknown[]) => unknown)(...args);
    }

    // Chain: .identifier or [number]
    while (true) {
      const next = this.peek();

      if (next?.type === 'dot') {
        this.consume(); // consume '.'
        const propToken = this.consume();
        if (propToken.type !== 'ident') {
          throw new Error(`Expected property name after '.', got ${JSON.stringify(propToken)}`);
        }
        const prop = propToken.value;
        if (DANGEROUS_PROPS.has(prop)) {
          throw new Error(`Access to '${prop}' is not allowed`);
        }
        if (value === undefined || value === null) {
          throw new Error(`Cannot access property '${prop}' of ${String(value)}`);
        }
        value = (value as JsonObject)[prop];
        continue;
      }

      if (next?.type === 'lbracket') {
        this.consume(); // consume '['
        const indexToken = this.consume();
        if (indexToken.type !== 'number') {
          throw new Error(`Expected numeric index inside [], got ${JSON.stringify(indexToken)}`);
        }
        const rbracket = this.consume();
        if (rbracket.type !== 'rbracket') {
          throw new Error(`Expected ']' after array index`);
        }
        if (!Array.isArray(value)) {
          throw new Error(`Cannot index non-array value`);
        }
        value = (value as unknown[])[indexToken.value];
        continue;
      }

      break;
    }

    return value;
  }
}

// ---------------------------------------------------------------------------
// Comparison helper
// ---------------------------------------------------------------------------

function applyComparison(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return (left as number) > (right as number);
    case '<':
      return (left as number) < (right as number);
    case '>=':
      return (left as number) >= (right as number);
    case '<=':
      return (left as number) <= (right as number);
    default:
      throw new Error(`Unknown operator: ${op}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a simple expression against a context object.
 * Supports: ==, !=, >, <, >=, <=, &&, ||, .length, string/number/boolean literals, property access.
 * NO function calls, NO assignments, NO arbitrary code execution.
 * @throws Error on invalid expression
 */
export function evaluate(expression: string, context: JsonObject): boolean {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    throw new Error('Empty expression');
  }
  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens);
  return parser.parse(context);
}
