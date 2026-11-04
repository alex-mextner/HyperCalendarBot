// PlaywrightPool.acquire gives up in two places once its budget is spent: no free page within the
// limit, and a browser lost while the budget ran out. Each is a deadline the owner must hear about
// (alerts queue, kind playwright_acquire), aggregated per window, and reporting must not change the
// error acquire rejects with. A zero budget is already spent when the pool first reads the clock, so
// the real deadline paths run with no sleeping. Fake browsers only; no Chromium.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Browser, Page } from 'playwright';
import { configureTimeoutReporter, TimeoutReporter } from '../../src/services/incident/timeout-reporter.ts';
import { PlaywrightPool } from '../../src/worker/playwright-pool.ts';

let alerts: { text: string; source: string }[];

beforeEach(() => {
  alerts = [];
  configureTimeoutReporter(
    new TimeoutReporter(
      (text, source) => alerts.push({ text, source }),
      () => 1_000,
    ),
  );
});

afterEach(() => {
  configureTimeoutReporter(null);
});

/** `newPage` receives the browser so a test can make page creation lose it. */
function fakeBrowser(newPage: (browser: Browser) => Promise<Page>): Browser {
  const disconnectListeners: (() => void)[] = [];
  let connected = true;
  const browser: Browser = {
    isConnected: () => connected,
    on: (_event: string, listener: () => void) => {
      disconnectListeners.push(listener);
    },
    close: async () => {
      connected = false;
      for (const listener of disconnectListeners) listener();
    },
    newContext: async () => ({ newPage: () => newPage(browser), close: async () => {} }),
  } as unknown as Browser;
  return browser;
}

async function healthyPage(): Promise<Page> {
  return { context: () => ({ close: async () => {} }), setContent: async () => {} } as unknown as Page;
}

async function lostBrowserPage(browser: Browser): Promise<Page> {
  await browser.close();
  throw new Error('synthetic generation loss');
}

function expectOneAggregatedAlert(): void {
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.source).toBe('timeout');
  expect(alerts[0]?.text).toContain('Timeout (playwright_acquire)');
  expect(alerts[0]?.text).toContain('limitMs: 0');
  expect(alerts[0]?.text).toMatch(/elapsedMs: \d+/);
}

test('an acquire that finds no free page in its budget reports one aggregated playwright_acquire alert and rejects as before', async () => {
  const pool = new PlaywrightPool({ maxPages: 1, launchBrowser: async () => fakeBrowser(healthyPage) });
  await pool.initialize();
  try {
    await pool.acquire();
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(pool.acquire(0)).rejects.toThrow('acquire timeout: no page available within time limit');
    }
  } finally {
    await pool.shutdown();
  }
  expectOneAggregatedAlert();
});

test('a browser lost after the budget is spent reports one aggregated playwright_acquire alert and rejects with the same error and cause', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    let launches = 0;
    const pool = new PlaywrightPool({
      launchBrowser: async () => {
        launches++;
        return fakeBrowser(launches === 1 ? lostBrowserPage : healthyPage);
      },
    });
    await pool.initialize();
    try {
      const error = await pool.acquire(0).then(
        () => new Error('unexpectedly got a page'),
        (rejection: Error) => rejection,
      );
      expect(error.message).toBe('acquire timeout: browser recovery did not complete');
      expect(String(error.cause)).toContain('synthetic generation loss');
    } finally {
      await pool.shutdown();
    }
  }
  expectOneAggregatedAlert();
});

test('exhausting the browser-recovery budget is not a deadline and reports nothing', async () => {
  const pool = new PlaywrightPool({ maxReinitAttempts: 2, launchBrowser: async () => fakeBrowser(lostBrowserPage) });
  await pool.initialize();
  try {
    await expect(pool.acquire(60_000)).rejects.toThrow('browser recovery limit');
  } finally {
    await pool.shutdown();
  }
  expect(alerts).toEqual([]);
});

test('an acquire that gets a page reports nothing', async () => {
  const pool = new PlaywrightPool({ launchBrowser: async () => fakeBrowser(healthyPage) });
  await pool.initialize();
  try {
    expect(await pool.acquire(0)).toBeDefined();
  } finally {
    await pool.shutdown();
  }
  expect(alerts).toEqual([]);
});
