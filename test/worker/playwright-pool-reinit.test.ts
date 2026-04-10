import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Browser } from 'playwright';

// Mock chromium.launch to avoid needing a real browser
const mockLaunch = mock<() => Promise<Browser>>();
mock.module('playwright', () => ({
  chromium: { launch: mockLaunch },
}));

// Import after mock setup
const { PlaywrightPool } = await import('../../src/worker/playwright-pool.ts');

afterEach(() => {
  mockLaunch.mockReset();
});

function makeFakeBrowser(options?: { crashAfterMs?: number }): Browser {
  const handlers = new Map<string, (() => void)[]>();
  const browser = {
    on(event: string, fn: () => void) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    close: mock(async () => {
      for (const fn of handlers.get('disconnected') ?? []) fn();
    }),
    newContext: mock(async () => ({
      newPage: mock(async () => ({ setContent: mock(async () => {}) })),
      close: mock(async () => {}),
    })),
  } as unknown as Browser;

  if (options?.crashAfterMs !== undefined) {
    setTimeout(() => {
      for (const fn of handlers.get('disconnected') ?? []) fn();
    }, options.crashAfterMs);
  }

  return browser;
}

describe('PlaywrightPool reinit', () => {
  test('disconnected handler does not create unhandled rejections on reinit failure', async () => {
    const fakeBrowser = makeFakeBrowser();
    mockLaunch.mockResolvedValueOnce(fakeBrowser);

    const pool = new PlaywrightPool({ maxReinitAttempts: 1 });
    await pool.initialize();

    // Make subsequent launches fail
    mockLaunch.mockRejectedValue(new Error('ICU data error'));

    // Simulate browser crash — should NOT throw unhandled rejection
    await (fakeBrowser as unknown as { close: () => Promise<void> }).close();

    // Wait for reinit attempt to settle
    await new Promise<void>((r) => setTimeout(r, 50));

    // Pool should still exist (not crashed), acquire should fail gracefully
    await expect(pool.acquire(100)).rejects.toThrow();
  });

  test('pool becomes dead after maxReinitAttempts exceeded', async () => {
    let callCount = 0;
    mockLaunch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return makeFakeBrowser();
      throw new Error('launch failed');
    });

    const pool = new PlaywrightPool({ maxReinitAttempts: 1 });
    await pool.initialize();

    // Trigger disconnect → reinit attempt #1 fails
    await (mockLaunch.mock.results[0]!.value as Promise<Browser>).then(async (b) => {
      await (b as unknown as { close: () => Promise<void> }).close();
    });

    await new Promise<void>((r) => setTimeout(r, 100));

    // After 1 failed attempt (maxReinitAttempts=1), pool should be dead
    await expect(pool.acquire(100)).rejects.toThrow('permanently disabled');
  });

  test('successful reinit resets attempt counter', async () => {
    mockLaunch.mockImplementation(async () => makeFakeBrowser());

    const pool = new PlaywrightPool({ maxReinitAttempts: 3 });
    await pool.initialize();

    // Trigger disconnect → reinit succeeds
    const firstBrowser = await mockLaunch.mock.results[0]!.value;
    await (firstBrowser as unknown as { close: () => Promise<void> }).close();

    await new Promise<void>((r) => setTimeout(r, 100));

    // Pool should still be alive (reinit succeeded, counter reset)
    const page = await pool.acquire(1000);
    expect(page).toBeDefined();
    await pool.shutdown();
  });
});
