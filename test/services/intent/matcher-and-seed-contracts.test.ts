import { describe, expect, test } from 'bun:test';
import type { Intent } from '../../../src/database/types.ts';
import { IntentMatcher } from '../../../src/services/intent/intent-matcher.ts';
import { type CanonicalSeed, validateCanonicalSeed } from '../../../src/services/intent/seed-replacement.ts';
import { resolveVariables } from '../../../src/services/intent/variable-resolver.ts';

let nextId = 1;
const rule = (
  overrides: Omit<Partial<Intent>, 'workflow' | 'phrases' | 'trigger_words'> & {
    workflow?: unknown;
    phrases?: unknown;
    trigger_words?: unknown;
  },
): Intent => {
  const { workflow, phrases, trigger_words, ...rest } = overrides;
  return {
    id: nextId++,
    canonical_name: `x.rule_${nextId}`,
    phrases: typeof phrases === 'string' ? phrases : JSON.stringify(phrases ?? []),
    trigger_words: typeof trigger_words === 'string' ? trigger_words : JSON.stringify(trigger_words ?? []),
    pattern: null,
    workflow: typeof workflow === 'string' ? workflow : JSON.stringify(workflow ?? { tools: [] }),
    format: 'text',
    status: 'approved',
    source_message: null,
    created_at: '',
    ...rest,
  };
};
const matcherOf = (...rules: Intent[]) => {
  const matcher = new IntentMatcher();
  matcher.load(rules);
  return matcher;
};

describe('IntentMatcher.load: what gets indexed', () => {
  test('only approved rules are indexed', () => {
    const matcher = matcherOf(
      rule({ phrases: ['approved one'] }),
      rule({ phrases: ['pending one'], status: 'pending' }),
    );
    expect(matcher.match('approved one')).not.toBeNull();
    expect(matcher.match('pending one')).toBeNull();
  });

  test('invalid phrases JSON drops the phrases but keeps trigger matching', () => {
    const matcher = matcherOf(
      rule({ phrases: 'nope', trigger_words: ['ping'], pattern: '^ping (.+)$', workflow: { q: '{{$1}}' } }),
    );
    expect(matcher.match('ping abc')?.captures).toEqual({ $1: 'abc' });
  });

  test('invalid trigger_words JSON keeps the phrases', () => {
    const matcher = matcherOf(rule({ phrases: ['hello there'], trigger_words: 'oops' }));
    expect(matcher.match('hello there')).not.toBeNull();
  });

  test('an invalid pattern leaves phrase matching without argument extraction', () => {
    const matcher = matcherOf(rule({ phrases: ['hello bad'], trigger_words: ['bad'], pattern: '(unclosed' }));
    expect(matcher.match('hello bad')).toEqual({ intentId: expect.any(Number), captures: {} });
    expect(matcher.match('bad things')).toBeNull();
  });

  test('a workflow over the inspection bound is not indexed', () => {
    const matcher = matcherOf(rule({ phrases: ['huge'], workflow: JSON.stringify('a'.repeat(70000)) }));
    expect(matcher.match('huge')).toBeNull();
  });

  test('loading again replaces the previous index', () => {
    const matcher = matcherOf(rule({ phrases: ['first'] }));
    matcher.load([rule({ phrases: ['second'] })]);
    expect(matcher.match('first')).toBeNull();
    expect(matcher.match('second')).not.toBeNull();
  });
});

