// The fingerprint must stay byte-compatible with the manifests production already holds; a drift
// here would make every managed catalogue fail closed after a deploy.
import { expect, test } from 'bun:test';
import { ruleFromRow, seedFingerprint } from '../../../src/services/intent/rule-fingerprint.ts';

const rules = [
  {
    canonical_name: 'b.two',
    pattern: '^(?:два)$',
    workflow: { version: 2, steps: [{ call: 'get_bot_info', input: {} }], i18n: { ru: {}, en: {} } },
    phrases: ['два', 'two'],
    trigger_words: ['два'],
    source_message: 'два',
  },
  {
    canonical_name: 'a.one',
    pattern: '',
    workflow: { steps: [], version: 2 },
    phrases: [],
    trigger_words: [],
    source_message: '',
  },
];

test('matches the vector computed by the pre-ledger implementation', () => {
  // Computed with seedFingerprint from src/services/intent/seed-replacement.ts at 7399876e.
  expect(seedFingerprint(rules)).toBe('a6bbd32fcfd54bb1cfc1b18fb3bb6209849936724312f57e5b4fafcd2031d525');
});

test('a stored row decodes to the same fingerprint as its definition', () => {
  const [two] = rules;
  const row = {
    id: 1,
    canonical_name: two!.canonical_name,
    pattern: two!.pattern,
    workflow: JSON.stringify(two!.workflow),
    phrases: JSON.stringify(two!.phrases),
    trigger_words: JSON.stringify(two!.trigger_words),
    source_message: two!.source_message,
  };
  const decoded = ruleFromRow(row);
  expect(decoded).not.toBeNull();
  expect(seedFingerprint([decoded!, rules[1]!])).toBe(seedFingerprint(rules));
});

test('null optional columns decode like the stored defaults', () => {
  const row = {
    id: 2,
    canonical_name: 'x',
    pattern: null,
    workflow: '{}',
    phrases: '[]',
    trigger_words: '[]',
    source_message: null,
  };
  expect(ruleFromRow(row)).toEqual({
    canonical_name: 'x',
    pattern: '',
    workflow: {},
    phrases: [],
    trigger_words: [],
    source_message: '',
  });
});

test('an undecodable column makes the row unreadable instead of throwing', () => {
  const row = {
    id: 3,
    canonical_name: 'x',
    pattern: '^x$',
    workflow: 'not JSON',
    phrases: '[]',
    trigger_words: '[]',
    source_message: 'x',
  };
  expect(ruleFromRow(row)).toBeNull();
  expect(ruleFromRow({ ...row, workflow: '{}', phrases: '["ok", 3]' })).toBeNull();
});
