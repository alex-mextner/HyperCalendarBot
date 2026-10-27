import { describe, expect, test } from 'bun:test';
import { evaluate } from '../../../src/services/intent/expression-evaluator.ts';

const ctx = {
  a: 1,
  b: 'x',
  arr: [1, 2, { k: 'v' }],
  o: { p: { q: 3 }, nul: null },
  nul: null,
  fn: (...args: unknown[]) => args.length,
  cnt: (list: unknown) => (Array.isArray(list) ? list.length : 0),
};

describe('evaluate: property and index chains', () => {
  test('dot and bracket access chain freely', () => {
    expect(evaluate('o.p.q == 3', ctx)).toBe(true);
    expect(evaluate('arr[2].k == "v"', ctx)).toBe(true);
    expect(evaluate('arr[ 0 ] == 1', ctx)).toBe(true);
    expect(evaluate('arr.length == 3', ctx)).toBe(true);
  });

  test('out-of-range index and missing members read as undefined', () => {
    expect(evaluate('arr[5] == 1', ctx)).toBe(false);
    expect(evaluate('o.zz == 1', ctx)).toBe(false);
  });

  test('reading through null or undefined names the property and value', () => {
    expect(() => evaluate('nul.x', ctx)).toThrow("Cannot access property 'x' of null");
    expect(() => evaluate('o.nul.x', ctx)).toThrow("Cannot access property 'x' of null");
    expect(() => evaluate('o.zz.y', ctx)).toThrow("Cannot access property 'y' of undefined");
  });

  test('prototype-reaching names are refused at the root and in the chain', () => {
    expect(() => evaluate('__proto__', ctx)).toThrow("Access to '__proto__' is not allowed");
    expect(() => evaluate('constructor', ctx)).toThrow("Access to 'constructor' is not allowed");
    expect(() => evaluate('a.__proto__', ctx)).toThrow("Access to '__proto__' is not allowed");
    expect(() => evaluate('o.constructor', ctx)).toThrow("Access to 'constructor' is not allowed");
  });

  test('malformed chains report what was expected', () => {
    expect(() => evaluate('a.1', ctx)).toThrow("Expected property name after '.'");
    expect(() => evaluate('arr[x]', ctx)).toThrow('Expected numeric index inside []');
    expect(() => evaluate('arr[0', ctx)).toThrow('Unexpected end of expression');
    expect(() => evaluate('a[0]', ctx)).toThrow('Cannot index non-array value');
    expect(() => evaluate('a.', ctx)).toThrow('Unexpected end of expression');
  });

  test('a bracket that is not closed by ] is rejected', () => {
    expect(() => evaluate('arr[0 1]', ctx)).toThrow("Expected ']' after array index");
  });
});

describe('evaluate: function calls', () => {
  test('arguments are values separated by commas', () => {
    expect(evaluate('fn(1,2,3) == 3', ctx)).toBe(true);
    expect(evaluate('fn() == 0', ctx)).toBe(true);
    expect(evaluate('cnt(arr) == 3', ctx)).toBe(true);
    expect(evaluate('fn(arr[0], o.p.q) == 2', ctx)).toBe(true);
  });

  test('missing comma, trailing comma and unclosed call are rejected', () => {
    expect(() => evaluate('fn(1 2)', ctx)).toThrow('Expected , between function arguments');
    expect(() => evaluate('fn(1,', ctx)).toThrow('Expected a value but reached end of expression');
    expect(() => evaluate('fn(', ctx)).toThrow('Expected a value but reached end of expression');
    expect(() => evaluate('fn(1', ctx)).toThrow('Expected , between function arguments');
  });

  test('calling a non-function names the callee', () => {
    expect(() => evaluate('a(1)', ctx)).toThrow("'a' is not a function in context");
  });

  test('a call result cannot be chained', () => {
    expect(() => evaluate('fn(1)(2)', ctx)).toThrow('Unexpected token at position');
  });
});
