import { mock } from 'bun:test';

/**
 * Drains the microtask queue by awaiting multiple Promise.resolve() ticks.
 * Use instead of setTimeout(r, N) when waiting for fire-and-forget async chains.
 */
export async function flushPromises(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}

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
