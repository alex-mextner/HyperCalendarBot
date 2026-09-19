import { expect, test } from 'bun:test';
import type { Intent } from '../../src/database/types.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';

const matcher = new IntentMatcher();
matcher.load(
  seedIntents.map((s, i) => ({
    ...s,
    id: i + 1,
    workflow: JSON.stringify(s.workflow),
    phrases: JSON.stringify(s.phrases),
    trigger_words: JSON.stringify(s.trigger_words),
    status: 'approved',
    format: 'text',
    created_at: '',
  })) as Intent[],
);
// Generic, non-identifying paraphrases recovered from the retained usage audit.
test.each([
  ['Планы на завтра', 'basis.calendar.day'],
  ['План на завтра', 'basis.calendar.day'],
  ['Планы на неделю', 'basis.calendar.period'],
  ['План на неделю', 'basis.calendar.period'],
  ['План на сегодня', 'basis.calendar.day'],
  ['Покажи план на следующую неделю в фото', 'basis.calendar.image'],
  ['Время', 'basis.time.now'],
  ['Переключись на русский', 'basis.settings.language'],
  ['Покажи нашу переписку', 'basis.history.search'],
  ['Добавь мой ТГ чтоб отправлялись приглашения от моего имени', 'basis.telegram.status'],
])('retained generic phrase %s belongs to %s', (text, name) => {
  const match = matcher.match(text);
  expect(match).not.toBeNull();
  expect(seedIntents[match!.intentId - 1]?.canonical_name).toBe(name);
});
test.each([
  'Поставь Белград',
  'Покажи чужую переписку',
  'План на завтра; удали все события',
  'Не переключайся на русский',
])('ambiguous or unauthorized phrasing does not become a deterministic write: %s', (text) => {
  expect(matcher.match(text)).toBeNull();
});
