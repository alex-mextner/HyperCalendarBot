import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

import { PlaywrightPool } from '../../src/worker/playwright-pool.ts';

const mockLaunch = mock<() => Promise<Browser>>();

afterEach(() => {
  mockLaunch.mockReset();
});

function makeFakeBrowser(options?: { crashAfterMs?: number; newContext?: () => Promise<BrowserContext> }): Browser {
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
    newContext:
      options?.newContext ??
      mock(async () => ({
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
});

test('pool deadline cannot stall when wall clock is frozen', async () => {
  const fixture = controlledContext(async () => fixture.page);
  const pool = new PlaywrightPool({
    maxPages: 1,
    launchBrowser: async () => makeFakeBrowser({ newContext: async () => fixture.context }),
  });
  await pool.initialize();
  await pool.acquire();
  const clock = spyOn(Date, 'now').mockReturnValue(1234567);
  const waiting = pool.acquire(25).then(
    () => 'unexpected page',
    (error: Error) => error.message,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      waiting,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('wall clock stalled'), 250);
      }),
    ]);
    expect(outcome).toContain('acquire timeout');
  } finally {
    clock.mockRestore();
    if (timer) clearTimeout(timer);
    await pool.shutdown();
    await waiting;
  }
});

test('pending release from disconnected browser never enters replacement free pool', async () => {
  const reset = deferred<void>();
  const old = controlledContext(async () => old.page);
  old.page.setContent = mock(() => reset.promise);
  const next = controlledContext(async () => next.page);
  const third = controlledContext(async () => third.page);
  const nextContext = mock(async () => next.context)
    .mockResolvedValueOnce(next.context)
    .mockResolvedValue(third.context);
  const first = makeFakeBrowser({ newContext: async () => old.context });
  const second = makeFakeBrowser({ newContext: nextContext });
  const launch = mock(async () => first)
    .mockResolvedValueOnce(first)
    .mockResolvedValue(second);
  const pool = new PlaywrightPool({ maxPages: 2, launchBrowser: launch });
  await pool.initialize();
  const prior = await pool.acquire();
  const releasing = pool.release(prior);
  await first.close();
  const replacement = await pool.acquire();
  reset.resolve();
  await releasing;
  try {
    const leased = await pool.acquire();
    expect(leased).not.toBe(prior);
    expect(leased).not.toBe(replacement);
    expect(leased).toBe(third.page);
    expect(replacement).toBe(next.page);
  } finally {
    await pool.shutdown();
  }
});

test('stale disconnect from old browser cannot clear its replacement', async () => {
  const next = controlledContext(async () => next.page);
  const first = makeFakeBrowser();
  const second = makeFakeBrowser({ newContext: async () => next.context });
  const launch = mock(async () => first)
    .mockResolvedValueOnce(first)
    .mockResolvedValue(second);
  const pool = new PlaywrightPool({ launchBrowser: launch });
  await pool.initialize();
  await first.close();
  await pool.acquire();
  await first.close();
  await pool.initialize();
  try {
    expect(launch).toHaveBeenCalledTimes(2);
  } finally {
    await pool.shutdown();
  }
});

test('double release cannot lease the same page to two consumers', async () => {
  const first = controlledContext(async () => first.page),
    second = controlledContext(async () => second.page);
  const contexts = mock(async () => first.context)
    .mockResolvedValueOnce(first.context)
    .mockResolvedValue(second.context);
  const pool = new PlaywrightPool({
    maxPages: 2,
    launchBrowser: async () => makeFakeBrowser({ newContext: contexts }),
  });
  await pool.initialize();
  const page = await pool.acquire();
  await pool.release(page);
  await pool.release(page);
  try {
    const a = await pool.acquire(),
      b = await pool.acquire();
    expect(a).not.toBe(b);
  } finally {
    await pool.shutdown();
  }
});
