import { expect, test } from 'bun:test';
import { type ChatType, type CtxWithChat, getGroupId, isGroup } from '../../src/bot/group-context.ts';

function makeCtx(type: ChatType, id: number): CtxWithChat {
  return { chat: { type, id } };
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
