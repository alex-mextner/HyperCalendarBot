import { describe, expect, test } from 'bun:test';
import { StressDictionary } from '../../../src/services/voice/stress-dictionary.ts';

describe('StressDictionary', () => {
  const dict = new StressDictionary({
    молоко: 'молок+о',
    молока: 'молок+а',
    молоком: 'молок+ом',
    встреча: 'встр+еча',
    встречу: 'встр+ечу',
    календарь: 'календ+арь',
    человек: 'челов+ек',
  });

  test('looks up known words', () => {
    expect(dict.lookup('молоко')).toBe('молок+о');
    expect(dict.lookup('встреча')).toBe('встр+еча');
  });

  test('is case-insensitive', () => {
    expect(dict.lookup('Молоко')).toBe('молок+о');
    expect(dict.lookup('ВСТРЕЧА')).toBe('встр+еча');
  });

  test('returns null for unknown words', () => {
    expect(dict.lookup('алексом')).toBeNull();
    expect(dict.lookup('xyz')).toBeNull();
  });

  test('lookupMany returns stressed and similar for each word', () => {
    const results = dict.lookupMany(['молоко', 'алексом', 'встреча']);
    expect(results.молоко.stressed).toBe('молок+о');
    expect(results.молоко.similar).toEqual([]);
    expect(results.встреча.stressed).toBe('встр+еча');
    expect(results.алексом.stressed).toBeNull();
  });

  test('findSimilar returns words with shared prefix', () => {
    const similar = dict.findSimilar('молоки', 5);
    expect(similar.length).toBeGreaterThan(0);
    expect(similar.some((s) => s.includes('молок'))).toBe(true);
  });

  test('findSimilar returns empty for very short words', () => {
    const similar = dict.findSimilar('мо', 5);
    expect(similar).toEqual([]);
  });

  test('lookupMany includes similar when word not found', () => {
    const results = dict.lookupMany(['молоки']);
    expect(results.молоки.stressed).toBeNull();
    expect(results.молоки.similar.length).toBeGreaterThan(0);
  });

  test('reports correct size', () => {
    expect(dict.size).toBe(7);
  });
});
