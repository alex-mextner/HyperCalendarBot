import { describe, expect, test } from 'bun:test';
import { evaluate } from '../../../src/services/intent/expression-evaluator.ts';

describe('evaluate', () => {
  test('simple equality', () => {
    expect(evaluate('results.length == 0', { results: [] })).toBe(true);
    expect(evaluate('results.length == 1', { results: [] })).toBe(false);
  });

  test('inequality', () => {
    expect(evaluate('results.length != 0', { results: [1] })).toBe(true);
    expect(evaluate('results.length != 0', { results: [] })).toBe(false);
  });

  test('greater than / less than', () => {
    expect(evaluate('results.length > 0', { results: [1] })).toBe(true);
    expect(evaluate('results.length > 0', { results: [] })).toBe(false);
    expect(evaluate('results.length < 5', { results: [1, 2] })).toBe(true);
    expect(evaluate('count >= 3', { count: 3 })).toBe(true);
    expect(evaluate('count <= 2', { count: 3 })).toBe(false);
  });

  test('boolean operators', () => {
    expect(evaluate('a && b', { a: true, b: true })).toBe(true);
    expect(evaluate('a && b', { a: true, b: false })).toBe(false);
    expect(evaluate('a || b', { a: false, b: true })).toBe(true);
    expect(evaluate('a || b', { a: false, b: false })).toBe(false);
  });

  test('combined with &&/||', () => {
    expect(evaluate('x > 0 && y > 0', { x: 1, y: 2 })).toBe(true);
    expect(evaluate('x > 0 || y > 0', { x: 0, y: 2 })).toBe(true);
  });

  test('nested property access', () => {
    expect(evaluate('results.length > 1', { results: [1, 2] })).toBe(true);
  });

  test('array index access', () => {
    expect(evaluate('results[0].id == 42', { results: [{ id: 42 }] })).toBe(true);
  });

  test('string comparison', () => {
    expect(evaluate('status == "pending"', { status: 'pending' })).toBe(true);
    expect(evaluate('status == "done"', { status: 'pending' })).toBe(false);
  });

  test('boolean literals', () => {
    expect(evaluate('active == true', { active: true })).toBe(true);
    expect(evaluate('active == false', { active: false })).toBe(true);
  });

  test('throws on dangerous property access', () => {
    expect(() => evaluate('__proto__.x == 1', {})).toThrow();
    expect(() => evaluate('constructor.name == "Object"', {})).toThrow();
  });

  test('throws on invalid expression', () => {
    expect(() => evaluate('', {})).toThrow();
    expect(() => evaluate('&&', {})).toThrow();
  });

  test('comparison without operator returns truthy/falsy', () => {
    expect(evaluate('active', { active: true })).toBe(true);
    expect(evaluate('active', { active: false })).toBe(false);
  });

  test('$N identifier syntax — captures accessible by $1, $2', () => {
    expect(evaluate('$1 > 10', { $1: 22 })).toBe(true);
    expect(evaluate('$1 == 5', { $1: 5 })).toBe(true);
    expect(evaluate('$2 != $1', { $1: 3, $2: 7 })).toBe(true);
  });

  test('function call with literal arg', () => {
    expect(evaluate('fn(22)', { fn: (n: unknown) => Number(n) > 10 })).toBe(true);
    expect(evaluate('fn(5)', { fn: (n: unknown) => Number(n) > 10 })).toBe(false);
  });

  test('function call with identifier arg — looks up in context', () => {
    expect(evaluate('fn($1)', { fn: (n: unknown) => Number(n) > 10, $1: 22 })).toBe(true);
    expect(evaluate('fn(x)', { fn: (n: unknown) => Number(n) > 10, x: 5 })).toBe(false);
  });

  test('function call result usable in comparison', () => {
    expect(evaluate('fn(5) == true', { fn: (n: unknown) => Number(n) > 3 })).toBe(true);
    expect(evaluate('fn(2) == false', { fn: (n: unknown) => Number(n) > 3 })).toBe(true);
  });

  test('user.language in when condition — bilingual workflow branching', () => {
    expect(evaluate('user.language == "ru"', { user: { id: 1, language: 'ru', timezone: 'UTC' } })).toBe(true);
    expect(evaluate('user.language != "ru"', { user: { id: 1, language: 'en', timezone: 'UTC' } })).toBe(true);
    expect(evaluate('user.language == "ru"', { user: { id: 1, language: 'en', timezone: 'UTC' } })).toBe(false);
  });
});
