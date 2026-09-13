import { describe, expect, test } from 'bun:test';
import { checkPatternSafety } from '../../../src/services/intent/regex-safety.ts';

describe('checkPatternSafety', () => {
  test('accepts a normal anchored pattern with a capture group', () => {
    const result = checkPatternSafety('^(?:найди|search)\\s+(.+)$');
    expect(result).toEqual({ safe: true });
  });

  test('rejects nested quantifier (a+)+', () => {
    const result = checkPatternSafety('^(a+)+$');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/nested|backtracking/);
  });

  test('rejects nested quantifier (a|a)+ via runtime probe (no static nesting)', () => {
    const result = checkPatternSafety('^(a|a)+$');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/backtracking/);
  });

  test('rejects ambiguous alternation (a|aa)+ via runtime probe', () => {
    const result = checkPatternSafety('^(a|aa)+$');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/backtracking/);
  });

  test('rejects nested quantifier (.*)*', () => {
    const result = checkPatternSafety('^(.*)*$');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/nested|backtracking/);
  });

  test('rejects nested quantifier (.+)+', () => {
    const result = checkPatternSafety('(.+)+');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/nested|backtracking/);
  });

  test('rejects nested quantifier ([a-zA-Z]+)*', () => {
    const result = checkPatternSafety('([a-zA-Z]+)*');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/nested|backtracking/);
  });

  test('rejects nested quantifier (a+)+b', () => {
    const result = checkPatternSafety('(a+)+b');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/nested|backtracking/);
  });

  test('rejects a syntactically invalid pattern', () => {
    const result = checkPatternSafety('(abc');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/does not compile/);
  });

  test('rejects an over-length pattern', () => {
    const result = checkPatternSafety(`^${'a'.repeat(400)}$`);
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/too long/);
  });

  test('accepts bounded repetition {n,m}', () => {
    const result = checkPatternSafety('^\\d{3,5}-\\w{2,10}$');
    expect(result).toEqual({ safe: true });
  });

  test('accepts a single top-level (non-nested) quantifier', () => {
    const result = checkPatternSafety('^(?:напомни|remind)\\s+.+$');
    expect(result).toEqual({ safe: true });
  });

  test('accepts the production "search" intent pattern', () => {
    const result = checkPatternSafety('^(?:найди|search)\\s+(.+)$');
    expect(result).toEqual({ safe: true });
  });

  test('accepts the production "what time in" intent pattern', () => {
    const result = checkPatternSafety('^(?:который час|сколько времени|время|what time)\\s+(?:в|in)\\s+(.+)$');
    expect(result).toEqual({ safe: true });
  });

  test('accepts the production "find" intent pattern', () => {
    const result = checkPatternSafety('^(?:найди|поиск|search|find)\\s+(.+)$');
    expect(result).toEqual({ safe: true });
  });

  test('does not mistake a literal +/*/() inside a character class for a quantifier', () => {
    const result = checkPatternSafety('^(foo[+*()]bar)+$');
    expect(result).toEqual({ safe: true });
  });
});
