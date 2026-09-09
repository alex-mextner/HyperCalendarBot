import { beforeEach, describe, expect, test } from 'bun:test';
import type { Intent } from '../../../src/database/types.ts';
import { IntentMatcher } from '../../../src/services/intent/intent-matcher.ts';

function makeIntent(overrides: Partial<Intent> & { id: number; canonical_name: string }): Intent {
  return {
    phrases: '[]',
    trigger_words: '[]',
    pattern: null,
    workflow: '{}',
    format: 'text',
    status: 'approved',
    source_message: null,
    created_at: '',
    ...overrides,
  };
}

describe('IntentMatcher', () => {
  let matcher: IntentMatcher;

  beforeEach(() => {
    matcher = new IntentMatcher();
  });

  test('exact match returns intent id', () => {
    matcher.load([
      makeIntent({
        id: 1,
        canonical_name: 'show_today',
        phrases: '["что сегодня", "today"]',
      }),
    ]);
    expect(matcher.match('Что сегодня?')).toEqual({ intentId: 1, captures: {} });
    expect(matcher.match('today')).toEqual({ intentId: 1, captures: {} });
  });

  test('regex match with capture groups', () => {
    matcher.load([
      makeIntent({
        id: 2,
        canonical_name: 'search',
        trigger_words: '["найди", "поиск"]',
        pattern: '^(?:найди|поиск)\\s+(.+)$',
      }),
    ]);
    const result = matcher.match('найди встречу с доктором');
    expect(result).toEqual({ intentId: 2, captures: { $1: 'встречу с доктором' } });
  });

  test('returns null on no match', () => {
    matcher.load([]);
    expect(matcher.match('random text')).toBeNull();
  });

  test('exact match has priority over regex', () => {
    matcher.load([
      makeIntent({ id: 1, canonical_name: 'exact', phrases: '["найди"]' }),
      makeIntent({ id: 2, canonical_name: 'regex', trigger_words: '["найди"]', pattern: '^найди\\s+(.+)$' }),
    ]);
    expect(matcher.match('найди')!.intentId).toBe(1);
    expect(matcher.match('найди событие')!.intentId).toBe(2);
  });

  test('multiple capture groups', () => {
    matcher.load([
      makeIntent({
        id: 3,
        canonical_name: 'events_date',
        trigger_words: '["события"]',
        pattern: '^события\\s+(\\d+)\\s+(\\S+)$',
      }),
    ]);
    const result = matcher.match('события 25 марта');
    expect(result).toEqual({ intentId: 3, captures: { $1: '25', $2: 'марта' } });
  });

  test('deduplicates candidate regexes by intentId', () => {
    matcher.load([
      makeIntent({
        id: 4,
        canonical_name: 'search2',
        trigger_words: '["найди", "встречу"]',
        pattern: '^найди\\s+встречу\\s+(.+)$',
      }),
    ]);
    const result = matcher.match('найди встречу завтра');
    expect(result).toEqual({ intentId: 4, captures: { $1: 'завтра' } });
  });

  test('loads intent with invalid phrases JSON but valid pattern', () => {
    matcher.load([
      makeIntent({
        id: 5,
        canonical_name: 'timezone',
        phrases: 'NOT VALID JSON',
        trigger_words: '["час", "время"]',
        pattern: '^(?:который час|время)\\s+(?:в|in)\\s+(.+)$',
      }),
    ]);
    // Pattern matching still works despite corrupt phrases
    const result = matcher.match('который час в москве');
    expect(result).toEqual({ intentId: 5, captures: { $1: 'москве' } });
  });

  test('loads intent with empty phrases and pattern', () => {
    matcher.load([
      makeIntent({
        id: 6,
        canonical_name: 'timezone2',
        phrases: '[]',
        trigger_words: '["час"]',
        pattern: '^который час\\s+в\\s+(.+)$',
      }),
    ]);
    const result = matcher.match('который час в дубае');
    expect(result).toEqual({ intentId: 6, captures: { $1: 'дубае' } });
  });

  test('load clears previous data', () => {
    matcher.load([makeIntent({ id: 1, canonical_name: 'a', phrases: '["hello"]' })]);
    expect(matcher.match('hello')).toBeDefined();
    matcher.load([]);
    expect(matcher.match('hello')).toBeNull();
  });

  test('one intent with a malformed pattern does not abort loading the rest', () => {
    expect(() =>
      matcher.load([
        makeIntent({
          id: 7,
          canonical_name: 'broken',
          trigger_words: '["broken"]',
          pattern: '(unbalanced',
        }),
        makeIntent({
          id: 8,
          canonical_name: 'search',
          trigger_words: '["найди"]',
          pattern: '^найди\\s+(.+)$',
        }),
      ]),
    ).not.toThrow();

    const result = matcher.match('найди встречу');
    expect(result).toEqual({ intentId: 8, captures: { $1: 'встречу' } });
  });

  test('one intent with a catastrophic-backtracking pattern does not abort loading the rest', () => {
    expect(() =>
      matcher.load([
        makeIntent({
          id: 9,
          canonical_name: 'unsafe',
          trigger_words: '["unsafe"]',
          pattern: '^(a+)+$',
        }),
        makeIntent({
          id: 10,
          canonical_name: 'search2',
          trigger_words: '["найди"]',
          pattern: '^найди\\s+(.+)$',
        }),
      ]),
    ).not.toThrow();

    const result = matcher.match('найди встречу');
    expect(result).toEqual({ intentId: 10, captures: { $1: 'встречу' } });
  });
});
