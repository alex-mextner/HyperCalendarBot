import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

import { PlaywrightPool } from '../../src/worker/playwright-pool.ts';

const mockLaunch = mock<() => Promise<Browser>>();

afterEach(() => {
  mockLaunch.mockReset();
});

function makeFakeBrowser(options?: { crashAfterMs?: number; newContext?: () => Promise<BrowserContext> }): Browser {
  const handlers = new Map<string, (() => void)[]>();
  let connected = true;
  const browser = {
    isConnected: () => connected,
    on(event: string, fn: () => void) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    close: mock(async () => {
      connected = false;
      for (const fn of handlers.get('disconnected') ?? []) fn();
    }),
    newContext:
      options?.newContext ??
      mock(async () => ({
        newPage: mock(async () => ({ setContent: mock(async () => {}) })),
        close: mock(async () => {}),
      })),
  } as unknown as Browser;

  if (options?.crashAfterMs !== undefined) {
    setTimeout(() => {
      connected = false;
      for (const fn of handlers.get('disconnected') ?? []) fn();
    }, options.crashAfterMs);
  }

  return browser;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('not initialized');
  };
  let reject: (error: Error) => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controlledContext(newPage: () => Promise<Page>) {
  const close = mock(async () => {});
  const context = { newPage, close } as unknown as BrowserContext;
  const page = { context: () => context, setContent: mock(async () => {}) } as unknown as Page;
  return { context, page, close };
}

