// test/bot/handlers/group-tz-input.test.ts
import { beforeEach, expect, mock, test } from 'bun:test';
import { pendingGroupTzInput } from '../../../src/bot/commands/settings.ts';
import { tryHandleGroupTzInput } from '../../../src/bot/handlers/message.handler.ts';

/**
 * Scripted resolveCity stub. The real implementation has a fast path
 * (direct IANA key contains '/'), so we pass those through unchanged and
 * defer the rest to `resolveCityStubValue`.
 */
let resolveCityStubValue: string | null = null;
const resolveCityStub = mock(async (input: string) => {
  if (input.includes('/')) return input;
  return resolveCityStubValue;
});

function makeGroupRepo(store: Record<number, string>) {
  return {
    setTimezone: (chatId: number, tz: string) => {
      store[chatId] = tz;
    },
  };
}

function makeCtx() {
  const sent: string[] = [];
  return {
    ctx: {
      send: async (text: string) => {
        sent.push(text);
      },
    },
    sent,
  };
}

beforeEach(() => {
  resolveCityStub.mockClear();
  resolveCityStubValue = null;
});

test('resolves city and saves timezone to group', async () => {
  resolveCityStubValue = 'Europe/Belgrade';
  const store: Record<number, string> = {};
  const groupRepo = makeGroupRepo(store);
  const { ctx, sent } = makeCtx();
  pendingGroupTzInput.set(1, { chatId: -100, ts: Date.now(), lang: 'ru' });

  const handled = await tryHandleGroupTzInput(ctx as never, 1, 'Belgrade', groupRepo as never, resolveCityStub);

  expect(handled).toBe(true);
  expect(store[-100]).toBe('Europe/Belgrade');
  expect(sent[0]).toContain('✅');
  expect(pendingGroupTzInput.has(1)).toBe(false);
});

test('returns false when no pending state', async () => {
  pendingGroupTzInput.delete(2);
  const handled = await tryHandleGroupTzInput({} as never, 2, 'Belgrade', {} as never, resolveCityStub);
  expect(handled).toBe(false);
});

test('clears expired pending state (> 5 min)', async () => {
  pendingGroupTzInput.set(3, { chatId: -200, ts: Date.now() - 6 * 60 * 1000, lang: 'en' });
  const handled = await tryHandleGroupTzInput({} as never, 3, 'Belgrade', {} as never, resolveCityStub);
  expect(handled).toBe(false);
  expect(pendingGroupTzInput.has(3)).toBe(false);
});

test('sends Russian error message when city cannot be resolved', async () => {
  resolveCityStubValue = null;
  const { ctx, sent } = makeCtx();
  const groupRepo = makeGroupRepo({});
  pendingGroupTzInput.set(4, { chatId: -300, ts: Date.now(), lang: 'ru' });

  const handled = await tryHandleGroupTzInput(ctx as never, 4, 'xyzxyzxyz', groupRepo as never, resolveCityStub);

  expect(handled).toBe(true);
  expect(sent[0]).toContain('Не удалось');
  expect(pendingGroupTzInput.has(4)).toBe(false);
});

test('sends English error when lang is en', async () => {
  resolveCityStubValue = null;
  const { ctx, sent } = makeCtx();
  pendingGroupTzInput.set(6, { chatId: -500, ts: Date.now(), lang: 'en' });

  await tryHandleGroupTzInput(ctx as never, 6, 'xyzxyzxyz', makeGroupRepo({}) as never, resolveCityStub);

  expect(sent[0]).toContain('Could not determine');
});

test('trims whitespace from input before resolving', async () => {
  resolveCityStubValue = 'Europe/Belgrade';
  const store: Record<number, string> = {};
  const groupRepo = makeGroupRepo(store);
  const { ctx } = makeCtx();
  pendingGroupTzInput.set(5, { chatId: -400, ts: Date.now(), lang: 'ru' });

  await tryHandleGroupTzInput(ctx as never, 5, '  Belgrade  ', groupRepo as never, resolveCityStub);

  expect(store[-400]).toBe('Europe/Belgrade');
  // The stub received trimmed input
  expect(resolveCityStub).toHaveBeenCalledWith('Belgrade');
});
