import { describe, expect, test } from 'bun:test';
import { tokenize } from '../../../src/services/intent/lexer.ts';

describe('tokenize: token classes', () => {
  test('two-character operators win over their one-character prefixes', () => {
    expect(tokenize('a==1&&b!=2||c>=3 d<=4')).toEqual([
      { type: 'ident', value: 'a' },
      { type: 'op', value: '==' },
      { type: 'number', value: 1 },
      { type: 'op', value: '&&' },
      { type: 'ident', value: 'b' },
      { type: 'op', value: '!=' },
      { type: 'number', value: 2 },
      { type: 'op', value: '||' },
      { type: 'ident', value: 'c' },
      { type: 'op', value: '>=' },
      { type: 'number', value: 3 },
      { type: 'ident', value: 'd' },
      { type: 'op', value: '<=' },
      { type: 'number', value: 4 },
    ]);
    expect(tokenize('> <')).toEqual([
      { type: 'op', value: '>' },
      { type: 'op', value: '<' },
    ]);
  });

  test('a lone pipe is punctuation, a double pipe an operator', () => {
    expect(tokenize('|')).toEqual([{ type: 'pipe' }]);
    expect(tokenize('||')).toEqual([{ type: 'op', value: '||' }]);
    expect(tokenize('|a')).toEqual([{ type: 'pipe' }, { type: 'ident', value: 'a' }]);
  });

  test('punctuation', () => {
    expect(tokenize('().,[]')).toEqual([
      { type: 'lparen' },
      { type: 'rparen' },
      { type: 'dot' },
      { type: 'comma' },
      { type: 'lbracket' },
      { type: 'rbracket' },
    ]);
  });

  test('whitespace (space, tab) is skipped', () => {
    expect(tokenize('\t\ta\t ')).toEqual([{ type: 'ident', value: 'a' }]);
    expect(tokenize('')).toEqual([]);
  });

  test('numbers are ASCII digit runs parsed as integers, identifiers start with a letter', () => {
    expect(tokenize('007')).toEqual([{ type: 'number', value: 7 }]);
    expect(tokenize('12abc')).toEqual([
      { type: 'number', value: 12 },
      { type: 'ident', value: 'abc' },
    ]);
  });

  test('identifiers allow $, underscore, digits and Cyrillic', () => {
    expect(tokenize('$12 привет_мир A9_$ ёЁ')).toEqual([
      { type: 'ident', value: '$12' },
      { type: 'ident', value: 'привет_мир' },
      { type: 'ident', value: 'A9_$' },
      { type: 'ident', value: 'ёЁ' },
    ]);
  });

  test('true and false are keywords only as whole identifiers', () => {
    expect(tokenize('true false truefalse')).toEqual([
      { type: 'bool', value: true },
      { type: 'bool', value: false },
      { type: 'ident', value: 'truefalse' },
    ]);
  });
});

describe('tokenize: strings', () => {
  test('single and double quotes with backslash escapes', () => {
    expect(tokenize(`"a\\"b" 'c\\'d' "x\\\\y"`)).toEqual([
      { type: 'string', value: 'a"b' },
      { type: 'string', value: "c'd" },
      { type: 'string', value: 'x\\y' },
    ]);
    expect(tokenize('""')).toEqual([{ type: 'string', value: '' }]);
  });

  test('the other quote character is ordinary text', () => {
    expect(tokenize(`"it's"`)).toEqual([{ type: 'string', value: "it's" }]);
  });

  test('an unterminated string, including one ending in a lone backslash, is rejected', () => {
    expect(() => tokenize('"abc')).toThrow('Unterminated string literal in filter: "abc');
    expect(() => tokenize('"a\\')).toThrow('Unterminated string literal');
    expect(() => tokenize('"a\\"')).toThrow('Unterminated string literal');
  });
});

describe('tokenize: rejected input', () => {
  test('unknown characters name the character and the input', () => {
    expect(() => tokenize('a # b')).toThrow("Unexpected character '#' in filter: a # b");
    for (const ch of ['@', '!', '=', '&', '-', '+']) {
      expect(() => tokenize(ch)).toThrow(`Unexpected character '${ch}'`);
    }
  });

  test('a decimal point splits a number, it is not part of it', () => {
    expect(tokenize('1.5')).toEqual([{ type: 'number', value: 1 }, { type: 'dot' }, { type: 'number', value: 5 }]);
  });
});
