import { mock } from 'bun:test';

export function mockCtx(overrides: Record<string, unknown> = {}) {
  return {
    args: null as string | null,
    dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC' },
    send: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    answer: mock(() => Promise.resolve()),
    ...overrides,
  };
}
