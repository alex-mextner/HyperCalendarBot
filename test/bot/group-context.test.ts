import { expect, test } from 'bun:test';
import { getGroupId, isGroup } from '../../src/bot/group-context.ts';

test('isGroup returns true for group', () => {
  const ctx = { chat: { type: 'group', id: 123 } };
  expect(isGroup(ctx)).toBe(true);
});

test('isGroup returns true for supergroup', () => {
  const ctx = { chat: { type: 'supergroup', id: 456 } };
  expect(isGroup(ctx)).toBe(true);
});

test('isGroup returns false for private', () => {
  const ctx = { chat: { type: 'private', id: 456 } };
  expect(isGroup(ctx)).toBe(false);
});

test('getGroupId returns null for private', () => {
  const ctx = { chat: { type: 'private', id: 1 } };
  expect(getGroupId(ctx)).toBeNull();
});

test('getGroupId returns chat id for group', () => {
  const ctx = { chat: { type: 'group', id: 777 } };
  expect(getGroupId(ctx)).toBe(777);
});

test('getGroupId returns id for supergroup', () => {
  const ctx = { chat: { type: 'supergroup', id: 999 } };
  expect(getGroupId(ctx)).toBe(999);
});

test('isGroup resolves chat via message property for callback context', () => {
  const ctx = { message: { chat: { type: 'group', id: -100 } } };
  expect(isGroup(ctx)).toBe(true);
});

test('getGroupId resolves id via message property for callback context', () => {
  const ctx = { message: { chat: { type: 'supergroup', id: -200 } } };
  expect(getGroupId(ctx)).toBe(-200);
});

test('getGroupId returns null when no chat and no message', () => {
  expect(getGroupId({})).toBeNull();
});
