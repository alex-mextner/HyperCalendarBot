import { performance } from 'node:perf_hooks';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { imageLogger } from '../utils/logger.ts';

interface PoolOptions {
  maxPages?: number;
  maxUseCount?: number;
  maxAgeMs?: number;
  maxReinitAttempts?: number;
  /** Instance-scoped launch seam; tests must not replace the global Playwright module. */
  launchBrowser?: () => Promise<Browser>;
}

export class PlaywrightPool {
  private browser: Browser | null = null;
  private freePages: Page[] = [];
  private readonly pageBrowser = new WeakMap<Page, Browser>();
  private busyPages: Set<Page> = new Set();
  private pageUseCount: Map<Page, number> = new Map();
  private pageCreatedAt: Map<Page, number> = new Map();
  private reinitPromise: Promise<void> | null = null;
  private reinitAttempts = 0;
  private dead = false;
  private stopped = false;
  private initializationPromise: Promise<void> | null = null;

  private readonly maxPages: number;
  private readonly maxUseCount: number;
  private readonly maxAgeMs: number;
  private readonly maxReinitAttempts: number;
  private readonly launchBrowser: () => Promise<Browser>;

  constructor(options: PoolOptions = {}) {
    this.maxPages = options.maxPages ?? 4;
    this.maxUseCount = options.maxUseCount ?? 50;
    this.maxAgeMs = options.maxAgeMs ?? 300_000;
    this.maxReinitAttempts = options.maxReinitAttempts ?? 3;
    this.launchBrowser = options.launchBrowser ?? (() => chromium.launch({ args: ['--no-sandbox', '--disable-gpu'] }));
  }

