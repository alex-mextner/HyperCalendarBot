import { expect, test } from 'bun:test';
import { canEndConversation } from '../../src/services/ai/completion-guard.ts';

for (const text of ['', '   ', '...', '…', '[SKIP]']) {
  test(`explicit unanswered turn cannot end with ${JSON.stringify(text)}`, () => {
    expect(canEndConversation(text, { explicit: true, lastTool: true, supplement: false })).toBe(false);
  });
}
test('a final answer permits completion only after all calls in the batch', () => {
  expect(canEndConversation('Done.', { explicit: true, lastTool: true, supplement: false })).toBe(true);
  expect(canEndConversation('Done.', { explicit: true, lastTool: false, supplement: false })).toBe(false);
});
test('intentional supplement/group silence does not require a redundant answer', () => {
  expect(canEndConversation('', { explicit: true, lastTool: true, supplement: true })).toBe(true);
  expect(canEndConversation('', { explicit: false, lastTool: true, supplement: false })).toBe(true);
});