describe('IntentMatcher: capture requirements', () => {
  const param = rule({
    phrases: ['sample 5'],
    trigger_words: ['sample'],
    pattern: '^sample (\\d+)(?: (\\w+))?$',
    workflow: { q: '{{$1}} {{$2|default("z")}}' },
  });

  test('a capture without a default must be present, one with default(...) may be absent', () => {
    const matcher = matcherOf(param);
    expect(matcher.match('sample 7')?.captures).toEqual({ $1: '7' });
    expect(matcher.match('sample 7 abc')?.captures).toEqual({ $1: '7', $2: 'abc' });
    expect(matcher.match('sample')).toBeNull();
  });

  test('captures are returned as typed, mapped back from normalized text', () => {
    const matcher = matcherOf(rule({ trigger_words: ['find'], pattern: '^find (\\S+)$', workflow: { q: '{{$1}}' } }));
    expect(matcher.match('FIND   Ёлка')?.captures).toEqual({ $1: 'Ёлка' });
  });

  test('an invalid filter does not relax the requirement', () => {
    const matcher = matcherOf(
      rule({ trigger_words: ['go'], pattern: '^go(?: (\\w+))?$', workflow: { q: '{{$1|default(}}' } }),
    );
    expect(matcher.match('go')).toBeNull();
    expect(matcher.match('go now')?.captures).toEqual({ $1: 'now' });
  });

  test('basis rules require exact structure: only trailing ?/! are forgiven', () => {
    const basis = rule({
      canonical_name: 'basis.strict',
      phrases: ['strict thing'],
      trigger_words: ['strict'],
      pattern: '^strict (\\w+)$',
      workflow: { q: '{{$1}}' },
    });
    const matcher = matcherOf(basis);
    expect(matcher.match('strict abc?!')?.captures).toEqual({ $1: 'abc' });
    expect(matcher.match('strict abc def')).toBeNull();
    // The same input matches a non-basis rule through normalized text, but a basis rule never falls back to it.
    expect(matcher.match('STRICT   abc')).toBeNull();
    const loose = matcherOf(rule({ trigger_words: ['strict'], pattern: '^strict (\\w+)$', workflow: { q: '{{$1}}' } }));
    expect(loose.match('STRICT   abc')?.captures).toEqual({ $1: 'abc' });
    expect(matcher.explain('strict abc def')).toMatchObject({ kind: 'abstain', reason: 'no_match' });
  });

  test('two rules sharing a phrase are ambiguous and listed by id', () => {
    const a = rule({ phrases: ['dup phrase'], workflow: { a: 'b' } });
    const b = rule({ phrases: ['dup phrase'], workflow: { a: 'c' } });
    const decision = matcherOf(b, a).explain('dup phrase');
    expect(decision).toEqual({ kind: 'abstain', reason: 'ambiguous', candidates: [a.id, b.id].sort((x, y) => x - y) });
  });

  test('an exact phrase of a parameterized rule that cannot extract is reported as a missing capture', () => {
    const decision = matcherOf(param).explain('sample 5');
    expect(decision).toMatchObject({ kind: 'matched', strategy: 'exact' });
    const missing = matcherOf(
      rule({ phrases: ['need arg'], pattern: '^need (.+)$', workflow: { q: '{{$1}}' } }),
    ).explain('need arg');
    expect(missing).toMatchObject({ kind: 'matched' });
    const none = matcherOf(rule({ phrases: ['plain'], workflow: { q: '{{$1}}' } })).explain('plain');
    expect(none).toMatchObject({ kind: 'abstain', reason: 'missing_capture' });
  });

  test('input over the length cap abstains without scanning', () => {
    expect(matcherOf(param).explain('x'.repeat(16001))).toEqual({
      kind: 'abstain',
      reason: 'input_too_long',
      candidates: [],
    });
  });
});

describe('validateCanonicalSeed', () => {
  const valid: CanonicalSeed = {
    canonical_name: 'basis.sample',
    pattern: '^sample (.+)$',
    workflow: { version: 2, steps: [{ call: 'respond', input: { message: '{{$1}}' } }] },
    phrases: ['sample one'],
    trigger_words: ['sample'],
    source_message: 'sample one',
  };

  test('accepts a well-formed seed', () => {
    expect(() => validateCanonicalSeed([valid])).not.toThrow();
  });

  test('rejects out-of-bounds counts, bad or duplicate names', () => {
    expect(() => validateCanonicalSeed([])).toThrow('Canonical seed count is out of bounds');
    expect(() => validateCanonicalSeed([{ ...valid, canonical_name: 'bad name' }])).toThrow(
      'Canonical names must be unique and namespaced',
    );
    expect(() => validateCanonicalSeed([valid, valid])).toThrow('Canonical names must be unique and namespaced');
  });

  test('rejects a non-v2 workflow, a contract error and a non-anchored pattern', () => {
    expect(() => validateCanonicalSeed([{ ...valid, workflow: { steps: [{ respond: 'x' }] } }])).toThrow(
      'basis.sample: explicit workflow v2 required',
    );
    expect(() =>
      validateCanonicalSeed([{ ...valid, workflow: { version: 2, steps: [{ respond: '{{$9}}' }] } }]),
    ).toThrow(/^basis\.sample: .*capture group \$9 does not exist/);
    expect(() => validateCanonicalSeed([{ ...valid, pattern: 'sample (.+)' }])).toThrow(
      'basis.sample: finite anchored matcher required',
    );
    expect(() => validateCanonicalSeed([{ ...valid, pattern: `^(${'a'.repeat(9000)})$` }])).toThrow(
      'basis.sample: finite anchored matcher required',
    );
  });

  test('requires examples and triggers, and every example must route uniquely to its own rule', () => {
    expect(() => validateCanonicalSeed([{ ...valid, phrases: [] }])).toThrow('Examples and triggers are required');
    expect(() => validateCanonicalSeed([{ ...valid, trigger_words: [] }])).toThrow(
      'Examples and triggers are required',
    );
    expect(() => validateCanonicalSeed([{ ...valid, phrases: ['unrelated text'] }])).toThrow(
      'basis.sample: example routing is not unique',
    );
  });
});

