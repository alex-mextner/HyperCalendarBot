import { describe, expect, test } from 'bun:test';
import { tokenize } from '../../../src/services/intent/lexer.ts';

describe('tokenize', () => {
  // ---------------------------------------------------------------------------
  // Empty / whitespace
  // ---------------------------------------------------------------------------

  test('empty string → no tokens', () => {
    expect(tokenize('')).toEqual([]);
  });

  test('whitespace only → no tokens', () => {
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('\t\t')).toEqual([]);
    expect(tokenize(' \t ')).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Punctuation tokens
  // ---------------------------------------------------------------------------

  test('pipe |', () => {
    expect(tokenize('|')).toEqual([{ type: 'pipe' }]);
  });

  test('lparen (', () => {
    expect(tokenize('(')).toEqual([{ type: 'lparen' }]);
  });

  test('rparen )', () => {
    expect(tokenize(')')).toEqual([{ type: 'rparen' }]);
  });

  test('comma ,', () => {
    expect(tokenize(',')).toEqual([{ type: 'comma' }]);
  });

  test('multiple punctuation tokens', () => {
    expect(tokenize('(,)')).toEqual([{ type: 'lparen' }, { type: 'comma' }, { type: 'rparen' }]);
  });

  // ---------------------------------------------------------------------------
  // Identifiers
  // ---------------------------------------------------------------------------

  test('simple ASCII identifier', () => {
    expect(tokenize('upper')).toEqual([{ type: 'ident', value: 'upper' }]);
  });

  test('identifier with underscore', () => {
    expect(tokenize('my_filter')).toEqual([{ type: 'ident', value: 'my_filter' }]);
  });

  test('identifier starting with underscore', () => {
    expect(tokenize('_private')).toEqual([{ type: 'ident', value: '_private' }]);
  });

  test('identifier with digits in the middle', () => {
    expect(tokenize('filter2go')).toEqual([{ type: 'ident', value: 'filter2go' }]);
  });

  test('Cyrillic identifier', () => {
    expect(tokenize('время')).toEqual([{ type: 'ident', value: 'время' }]);
  });

  test('Cyrillic with ё', () => {
    expect(tokenize('ёлка')).toEqual([{ type: 'ident', value: 'ёлка' }]);
  });

  test('mixed ASCII and Cyrillic identifier', () => {
    expect(tokenize('filter_время')).toEqual([{ type: 'ident', value: 'filter_время' }]);
  });

  test('uppercase ASCII identifier', () => {
    expect(tokenize('UPPER')).toEqual([{ type: 'ident', value: 'UPPER' }]);
  });

  // ---------------------------------------------------------------------------
  // Numbers
  // ---------------------------------------------------------------------------

  test('single digit', () => {
    expect(tokenize('0')).toEqual([{ type: 'number', value: 0 }]);
    expect(tokenize('9')).toEqual([{ type: 'number', value: 9 }]);
  });

  test('multi-digit number', () => {
    expect(tokenize('42')).toEqual([{ type: 'number', value: 42 }]);
    expect(tokenize('100')).toEqual([{ type: 'number', value: 100 }]);
  });

  test('zero', () => {
    expect(tokenize('0')).toEqual([{ type: 'number', value: 0 }]);
  });

  test('large number', () => {
    expect(tokenize('99999')).toEqual([{ type: 'number', value: 99999 }]);
  });

  // ---------------------------------------------------------------------------
  // Strings — double quotes
  // ---------------------------------------------------------------------------

  test('empty double-quoted string', () => {
    expect(tokenize('""')).toEqual([{ type: 'string', value: '' }]);
  });

  test('simple double-quoted string', () => {
    expect(tokenize('"hello"')).toEqual([{ type: 'string', value: 'hello' }]);
  });

  test('double-quoted string with spaces', () => {
    expect(tokenize('"hello world"')).toEqual([{ type: 'string', value: 'hello world' }]);
  });

  test('double-quoted Cyrillic string', () => {
    expect(tokenize('"нет"')).toEqual([{ type: 'string', value: 'нет' }]);
  });

  test('double-quoted string with escaped quote', () => {
    expect(tokenize('"say \\"hi\\""')).toEqual([{ type: 'string', value: 'say "hi"' }]);
  });

  test('double-quoted string with backslash escape', () => {
    expect(tokenize('"a\\\\b"')).toEqual([{ type: 'string', value: 'a\\b' }]);
  });

  // ---------------------------------------------------------------------------
  // Strings — single quotes
  // ---------------------------------------------------------------------------

  test('empty single-quoted string', () => {
    expect(tokenize("''")).toEqual([{ type: 'string', value: '' }]);
  });

  test('simple single-quoted string', () => {
    expect(tokenize("'hello'")).toEqual([{ type: 'string', value: 'hello' }]);
  });

  test('single-quoted Cyrillic string', () => {
    expect(tokenize("'нет'")).toEqual([{ type: 'string', value: 'нет' }]);
  });

  test('single-quoted string with escaped single quote', () => {
    expect(tokenize("'it\\'s'")).toEqual([{ type: 'string', value: "it's" }]);
  });

  test('double-quoted string can contain single quotes unescaped', () => {
    expect(tokenize('"it\'s"')).toEqual([{ type: 'string', value: "it's" }]);
  });

  test('single-quoted string can contain double quotes unescaped', () => {
    expect(tokenize('\'"hi"\'').map((t) => t)).toEqual([{ type: 'string', value: '"hi"' }]);
  });

  // ---------------------------------------------------------------------------
  // Whitespace handling
  // ---------------------------------------------------------------------------

  test('whitespace around tokens is ignored', () => {
    expect(tokenize('  upper  ')).toEqual([{ type: 'ident', value: 'upper' }]);
  });

  test('whitespace between tokens', () => {
    expect(tokenize('pad( 2 )')).toEqual([
      { type: 'ident', value: 'pad' },
      { type: 'lparen' },
      { type: 'number', value: 2 },
      { type: 'rparen' },
    ]);
  });

  test('tab whitespace is ignored', () => {
    expect(tokenize('\tupper\t')).toEqual([{ type: 'ident', value: 'upper' }]);
  });

  // ---------------------------------------------------------------------------
  // Compound expressions
  // ---------------------------------------------------------------------------

  test('bare filter name', () => {
    expect(tokenize('upper')).toEqual([{ type: 'ident', value: 'upper' }]);
  });

  test('filter with numeric arg', () => {
    expect(tokenize('pad(2)')).toEqual([
      { type: 'ident', value: 'pad' },
      { type: 'lparen' },
      { type: 'number', value: 2 },
      { type: 'rparen' },
    ]);
  });

  test('filter with string arg', () => {
    expect(tokenize('default("нет")')).toEqual([
      { type: 'ident', value: 'default' },
      { type: 'lparen' },
      { type: 'string', value: 'нет' },
      { type: 'rparen' },
    ]);
  });

  test('filter with two args', () => {
    expect(tokenize('replace("a","b")')).toEqual([
      { type: 'ident', value: 'replace' },
      { type: 'lparen' },
      { type: 'string', value: 'a' },
      { type: 'comma' },
      { type: 'string', value: 'b' },
      { type: 'rparen' },
    ]);
  });

  test('pipe-chained filters', () => {
    expect(tokenize('trim|upper')).toEqual([
      { type: 'ident', value: 'trim' },
      { type: 'pipe' },
      { type: 'ident', value: 'upper' },
    ]);
  });

  test('complex chain: pad(2)|upper|trim', () => {
    expect(tokenize('pad(2)|upper|trim')).toEqual([
      { type: 'ident', value: 'pad' },
      { type: 'lparen' },
      { type: 'number', value: 2 },
      { type: 'rparen' },
      { type: 'pipe' },
      { type: 'ident', value: 'upper' },
      { type: 'pipe' },
      { type: 'ident', value: 'trim' },
    ]);
  });

  test('ternary(yes,no)', () => {
    expect(tokenize('ternary("да","нет")')).toEqual([
      { type: 'ident', value: 'ternary' },
      { type: 'lparen' },
      { type: 'string', value: 'да' },
      { type: 'comma' },
      { type: 'string', value: 'нет' },
      { type: 'rparen' },
    ]);
  });

  test('add(12)|pad(2) — arithmetic chain', () => {
    expect(tokenize('add(12)|pad(2)')).toEqual([
      { type: 'ident', value: 'add' },
      { type: 'lparen' },
      { type: 'number', value: 12 },
      { type: 'rparen' },
      { type: 'pipe' },
      { type: 'ident', value: 'pad' },
      { type: 'lparen' },
      { type: 'number', value: 2 },
      { type: 'rparen' },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Error cases
  // ---------------------------------------------------------------------------

  test('unterminated double-quoted string throws', () => {
    expect(() => tokenize('"hello')).toThrow(/unterminated/i);
  });

  test('unterminated single-quoted string throws', () => {
    expect(() => tokenize("'hello")).toThrow(/unterminated/i);
  });

  test('unexpected character throws', () => {
    expect(() => tokenize('pad@2')).toThrow(/unexpected character/i);
  });

  test('hash character throws', () => {
    expect(() => tokenize('#tag')).toThrow(/unexpected character/i);
  });

  // ---------------------------------------------------------------------------
  // Expression-evaluator tokens (extended set)
  // ---------------------------------------------------------------------------

  test('$ prefix identifier: $1', () => {
    expect(tokenize('$1')).toEqual([{ type: 'ident', value: '$1' }]);
  });

  test('$ prefix identifier: $2 and longer', () => {
    expect(tokenize('$12')).toEqual([{ type: 'ident', value: '$12' }]);
  });

  test('bool true', () => {
    expect(tokenize('true')).toEqual([{ type: 'bool', value: true }]);
  });

  test('bool false', () => {
    expect(tokenize('false')).toEqual([{ type: 'bool', value: false }]);
  });

  test('dot token', () => {
    expect(tokenize('.')).toEqual([{ type: 'dot' }]);
  });

  test('dot chained: user.language', () => {
    expect(tokenize('user.language')).toEqual([
      { type: 'ident', value: 'user' },
      { type: 'dot' },
      { type: 'ident', value: 'language' },
    ]);
  });

  test('lbracket [', () => {
    expect(tokenize('[')).toEqual([{ type: 'lbracket' }]);
  });

  test('rbracket ]', () => {
    expect(tokenize(']')).toEqual([{ type: 'rbracket' }]);
  });

  test('array index: foo[0]', () => {
    expect(tokenize('foo[0]')).toEqual([
      { type: 'ident', value: 'foo' },
      { type: 'lbracket' },
      { type: 'number', value: 0 },
      { type: 'rbracket' },
    ]);
  });

  test('operator ==', () => {
    expect(tokenize('==')).toEqual([{ type: 'op', value: '==' }]);
  });

  test('operator !=', () => {
    expect(tokenize('!=')).toEqual([{ type: 'op', value: '!=' }]);
  });

  test('operator >=', () => {
    expect(tokenize('>=')).toEqual([{ type: 'op', value: '>=' }]);
  });

  test('operator <=', () => {
    expect(tokenize('<=')).toEqual([{ type: 'op', value: '<=' }]);
  });

  test('operator >', () => {
    expect(tokenize('>')).toEqual([{ type: 'op', value: '>' }]);
  });

  test('operator <', () => {
    expect(tokenize('<')).toEqual([{ type: 'op', value: '<' }]);
  });

  test('operator &&', () => {
    expect(tokenize('&&')).toEqual([{ type: 'op', value: '&&' }]);
  });

  test('operator ||', () => {
    expect(tokenize('||')).toEqual([{ type: 'op', value: '||' }]);
  });

  test('compound expression: a == "b" && c != 1', () => {
    expect(tokenize('a == "b" && c != 1')).toEqual([
      { type: 'ident', value: 'a' },
      { type: 'op', value: '==' },
      { type: 'string', value: 'b' },
      { type: 'op', value: '&&' },
      { type: 'ident', value: 'c' },
      { type: 'op', value: '!=' },
      { type: 'number', value: 1 },
    ]);
  });

  test('function call in expression: isPastHour($1) == false', () => {
    expect(tokenize('isPastHour($1) == false')).toEqual([
      { type: 'ident', value: 'isPastHour' },
      { type: 'lparen' },
      { type: 'ident', value: '$1' },
      { type: 'rparen' },
      { type: 'op', value: '==' },
      { type: 'bool', value: false },
    ]);
  });
});
