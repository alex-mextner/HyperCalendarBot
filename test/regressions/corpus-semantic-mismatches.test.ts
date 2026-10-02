import { expect, test } from 'bun:test';
import type { Intent } from '../../src/database/types.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';

const rows = seedIntents.map((s, i) => ({
  ...s,
  id: i + 1,
  workflow: JSON.stringify(s.workflow),
  phrases: JSON.stringify(s.phrases),
  trigger_words: JSON.stringify(s.trigger_words),
  format: 'text',
  status: 'approved',
  created_at: '2000-01-01 00:00:00',
})) as Intent[];
const matcher = new IntentMatcher();
matcher.load(rows);
test('a likely rescheduling transcription must not create another event', () => {
  expect(matcher.match('Принеси занятия с преподавателем на субботу 11.00 по Белграду.')).toBeNull();
});
test('a bare riddle answer is not enough to invoke a calendar clock tool', () => {
  expect(matcher.match('Время')).toBeNull();
  expect(matcher.match('Который час?')).not.toBeNull();
});
test('the common day-plan request reaches the day workflow', () => {
  const match = matcher.match('План на день');
  expect(match).not.toBeNull();
  expect(seedIntents[match!.intentId - 1]!.canonical_name).toBe('basis.calendar.day');
});
test('custom approved v2 rules retain original punctuation, just like baseline rules', () => {
  const local = new IntentMatcher();
  local.load([
    {
      ...rows[0]!,
      canonical_name: 'custom.safe',
      id: 999,
      pattern: '^delete safe$',
      phrases: '["delete safe"]',
      trigger_words: '["delete"]',
      workflow: JSON.stringify({ version: 2, steps: [{ respond: 'Confirmation only' }] }),
    },
  ]);
  expect(local.match('delete; safe')).toBeNull();
  expect(local.match('delete safe')?.intentId).toBe(999);
});
