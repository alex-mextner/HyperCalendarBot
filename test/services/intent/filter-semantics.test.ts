import { describe, expect, test } from 'bun:test';
import { applyFilters, KNOWN_FILTERS, parseFilterChain } from '../../../src/services/intent/filter-parser.ts';

const apply = (value: unknown, chain: string): string => applyFilters(value, parseFilterChain(chain));

describe('applyFilters: every filter', () => {
  test('KNOWN_FILTERS lists exactly the supported filters', () => {
    expect([...KNOWN_FILTERS]).toEqual([
      'pad',
      'upper',
      'lower',
      'trim',
      'truncate',
      'default',
      'replace',
      'date',
      'ternary',
      'eq',
      'add',
      'sub',
      'mul',
      'div',
    ]);
  });

  test('inherited object property names are unknown filters, not lookups', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(() => applyFilters('a', [{ name, args: [] }])).toThrow(`Unknown filter: ${name}`);
    }
  });

  test('null and undefined render as empty text for text filters', () => {
    for (const chain of ['upper', 'lower', 'trim', 'replace("a","b")', 'pad(3)', 'truncate(2)']) {
      expect(apply(undefined, chain)).toBe(chain === 'pad(3)' ? '000' : '');
      expect(apply(null, chain)).toBe(chain === 'pad(3)' ? '000' : '');
    }
  });

  test('pad, upper, lower, trim', () => {
    expect(apply(7, 'pad(3)')).toBe('007');
    expect(apply('12345', 'pad(3)')).toBe('12345');
    expect(apply('Ab', 'upper')).toBe('AB');
    expect(apply('Ab', 'lower')).toBe('ab');
    expect(apply('  x ', 'trim')).toBe('x');
  });

  test('truncate keeps short text and ellipsises long text', () => {
    expect(apply('abcdef', 'truncate(3)')).toBe('abc…');
    expect(apply('abc', 'truncate(3)')).toBe('abc');
    expect(apply('abc', 'truncate(0)')).toBe('…');
  });

  test('default replaces only null/undefined, not empty or falsy values', () => {
    expect(apply(undefined, 'default("zz")')).toBe('zz');
    expect(apply(null, 'default("zz")')).toBe('zz');
    expect(apply('', 'default("zz")')).toBe('');
    expect(apply(0, 'default("zz")')).toBe('0');
    expect(apply(false, 'default("zz")')).toBe('false');
    expect(apply(undefined, 'default(5)')).toBe('5');
  });

  test('replace replaces every occurrence and treats an empty source as empty text', () => {
    expect(apply('banana', 'replace("a","o")')).toBe('bonono');
    expect(apply('abc', 'replace("b")')).toBe('ac');
    expect(apply('', 'replace("","x")')).toBe('x');
    expect(apply(undefined, 'replace("","x")')).toBe('');
  });

  test('ternary tests truthiness, eq compares the string form', () => {
    expect(apply(1, 'ternary("y","n")')).toBe('y');
    expect(apply(0, 'ternary("y","n")')).toBe('n');
    expect(apply('', 'ternary("y","n")')).toBe('n');
    expect(apply(undefined, 'ternary("y")')).toBe('');
    expect(apply(5, 'eq(5,"Y","N")')).toBe('Y');
    expect(apply('abc', 'eq("abc","Y","N")')).toBe('Y');
    expect(apply(undefined, 'eq("undefined","Y","N")')).toBe('Y');
    expect(apply('x', 'eq')).toBe('');
  });

  test('arithmetic treats null/undefined as zero and div floors', () => {
    expect(apply(undefined, 'add(2)')).toBe('2');
    expect(apply(null, 'sub(2)')).toBe('-2');
    expect(apply('7', 'mul(3)')).toBe('21');
    expect(apply(7, 'div(2)')).toBe('3');
    expect(apply(-7, 'div(2)')).toBe('-4');
    expect(apply(5, 'add(1)|mul(2)|sub(3)')).toBe('9');
  });

  test('numeric filters reject a missing or non-numeric argument by name', () => {
    for (const name of ['pad', 'truncate', 'add', 'sub', 'mul', 'div']) {
      expect(() => apply(1, name)).toThrow(`${name}() requires a numeric argument`);
      expect(() => apply(1, `${name}("x")`)).toThrow(`${name}() requires a numeric argument`);
    }
    expect(() => apply(1, 'div(0)')).toThrow('div() by zero');
  });

  test('an unknown name fails before any filter runs', () => {
    expect(() => apply('a', 'upper|nope')).toThrow('Unknown filter: nope');
  });

  test('empty chain stringifies the value', () => {
    expect(applyFilters(undefined, [])).toBe('');
    expect(applyFilters(12, [])).toBe('12');
  });
});

describe('date filter', () => {
  test('explicit offsets keep the original wall-clock time whatever the system zone', () => {
    expect(apply('2024-03-05T10:20:30+03:00', 'date("yyyy-MM-dd HH:mm")')).toBe('2024-03-05 10:20');
    expect(apply('2024-03-05T10:20:30-05:30', 'date("HH:mm")')).toBe('10:20');
    expect(apply('2024-03-05T10:20:30Z', 'date("HH:mm")')).toBe('10:20');
  });

  test('offset-less text is formatted as parsed, default format is yyyy-MM-dd', () => {
    expect(apply('2024-03-05T10:20:30', 'date("HH:mm")')).toBe('10:20');
    expect(apply('2024-03-05', 'date')).toBe('2024-03-05');
  });

  test('null renders empty and an unparseable value falls back to its text', () => {
    expect(apply(null, 'date')).toBe('');
    expect(apply(undefined, 'date')).toBe('');
    expect(apply('garbage', 'date')).toBe('garbage');
  });
});