  initialize(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('PlaywrightPool is shut down'));
    if (this.initializationPromise) return this.initializationPromise;
    if (this.browser) {
      if (this.browser.isConnected()) return Promise.resolve();
      this.handleBrowserDisconnect(this.browser);
      return (
        this.reinitPromise ??
        Promise.reject(new Error('PlaywrightPool is permanently disabled after repeated init failures'))
      );
    }
    this.initializationPromise = this.initializeBrowser().finally(() => {
      this.initializationPromise = null;
    });
    return this.initializationPromise;
  }

  private async initializeBrowser(): Promise<void> {
    const browser = await this.launchBrowser();
    if (!browser) {
      throw new Error('chromium.launch() returned no browser — Playwright browsers may not be installed');
    }
    // Shutdown may have begun while the launch was pending. Never publish or
    // attach recovery listeners to that late browser.
    if (this.stopped) {
      await browser.close();
      return;
    }
    this.browser = browser;
    this.reinitAttempts = 0;
    this.dead = false;
    this.browser.on('disconnected', () => this.handleBrowserDisconnect(browser));
  }

  private handleBrowserDisconnect(browser: Browser): void {
    // An old browser may finish emitting after a replacement has been installed.
    if (this.stopped || this.browser !== browser) return;
    this.freePages = [];
    this.busyPages.clear();
    this.pageUseCount.clear();
    this.pageCreatedAt.clear();
    this.browser = null;

    if (this.reinitAttempts >= this.maxReinitAttempts) {
      this.dead = true;
      imageLogger.error(
        { attempts: this.reinitAttempts },
        'PlaywrightPool permanently disabled — max reinit attempts exceeded',
      );
      return;
    }

    this.reinitAttempts++;
    const recovery: Promise<void> = this.initialize()
      .then(() => {
        if (!this.stopped) imageLogger.info('PlaywrightPool reinit succeeded after browser disconnect');
      })
      .catch((err) => {
        if (this.stopped) return;
        imageLogger.error(
          { err, attempt: this.reinitAttempts },
          'PlaywrightPool reinit failed after browser disconnect',
        );
        if (this.reinitAttempts >= this.maxReinitAttempts) {
          this.dead = true;
          imageLogger.error(
            { attempts: this.reinitAttempts },
            'PlaywrightPool permanently disabled — max reinit attempts exceeded',
          );
        }
      })
      .finally(() => {
        if (this.reinitPromise === recovery) this.reinitPromise = null;
      });
    this.reinitPromise = recovery;
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error('PlaywrightPool is shut down');
    if (this.dead) throw new Error('PlaywrightPool is permanently disabled after repeated init failures');
  }

  async acquire(timeoutMs = 10_000): Promise<Page> {
    this.assertRunning();

    const deadline = performance.now() + timeoutMs;
    let generationRecoveries = 0;

    while (true) {
      if (this.browser && !this.browser.isConnected()) this.handleBrowserDisconnect(this.browser);
      if (this.reinitPromise) {
        await this.reinitPromise;
      }

      this.assertRunning();

      // Return a free page if available
      if (this.freePages.length > 0) {
        const page = this.freePages.pop()!;
        this.busyPages.add(page);
        return page;
      }

      // Create a new page if under limit
      const totalPages = this.freePages.length + this.busyPages.size;
      if (totalPages < this.maxPages) {
        const requestedBrowser = this.browser;
        try {
          const { page, browser } = await this.createPage();
          try {
            this.assertRunning();
            if (this.browser !== browser) throw new Error('PlaywrightPool browser changed during page creation');
          } catch (error) {
            await page
              .context()
              .close()
              .catch(() => {});
            this.pageUseCount.delete(page);
            this.pageCreatedAt.delete(page);
            throw error;
          }
          this.busyPages.add(page);
          return page;
        } catch (error) {
          this.assertRunning();
          // Retry observed browser-generation loss, never ordinary page errors.
          if (requestedBrowser && (this.browser !== requestedBrowser || !requestedBrowser.isConnected())) {
            if (++generationRecoveries > this.maxReinitAttempts) {
              throw new Error('acquire failed: browser recovery limit reached', { cause: error });
            }
            if (this.browser === requestedBrowser) this.handleBrowserDisconnect(requestedBrowser);
            if (performance.now() >= deadline)
              throw new Error('acquire timeout: browser recovery did not complete', { cause: error });
            continue;
          }
          throw error;
        }
      }

      // Wait or timeout
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error('acquire timeout: no page available within time limit');
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  async release(page: Page): Promise<void> {
    // Only the current lease owner may release a page, once.
    if (!this.busyPages.delete(page) || this.stopped) return;
    const browser = this.pageBrowser.get(page);
    if (!browser || browser !== this.browser) return;

    const useCount = (this.pageUseCount.get(page) ?? 0) + 1;
    this.pageUseCount.set(page, useCount);

    const createdAt = this.pageCreatedAt.get(page) ?? performance.now();
    const age = performance.now() - createdAt;

    if (useCount >= this.maxUseCount || age >= this.maxAgeMs) {
      try {
        await page.context().close();
      } catch {
        // context may already be closed (browser crash)
      }
      this.pageUseCount.delete(page);
      this.pageCreatedAt.delete(page);
      return;
    }

    try {
      await page.setContent('<html><body></body></html>');
      if (!this.stopped && this.browser === browser) this.freePages.push(page);
      else {
        this.pageUseCount.delete(page);
        this.pageCreatedAt.delete(page);
        await page
          .context()
          .close()
          .catch(() => {});
      }
    } catch {
      // page is no longer usable; discard it
      this.pageUseCount.delete(page);
      this.pageCreatedAt.delete(page);
    }
  }

  async shutdown(): Promise<void> {
    // Terminal close: intentional disconnection must never schedule recovery.
    this.stopped = true;
    if (this.initializationPromise) await this.initializationPromise.catch(() => {});
    if (this.reinitPromise) {
      await this.reinitPromise.catch(() => {});
    }
    const allPages = [...this.freePages, ...this.busyPages];
    for (const page of allPages) {
      try {
        await page.context().close();
      } catch {
        // ignore errors during shutdown
      }
    }
    this.freePages = [];
    this.busyPages.clear();
    this.pageUseCount.clear();
    this.pageCreatedAt.clear();

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private async createPage(): Promise<{ page: Page; browser: Browser }> {
    const browser = this.browser;
    if (!browser) throw new Error('PlaywrightPool not initialized — call initialize() first');
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({
        deviceScaleFactor: 2,
        viewport: { width: 1080, height: 800 },
      });
      this.assertRunning();
      if (this.browser !== browser) throw new Error('PlaywrightPool browser changed during page creation');
      const page = await context.newPage();
      this.assertRunning();
      if (this.browser !== browser) throw new Error('PlaywrightPool browser changed during page creation');
      this.pageBrowser.set(page, browser);
      this.pageUseCount.set(page, 0);
      this.pageCreatedAt.set(page, performance.now());
      return { page, browser };
    } catch (error) {
      if (context) await context.close().catch(() => {});
      // Normalize lifecycle loss only; ordinary browser failures keep their identity.
      this.assertRunning();
      throw error;
    }
  }
}

export const playwrightPool = new PlaywrightPool();