describe('resolveVariables: built-ins and translations', () => {
  const user = { timezone: 'Europe/Moscow', language: 'ru', username: 'u', firstName: 'F', userId: 7 };

  test('user and group variables', () => {
    expect(resolveVariables('{{user.id}}', {}, user)).toBe(7);
    expect(resolveVariables('{{user.first_name}}', {}, user)).toBe('F');
    expect(resolveVariables('{{user.utc_offset}}', {}, user)).toBe('+03:00');
    expect(resolveVariables('{{env.scope}}', {}, user)).toBe('personal');
    expect(resolveVariables('{{env.scope}}', {}, { ...user, groupIsGroup: true })).toBe('group');
    expect(resolveVariables('{{group.is_group}}', {}, user)).toBe(false);
    expect(resolveVariables('{{group.chat_id}}', {}, { ...user, groupChatId: -100 })).toBe(-100);
  });

  test('inherited property names are not variables', () => {
    expect(resolveVariables('{{toString}}', {}, user)).toBe('{{toString}}');
    expect(resolveVariables('{{constructor}}', {}, user, { constructor: 1 })).toBe('{{constructor}}');
  });

  test('step-result paths: indices, own keys only', () => {
    const steps = { arr: [{ id: 1 }, { id: 2 }], o: { a: { b: 'deep' } }, s: 'str' };
    expect(resolveVariables('{{arr[1].id}}', {}, user, steps)).toBe(2);
    expect(resolveVariables('{{o.a.b}}', {}, user, steps)).toBe('deep');
    expect(resolveVariables('{{s.length}}', {}, user, steps)).toBe(3);
    expect(resolveVariables('{{o.__proto__}}', {}, user, steps)).toBe('{{o.__proto__}}');
    expect(resolveVariables('{{arr[5].id}}', {}, user, steps)).toBe('{{arr[5].id}}');
  });

  test('translations fall back to English and resolve nested templates', () => {
    const i18n = { ru: { hi: 'Привет {{user.first_name}}' }, en: { hi: 'Hello', only_en: 'EN {{$1|upper}}' } };
    expect(resolveVariables('{{t.hi}}', {}, user, undefined, i18n)).toBe('Привет F');
    expect(resolveVariables('{{t.only_en}}', { $1: 'x' }, { ...user, language: 'de' }, undefined, i18n)).toBe('EN X');
    expect(resolveVariables('{{t.missing}}', {}, user, undefined, i18n)).toBe('{{t.missing}}');
  });

  test('strict mode refuses unresolved references and self-referencing translations', () => {
    const i18n = { ru: { loop: '{{t.loop}}' } };
    expect(() => resolveVariables('{{nope}}', {}, user, undefined, undefined, { strict: true })).toThrow();
    expect(() => resolveVariables('{{t.loop}}', {}, user, undefined, i18n, { strict: true })).toThrow();
    expect(resolveVariables('x {{$9|default("d")}}', {}, user, undefined, undefined, { strict: true })).toBe('x d');
  });

  test('a whole-string variable keeps its type, mixed text stringifies', () => {
    expect(resolveVariables('{{$1}}', { $1: 'a' }, user)).toBe('a');
    expect(resolveVariables('{{user.id}}', {}, user)).toBe(7);
    expect(resolveVariables('id={{user.id}}', {}, user)).toBe('id=7');
    expect(resolveVariables('{{user.id|pad(4)}}', {}, user)).toBe('0007');
    expect(() => resolveVariables('{{$1|nope}}', { $1: 'a' }, user)).toThrow('Unknown filter: nope');
  });
});
