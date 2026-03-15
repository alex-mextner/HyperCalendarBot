import { type Browser, chromium, type Page } from 'playwright';

interface PoolOptions {
  maxPages?: number;
  maxUseCount?: number;
  maxAgeMs?: number;
}

export class PlaywrightPool {
  private browser: Browser | null = null;
  private freePages: Page[] = [];
  private busyPages: Set<Page> = new Set();
  private pageUseCount: Map<Page, number> = new Map();
  private pageCreatedAt: Map<Page, number> = new Map();

  private readonly maxPages: number;
  private readonly maxUseCount: number;
  private readonly maxAgeMs: number;

  constructor(options: PoolOptions = {}) {
    this.maxPages = options.maxPages ?? 4;
    this.maxUseCount = options.maxUseCount ?? 50;
    this.maxAgeMs = options.maxAgeMs ?? 300_000;
  }

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-gpu'],
    });
  }

  async acquire(timeoutMs = 10_000): Promise<Page> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      // Return a free page if available
      if (this.freePages.length > 0) {
        const page = this.freePages.pop()!;
        this.busyPages.add(page);
        return page;
      }

      // Create a new page if under limit
      const totalPages = this.freePages.length + this.busyPages.size;
      if (totalPages < this.maxPages) {
        const page = await this.createPage();
        this.busyPages.add(page);
        return page;
      }

      // Wait or timeout
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('acquire timeout: no page available within time limit');
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  async release(page: Page): Promise<void> {
    this.busyPages.delete(page);

    const useCount = (this.pageUseCount.get(page) ?? 0) + 1;
    this.pageUseCount.set(page, useCount);

    const createdAt = this.pageCreatedAt.get(page) ?? Date.now();
    const age = Date.now() - createdAt;

    if (useCount >= this.maxUseCount || age >= this.maxAgeMs) {
      await page.context().close();
      this.pageUseCount.delete(page);
      this.pageCreatedAt.delete(page);
      return;
    }

    await page.setContent('<html><body></body></html>');
    this.freePages.push(page);
  }

  async shutdown(): Promise<void> {
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

  private async createPage(): Promise<Page> {
    if (!this.browser) {
      throw new Error('PlaywrightPool not initialized — call initialize() first');
    }
    const context = await this.browser.newContext({
      deviceScaleFactor: 2,
      viewport: { width: 1080, height: 800 },
    });
    const page = await context.newPage();
    this.pageUseCount.set(page, 0);
    this.pageCreatedAt.set(page, Date.now());
    return page;
  }
}

export const playwrightPool = new PlaywrightPool();
