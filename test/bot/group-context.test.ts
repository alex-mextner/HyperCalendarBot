import { expect, test } from 'bun:test';
import { getGroupId, isGroup } from '../../src/bot/group-context.ts';

type ChatType = 'group' | 'supergroup' | 'private' | 'channel';

function makeCtx(type: ChatType, id: number) {
  return { chat: { type, id } } as never;
}

test('isGroup returns true for group', () => {
  expect(isGroup(makeCtx('group', -100))).toBe(true);
});

test('isGroup returns true for supergroup', () => {
  expect(isGroup(makeCtx('supergroup', -100))).toBe(true);
});

test('isGroup returns false for private', () => {
  expect(isGroup(makeCtx('private', 1))).toBe(false);
});

test('getGroupId returns chat id for group', () => {
  expect(getGroupId(makeCtx('group', -100))).toBe(-100);
});

test('getGroupId returns null for private', () => {
  expect(getGroupId(makeCtx('private', 1))).toBeNull();
});
