import { describe, expect, test } from 'bun:test';
import type { Intent } from '../../../src/database/types.ts';
import { IntentMatcher } from '../../../src/services/intent/intent-matcher.ts';
import { normalizeWithOffsets } from '../../../src/services/intent/normalizer.ts';

const intent = (id: number, extra: Partial<Intent> = {}): Intent => ({
  id,
  canonical_name: `synthetic_${id}`,
  phrases: '[]',
  trigger_words: '[]',
  pattern: null,
  workflow: '{}',
  format: 'text',
  status: 'approved',
  created_at: '',
  source_message: null,
  ...extra,
});
const load = (...items: Intent[]) => {
  const m = new IntentMatcher();
  m.load(items);
  return m;
};
const parameterized = (id = 1) =>
  intent(id, {
    phrases: JSON.stringify(['найди Node.js']),
    trigger_words: '["найди"]',
    pattern: '^найди\\s+(.+)$',
    workflow: JSON.stringify({ tools: [{ name: 'search_events', input: { query: '{{$1}}' } }] }),
  });
describe('matching identity and original argument contract', () => {
  test('exact example still extracts mandatory capture', () =>
    expect(load(parameterized()).match('найди Node.js')).toEqual({ intentId: 1, captures: { $1: 'Node.js' } }));
  test('regex preserves original case punctuation time and username', () =>
    expect(load(parameterized()).match('найди Node.js в 19:30 @Alice')).toEqual({
      intentId: 1,
      captures: { $1: 'Node.js в 19:30 @Alice' },
    }));
  test('normalized compatibility preserves capture span from original message', () =>
    expect(
      load(
        intent(1, {
          trigger_words: '["найди"]',
          pattern: '^найди\\s+(\\d+\\s+\\d+)$',
          workflow: '{"tools":[{"name":"search_events","input":{"query":"{{$1}}"}}]}',
        }),
      ).match('НАЙДИ 19:30'),
    ).toEqual({ intentId: 1, captures: { $1: '19:30' } }));
  test('missing mandatory slot never yields an executable exact match', () => {
    const x = parameterized();
    x.pattern = '^найди(?:\\s+(.+))?$';
    x.phrases = '["найди"]';
    expect(load(x).match('найди')).toBeNull();
  });
  test('exact collisions abstain independent of input order', () => {
    const a = intent(1, { phrases: '["планы"]' }),
      b = intent(2, { phrases: '["Планы!"]' });
    for (const entries of [
      [a, b],
      [b, a],
    ])
      expect(load(...entries).match('планы')).toBeNull();
  });
  test('overlapping regex candidates abstain independent of trigger order', () => {
    const a = intent(1, { trigger_words: '["найди"]', pattern: '^найди (.+)$' }),
      b = intent(2, { trigger_words: '["событие"]', pattern: '^найди событие (.+)$' });
    for (const entries of [
      [a, b],
      [b, a],
    ])
      expect(load(...entries).match('найди событие завтра')).toBeNull();
  });
  test('duplicate aliases for the same intent are not ambiguity', () =>
    expect(load(intent(1, { phrases: '["планы","Планы!"]' })).match('планы')).toEqual({ intentId: 1, captures: {} }));
  test('malformed pattern does not prevent other intents from loading', () => {
    const m = new IntentMatcher();
    expect(() =>
      m.load([intent(1, { pattern: '[', trigger_words: '["сломано"]' }), intent(2, { phrases: '["планы"]' })]),
    ).not.toThrow();
    expect(m.match('планы')?.intentId).toBe(2);
  });
  test('unanchored partial regex cannot silently discard remaining request', () =>
    expect(
      load(intent(1, { pattern: 'планы завтра', trigger_words: '["планы"]' })).match('планы завтра и удали встречу'),
    ).toBeNull());
  test('rejected input cannot remain in loaded matching index', () =>
    expect(load(intent(1, { status: 'rejected', phrases: '["планы"]' })).match('планы')).toBeNull());
  test('numeric event IDs larger than 32 bits survive verbatim', () =>
    expect(load(parameterized()).match('найди 5153477378')?.captures.$1).toBe('5153477378'));
  test('parameterized phrase without valid extractor abstains', () => {
    const x = parameterized();
    x.pattern = null;
    expect(load(x).match('найди Node.js')).toBeNull();
  });
});

test('explicit optional capture with literal default need not be present', () => {
  const row = intent(1, {
    phrases: '["напомни через час оплатить"]',
    trigger_words: '["напомни"]',
    pattern: '^напомни через (?:(\\d+) )?час (.+)$',
    workflow: JSON.stringify({
      steps: [{ call: 'create_event', input: { hours: '{{$1|default(1)}}', title: '{{$2}}' } }],
    }),
  });
  expect(load(row).match('напомни через час оплатить')).toEqual({ intentId: 1, captures: { $2: 'оплатить' } });
  expect(load(row).match('напомни через 2 час оплатить')).toEqual({
    intentId: 1,
    captures: { $1: '2', $2: 'оплатить' },
  });
});
test('optional-only slot still extracts value on exact phrase rather than always using default', () => {
  const row = intent(1, {
    phrases: '["планы 5"]',
    trigger_words: '["планы"]',
    pattern: '^планы(?: (\\d+))?$',
    workflow: JSON.stringify({ tools: [{ name: 'get_upcoming', input: { limit: '{{$1|default(3)}}' } }] }),
  });
  expect(load(row).match('планы 5')).toEqual({ intentId: 1, captures: { $1: '5' } });
});

test('truncated workflow slot inspection must not turn mandatory slots into optional ones', () => {
  const row = intent(1, {
    phrases: '["найди"]',
    pattern: '^найди(?: (.+))?$',
    trigger_words: '["найди"]',
    workflow: JSON.stringify({ query: '{{$1}}', padding: Array(4100).fill('filler') }),
  });
  expect(load(row).match('найди')).toBeNull();
});

test('normalized offset table is built at most once across all candidates and not cached across messages', () => {
  let count = 0;
  const matcher = new IntentMatcher((text) => {
    count++;
    return normalizeWithOffsets(text);
  });
  matcher.load(
    Array.from({ length: 12 }, (_, i) => intent(i + 1, { trigger_words: '["найди"]', pattern: `^найди вариант${i}$` })),
  );
  expect(matcher.match('найди другое')).toBeNull();
  expect(count).toBe(1);
  expect(matcher.match('найди иное')).toBeNull();
  expect(count).toBe(2);
});
