import { describe, expect, test } from 'bun:test';
import { applyFilters, parseFilterChain } from '../../../src/services/intent/filter-parser.ts';

// ---------------------------------------------------------------------------
// Lexer / parser
// ---------------------------------------------------------------------------

describe('parseFilterChain', () => {
  test('bare ident filter', () => {
    expect(parseFilterChain('upper')).toEqual([{ name: 'upper', args: [] }]);
  });

  test('function call with number arg', () => {
    expect(parseFilterChain('pad(2)')).toEqual([{ name: 'pad', args: [2] }]);
  });

  test('function call with quoted string arg', () => {
    expect(parseFilterChain('default("нет")')).toEqual([{ name: 'default', args: ['нет'] }]);
  });

  test('function call with single-quoted string arg', () => {
    expect(parseFilterChain("default('нет')")).toEqual([{ name: 'default', args: ['нет'] }]);
  });

  test('chain of bare filters', () => {
    expect(parseFilterChain('trim|upper')).toEqual([
      { name: 'trim', args: [] },
      { name: 'upper', args: [] },
    ]);
  });

  test('chain mixing function and bare', () => {
    expect(parseFilterChain('trim|pad(3)')).toEqual([
      { name: 'trim', args: [] },
      { name: 'pad', args: [3] },
    ]);
  });

  test('function with multiple args', () => {
    expect(parseFilterChain('replace("a","b")')).toEqual([{ name: 'replace', args: ['a', 'b'] }]);
  });

  test('function with no args (empty parens)', () => {
    expect(parseFilterChain('trim()')).toEqual([{ name: 'trim', args: [] }]);
  });

  test('throws on unclosed paren', () => {
    expect(() => parseFilterChain('pad(2')).toThrow();
  });

  test('throws on missing paren content after open', () => {
    expect(() => parseFilterChain('pad(')).toThrow();
  });

  test('throws on empty input', () => {
    expect(() => parseFilterChain('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Filter executor
// ---------------------------------------------------------------------------

describe('applyFilters', () => {
  test('pad(2) zero-pads single digit', () => {
    expect(applyFilters('9', parseFilterChain('pad(2)'))).toBe('09');
  });

  test('pad(2) leaves already wide value unchanged', () => {
    expect(applyFilters('23', parseFilterChain('pad(2)'))).toBe('23');
  });

  test('pad(4) pads to given width', () => {
    expect(applyFilters('7', parseFilterChain('pad(4)'))).toBe('0007');
  });

  test('upper uppercases', () => {
    expect(applyFilters('hello', parseFilterChain('upper'))).toBe('HELLO');
  });

  test('lower lowercases', () => {
    expect(applyFilters('HELLO', parseFilterChain('lower'))).toBe('hello');
  });

  test('trim strips whitespace', () => {
    expect(applyFilters('  hi  ', parseFilterChain('trim'))).toBe('hi');
  });

  test('default(val) returns val when value is undefined', () => {
    expect(applyFilters(undefined, parseFilterChain('default("нет")'))).toBe('нет');
  });

  test('default(val) returns original value when defined', () => {
    expect(applyFilters('есть', parseFilterChain('default("нет")'))).toBe('есть');
  });

  test('default(val) treats empty string as empty, not undefined', () => {
    expect(applyFilters('', parseFilterChain('default("нет")'))).toBe('');
  });

  test('truncate(5) truncates long string with ellipsis', () => {
    expect(applyFilters('hello world', parseFilterChain('truncate(5)'))).toBe('hello…');
  });

  test('truncate(5) leaves short string unchanged', () => {
    expect(applyFilters('hi', parseFilterChain('truncate(5)'))).toBe('hi');
  });

  test('truncate(5) exact length — no ellipsis', () => {
    expect(applyFilters('hello', parseFilterChain('truncate(5)'))).toBe('hello');
  });

  test('chain: trim|upper', () => {
    expect(applyFilters('  hello  ', parseFilterChain('trim|upper'))).toBe('HELLO');
  });

  test('chain: default then upper — undefined gets default then uppercased', () => {
    expect(applyFilters(undefined, parseFilterChain('default("нет")|upper'))).toBe('НЕТ');
  });

  test('unknown filter throws', () => {
    expect(() => applyFilters('x', parseFilterChain('bogus(1)'))).toThrow();
  });

  test('returns string from non-string input', () => {
    expect(applyFilters(42, parseFilterChain('pad(4)'))).toBe('0042');
  });

  test('add(n) adds number to value', () => {
    expect(applyFilters('8', parseFilterChain('add(12)'))).toBe('20');
    expect(applyFilters(5, parseFilterChain('add(3)'))).toBe('8');
  });

  test('sub(n) subtracts from value', () => {
    expect(applyFilters('20', parseFilterChain('sub(12)'))).toBe('8');
    expect(applyFilters(10, parseFilterChain('sub(3)'))).toBe('7');
  });

  test('mul(n) multiplies value', () => {
    expect(applyFilters('3', parseFilterChain('mul(4)'))).toBe('12');
  });

  test('div(n) integer-divides value', () => {
    expect(applyFilters('10', parseFilterChain('div(3)'))).toBe('3');
    expect(applyFilters(12, parseFilterChain('div(4)'))).toBe('3');
  });

  test('div(0) throws', () => {
    expect(() => applyFilters(10, parseFilterChain('div(0)'))).toThrow();
  });

  test('chain: add(12)|pad(2) — AM/PM to 24h hour with zero-padding', () => {
    expect(applyFilters('8', parseFilterChain('add(12)|pad(2)'))).toBe('20');
    expect(applyFilters('9', parseFilterChain('add(12)|pad(2)'))).toBe('21');
  });

  test('eq("match","a","b") returns a when value equals match', () => {
    expect(applyFilters('ru', parseFilterChain('eq("ru","en","ru")'))).toBe('en');
  });

  test('eq("match","a","b") returns b when value does not equal match', () => {
    expect(applyFilters('en', parseFilterChain('eq("ru","en","ru")'))).toBe('ru');
  });

  test('eq coerces value to string for comparison', () => {
    expect(applyFilters(42, parseFilterChain('eq("42","yes","no")'))).toBe('yes');
  });

  test('eq is chainable', () => {
    expect(applyFilters('ru', parseFilterChain('eq("ru","en","ru")|upper'))).toBe('EN');
  });

  test('date("HH:mm") formats ISO string with timezone offset correctly', () => {
    // Must show 16:29 (Moscow local), not 13:29 (UTC) regardless of system timezone
    expect(applyFilters('2026-04-02T16:29:00+03:00', parseFilterChain('date("HH:mm")'))).toBe('16:29');
  });

  test('date("h:mm a") formats ISO string with timezone offset (12h)', () => {
    expect(applyFilters('2026-04-02T16:29:00+03:00', parseFilterChain('date("h:mm a")'))).toBe('4:29 PM');
  });

  test('date("yyyy-MM-dd") formats ISO date-only string', () => {
    expect(applyFilters('2026-04-02', parseFilterChain('date("yyyy-MM-dd")'))).toBe('2026-04-02');
  });

  test('date("dd.MM") formats date part', () => {
    expect(applyFilters('2026-04-02T16:29:00+03:00', parseFilterChain('date("dd.MM")'))).toBe('02.04');
  });

  test('date with negative offset', () => {
    expect(applyFilters('2026-04-02T08:30:00-05:00', parseFilterChain('date("HH:mm")'))).toBe('08:30');
  });

  test('date with UTC (Z suffix) treats as UTC', () => {
    expect(applyFilters('2026-04-02T13:29:00Z', parseFilterChain('date("HH:mm")'))).toBe('13:29');
  });

  test('date returns empty string for null/undefined', () => {
    expect(applyFilters(null, parseFilterChain('date("HH:mm")'))).toBe('');
    expect(applyFilters(undefined, parseFilterChain('date("HH:mm")'))).toBe('');
  });

  test('date falls back to string on invalid input', () => {
    expect(applyFilters('not-a-date', parseFilterChain('date("HH:mm")'))).toBe('not-a-date');
  });
});
