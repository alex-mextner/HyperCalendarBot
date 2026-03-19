// test/bot/handlers/group-tz-input.test.ts
import { beforeEach, expect, mock, test } from 'bun:test';
import { pendingGroupTzInput } from '../../../src/bot/commands/settings.ts';

// Mock Anthropic (same pattern as city-resolver.test.ts) so AI path is controlled
const mockCreate = mock(async () => ({
  content: [{ type: 'text', text: 'UNKNOWN' }],
}));
mock.module('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

const { tryHandleGroupTzInput } = await import('../../../src/bot/handlers/message.handler.ts');

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

beforeEach(() => mockCreate.mockReset());

test('resolves city via library and saves timezone to group', async () => {
  const store: Record<number, string> = {};
  const groupRepo = makeGroupRepo(store);
  const { ctx, sent } = makeCtx();
  pendingGroupTzInput.set(1, { chatId: -100, ts: Date.now() });

  // 'Belgrade' resolves via city-timezones library (no AI needed)
  const handled = await tryHandleGroupTzInput(ctx as never, 1, 'Belgrade', groupRepo as never);

  expect(handled).toBe(true);
  expect(store[-100]).toBe('Europe/Belgrade');
  expect(sent[0]).toContain('✅');
  expect(pendingGroupTzInput.has(1)).toBe(false);
});

test('returns false when no pending state', async () => {
  pendingGroupTzInput.delete(2);

  const handled = await tryHandleGroupTzInput({} as never, 2, 'Belgrade', {} as never);
  expect(handled).toBe(false);
});

test('clears expired pending state (> 5 min)', async () => {
  pendingGroupTzInput.set(3, { chatId: -200, ts: Date.now() - 6 * 60 * 1000 });

  const handled = await tryHandleGroupTzInput({} as never, 3, 'Belgrade', {} as never);
  expect(handled).toBe(false);
  expect(pendingGroupTzInput.has(3)).toBe(false);
});

test('sends error message when city cannot be resolved', async () => {
  // 'xyzxyzxyz' → library misses → AI returns UNKNOWN → resolver returns null
  mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'UNKNOWN' }] });
  const { ctx, sent } = makeCtx();
  const groupRepo = makeGroupRepo({});
  pendingGroupTzInput.set(4, { chatId: -300, ts: Date.now() });

  const handled = await tryHandleGroupTzInput(ctx as never, 4, 'xyzxyzxyz', groupRepo as never);

  expect(handled).toBe(true);
  expect(sent[0]).toContain('Не удалось');
  expect(pendingGroupTzInput.has(4)).toBe(false);
});

test('trims whitespace from input before resolving', async () => {
  const store: Record<number, string> = {};
  const groupRepo = makeGroupRepo(store);
  const { ctx } = makeCtx();
  pendingGroupTzInput.set(5, { chatId: -400, ts: Date.now() });

  await tryHandleGroupTzInput(ctx as never, 5, '  Belgrade  ', groupRepo as never);

  expect(store[-400]).toBe('Europe/Belgrade');
});
