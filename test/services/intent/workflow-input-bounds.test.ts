import { describe, expect, test } from 'bun:test';
import { isBoundedJson, WORKFLOW_LIMITS } from '../../../src/services/intent/workflow-input.ts';

const nest = (depth: number): unknown => {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
};

describe('isBoundedJson: scalars', () => {
  test('JSON scalars pass', () => {
    for (const value of [null, true, false, 0, -1.5, '', 'text']) expect(isBoundedJson(value)).toBe(true);
  });

  test('non-JSON scalars are rejected', () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 10n, Symbol('x'), () => 1]) {
      expect(isBoundedJson(value)).toBe(false);
    }
  });

  test('a string over the per-string limit is rejected, at the limit it passes', () => {
    expect(isBoundedJson('x'.repeat(WORKFLOW_LIMITS.stringChars))).toBe(true);
    expect(isBoundedJson('x'.repeat(WORKFLOW_LIMITS.stringChars + 1))).toBe(false);
  });

  test('total characters across strings and keys are bounded', () => {
    expect(isBoundedJson(Array.from({ length: 5 }, () => 'y'.repeat(30000)))).toBe(false);
    const keyed = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${'k'.repeat(5000)}${i}`, 1]));
    expect(isBoundedJson(keyed)).toBe(false);
  });
});

describe('isBoundedJson: containers', () => {
  test('plain nested data passes', () => {
    expect(isBoundedJson({ a: [{ b: { c: [1, 2, 3, 'x'] } }] })).toBe(true);
    expect(isBoundedJson({})).toBe(true);
    expect(isBoundedJson([])).toBe(true);
    const nullPrototype = Object.create(null);
    nullPrototype.a = 1;
    expect(isBoundedJson(nullPrototype)).toBe(true);
  });

  test('depth and node counts are bounded', () => {
    expect(isBoundedJson(nest(WORKFLOW_LIMITS.depth))).toBe(true);
    expect(isBoundedJson(nest(WORKFLOW_LIMITS.depth + 1))).toBe(false);
    expect(isBoundedJson(Array.from({ length: 4000 }, (_, i) => i))).toBe(true);
    expect(isBoundedJson(Array.from({ length: 4100 }, (_, i) => i))).toBe(false);
  });

  test('a value shared by two parents is fine, a cycle is not', () => {
    const shared = { s: 1 };
    expect(isBoundedJson([shared, shared])).toBe(true);
    const cyclic: { [key: string]: unknown } = { a: 1 };
    cyclic.self = cyclic;
    expect(isBoundedJson(cyclic)).toBe(false);
  });

  test('class instances, built-ins and symbol keys are rejected', () => {
    class Box {
      x = 1;
    }
    expect(isBoundedJson(new Box())).toBe(false);
    expect(isBoundedJson(new Date())).toBe(false);
    expect(isBoundedJson(new Map())).toBe(false);
    expect(isBoundedJson({ [Symbol('k')]: 1 })).toBe(false);
  });

  test('accessors and non-enumerable properties are rejected without being read', () => {
    let reads = 0;
    const withGetter = {
      get x() {
        reads++;
        return 1;
      },
    };
    expect(isBoundedJson(withGetter)).toBe(false);
    expect(reads).toBe(0);
    expect(isBoundedJson(Object.defineProperty({}, 'hidden', { value: 1, enumerable: false }))).toBe(false);
  });

  test('prototype-reaching keys are rejected', () => {
    expect(isBoundedJson(JSON.parse('{"__proto__":{"a":1}}'))).toBe(false);
    expect(isBoundedJson({ constructor: 1 })).toBe(false);
  });

  test('sparse arrays and arrays with named properties are rejected', () => {
    const sparse: unknown[] = [];
    sparse[5] = 1;
    expect(isBoundedJson(sparse)).toBe(false);
    const named: unknown[] & { extra?: number } = [1, 2];
    named.extra = 1;
    expect(isBoundedJson(named)).toBe(false);
  });
});
