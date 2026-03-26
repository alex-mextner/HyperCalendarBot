import { mock } from 'bun:test';
import type { User } from '../../src/database/types.ts';

/**
 * Drains the microtask queue by awaiting multiple Promise.resolve() ticks.
 * Use instead of setTimeout(r, N) when waiting for fire-and-forget async chains.
 */
export async function flushPromises(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

interface MockCtxShape {
  args: string | null;
  dbUser: Partial<User>;
  send: ReturnType<typeof mock>;
  editText: ReturnType<typeof mock>;
  answer: ReturnType<typeof mock>;
}

export function mockCtx(overrides: Partial<MockCtxShape> = {}) {
  return {
    args: null as string | null,
    dbUser: { telegram_id: 100, language: 'en' as const, timezone: 'UTC' },
    send: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    answer: mock(() => Promise.resolve()),
    ...overrides,
  };
}