describe('PlaywrightPool reinit', () => {
  test('disconnected handler does not create unhandled rejections on reinit failure', async () => {
    const fakeBrowser = makeFakeBrowser();
    mockLaunch.mockResolvedValueOnce(fakeBrowser);

    const pool = new PlaywrightPool({ maxReinitAttempts: 1, launchBrowser: mockLaunch });
    await pool.initialize();

    // Make subsequent launches fail
    mockLaunch.mockRejectedValue(new Error('ICU data error'));

    // Simulate browser crash — should NOT throw unhandled rejection
    await fakeBrowser.close();

    // Wait for reinit attempt to settle
    await new Promise<void>((r) => setTimeout(r, 50));

    // Pool should still exist (not crashed), acquire should fail gracefully
    await expect(pool.acquire(100)).rejects.toThrow();
  });

  test('pool becomes dead after maxReinitAttempts exceeded', async () => {
    const firstBrowser = makeFakeBrowser();
    let callCount = 0;
    mockLaunch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return firstBrowser;
      throw new Error('launch failed');
    });

    const pool = new PlaywrightPool({ maxReinitAttempts: 1, launchBrowser: mockLaunch });
    await pool.initialize();

    // Trigger disconnect → reinit attempt #1 fails
    await firstBrowser.close();

    await new Promise<void>((r) => setTimeout(r, 100));

    // After 1 failed attempt (maxReinitAttempts=1), pool should be dead
    await expect(pool.acquire(100)).rejects.toThrow('permanently disabled');
  });

  test('successful reinit resets attempt counter', async () => {
    const firstBrowser = makeFakeBrowser();
    mockLaunch.mockImplementation(async () => makeFakeBrowser()).mockResolvedValueOnce(firstBrowser);

    const pool = new PlaywrightPool({ maxReinitAttempts: 3, launchBrowser: mockLaunch });
    await pool.initialize();

    // Trigger disconnect → reinit succeeds
    await firstBrowser.close();

    await new Promise<void>((r) => setTimeout(r, 100));

    // Pool should still be alive (reinit succeeded, counter reset)
    const page = await pool.acquire(1000);
    expect(page).toBeDefined();
    await pool.shutdown();
  });
  test('unit doubles do not replace the real Playwright module', () => {
    expect(typeof chromium.executablePath).toBe('function');
  });

  test('intentional shutdown never launches a replacement browser', async () => {
    mockLaunch.mockImplementation(async () => makeFakeBrowser());
    const pool = new PlaywrightPool({ launchBrowser: mockLaunch });
    await pool.initialize();
    await pool.shutdown();
    expect(mockLaunch).toHaveBeenCalledTimes(1);
    await expect(pool.acquire()).rejects.toThrow('shut down');
    await expect(pool.initialize()).rejects.toThrow('shut down');
  });

  test('shutdown waits for and disposes a late initial browser', async () => {
    let complete: (browser: Browser) => void = () => {
      throw new Error('Resolver not initialized');
    };
    const pending = new Promise<Browser>((resolve) => {
      complete = resolve;
    });
    mockLaunch.mockReturnValue(pending);
    const browser = makeFakeBrowser();
    const pool = new PlaywrightPool({ launchBrowser: mockLaunch });
    const initialization = pool.initialize();
    const closing = pool.shutdown();
    complete(browser);
    await Promise.all([initialization, closing]);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(mockLaunch).toHaveBeenCalledTimes(1);
    await expect(pool.acquire()).rejects.toThrow('shut down');
  });

  test('concurrent and repeated initialize calls share one browser', async () => {
    let complete: (browser: Browser) => void = () => {
      throw new Error('Resolver not initialized');
    };
    const pending = new Promise<Browser>((resolve) => {
      complete = resolve;
    });
    mockLaunch.mockReturnValue(pending);
    const pool = new PlaywrightPool({ launchBrowser: mockLaunch });
    const first = pool.initialize();
    const second = pool.initialize();
    complete(makeFakeBrowser());
    await Promise.all([first, second]);
    await pool.initialize();
    expect(mockLaunch).toHaveBeenCalledTimes(1);
    await pool.shutdown();
  });

  test('shutdown during recovery disposes the late replacement without another restart', async () => {
    let complete: (browser: Browser) => void = () => {
      throw new Error('Resolver not initialized');
    };
    const pending = new Promise<Browser>((resolve) => {
      complete = resolve;
    });
    const first = makeFakeBrowser();
    const replacement = makeFakeBrowser();
    mockLaunch.mockResolvedValueOnce(first).mockReturnValue(pending);
    const pool = new PlaywrightPool({ launchBrowser: mockLaunch });
    await pool.initialize();
    await first.close();
    const closing = pool.shutdown();
    complete(replacement);
    await closing;
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(mockLaunch).toHaveBeenCalledTimes(2);
    await expect(pool.acquire()).rejects.toThrow('shut down');
  });

  test('a late release does not repopulate a shut-down pool', async () => {
    mockLaunch.mockImplementation(async () => makeFakeBrowser());
    const pool = new PlaywrightPool({ launchBrowser: mockLaunch });
    await pool.initialize();
    const page = await pool.acquire();
    await pool.shutdown();
    await pool.release(page);
    expect(page.setContent).not.toHaveBeenCalled();
  });
  test('shutdown racing with newPage discards the late page and closes its context', async () => {
    const gate = deferred<Page>();
    const started = deferred<boolean>();
    const fixture = controlledContext(() => {
      started.resolve(true);
      return gate.promise;
    });
    const browser = makeFakeBrowser({ newContext: async () => fixture.context });
    const pool = new PlaywrightPool({ launchBrowser: async () => browser });
    await pool.initialize();
    const acquired = pool.acquire().then(
      () => 'unexpected page',
      (error: Error) => error.message,
    );
    await started.promise;
    await pool.shutdown();
    gate.resolve(fixture.page);
    expect(await acquired).toContain('shut down');
    expect(fixture.close).toHaveBeenCalled();
  });

  test('shutdown racing with newContext never asks the late context for a page', async () => {
    const gate = deferred<BrowserContext>();
    const factory = mock(async () => fixture.page);
    const fixture = controlledContext(factory);
    const browser = makeFakeBrowser({ newContext: () => gate.promise });
    const pool = new PlaywrightPool({ launchBrowser: async () => browser });
    await pool.initialize();
    const acquired = pool.acquire().then(
      () => 'unexpected page',
      (error: Error) => error.message,
    );
    await pool.shutdown();
    gate.resolve(fixture.context);
    expect(await acquired).toContain('shut down');
    expect(factory).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalled();
  });

  test('newPage rejection closes the context but preserves an ordinary creation error', async () => {
    const error = new Error('synthetic page failure');
    const fixture = controlledContext(async () => {
      throw error;
    });
    const pool = new PlaywrightPool({
      launchBrowser: async () => makeFakeBrowser({ newContext: async () => fixture.context }),
    });
    await pool.initialize();
    await expect(pool.acquire()).rejects.toBe(error);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    await pool.shutdown();
  });

  test('raw creation rejection after shutdown becomes a lifecycle error', async () => {
    const gate = deferred<BrowserContext>();
    const pool = new PlaywrightPool({ launchBrowser: async () => makeFakeBrowser({ newContext: () => gate.promise }) });
    await pool.initialize();
    const acquired = pool.acquire().then(
      () => 'unexpected page',
      (error: Error) => error.message,
    );
    await pool.shutdown();
    gate.reject(new Error('Target closed'));
    expect(await acquired).toContain('shut down');
  });
  test('acquire detects connection loss before a delayed disconnect event', async () => {
    const first = makeFakeBrowser();
    const replacement = makeFakeBrowser();
    mockLaunch.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const pool = new PlaywrightPool({ launchBrowser: mockLaunch });
    await pool.initialize();
    const connected = spyOn(first, 'isConnected').mockReturnValue(false);
    await pool.acquire(1000);
    expect(mockLaunch).toHaveBeenCalledTimes(2);
    expect(first.newContext).not.toHaveBeenCalled();
    // A delayed old-generation event must not invalidate the replacement.
    await first.close();
    await pool.acquire(1000);
    expect(mockLaunch).toHaveBeenCalledTimes(2);
    connected.mockRestore();
    await pool.shutdown();
  });

  test('acquire retries a page creation interrupted by browser replacement', async () => {
    let first: Browser;
    const context = controlledContext(async () => {
      await first.close();
      throw new Error('Synthetic target closed during creation');
    });
    first = makeFakeBrowser({ newContext: async () => context.context });
    const replacement = makeFakeBrowser();
    mockLaunch.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const pool = new PlaywrightPool({ launchBrowser: mockLaunch });
    await pool.initialize();
    const page = await pool.acquire(1000);
    expect(page).toBeDefined();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(mockLaunch).toHaveBeenCalledTimes(2);
    await pool.shutdown();
  });
  test('repeated generation loss has a small allocation budget per acquire', async () => {
    mockLaunch.mockImplementation(async () => {
      let browser: Browser;
      const context = controlledContext(async () => {
        await browser.close();
        throw new Error('Synthetic repeated generation loss');
      });
      browser = makeFakeBrowser({ newContext: async () => context.context });
      return browser;
    });
    const pool = new PlaywrightPool({ launchBrowser: mockLaunch, maxReinitAttempts: 2 });
    await pool.initialize();
    await expect(pool.acquire(100)).rejects.toThrow('browser recovery limit');
    expect(mockLaunch.mock.calls.length).toBeLessThanOrEqual(4);
    await pool.shutdown();
  });
  test('concurrent acquires share one recovery for a disconnected browser', async () => {
    const first = makeFakeBrowser();
    const replacement = makeFakeBrowser();
    mockLaunch.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement);
    const pool = new PlaywrightPool({ launchBrowser: mockLaunch });
    await pool.initialize();
    const connected = spyOn(first, 'isConnected').mockReturnValue(false);
    const pages = await Promise.all([pool.acquire(1000), pool.acquire(1000), pool.acquire(1000)]);
    expect(pages).toHaveLength(3);
    expect(mockLaunch).toHaveBeenCalledTimes(2);
    expect(first.newContext).not.toHaveBeenCalled();
    expect(replacement.newContext).toHaveBeenCalledTimes(3);
    connected.mockRestore();
    await pool.shutdown();
  });
});
