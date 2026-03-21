import { chromium } from 'playwright';
import type { Browser } from 'playwright';

export type PlaywrightAction =
  | { action: 'screenshot'; url?: string }
  | { action: 'navigate'; url: string }
  | { action: 'click'; url?: string; selector: string }
  | { action: 'fill'; url?: string; selector: string; value: string }
  | { action: 'extract'; url?: string; selector: string };

export interface PlaywrightResult {
  screenshot?: string;
  text?: string;
  url?: string;
}

// Persistent browser — launched on first use, closed after 5min idle
const IDLE_MS = 5 * 60 * 1000;
let sharedBrowser: Browser | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function getBrowser(): Promise<Browser> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (sharedBrowser?.isConnected()) {
    resetIdleTimer();
    return sharedBrowser;
  }

  sharedBrowser = await chromium.launch({ headless: true });
  sharedBrowser.on('disconnected', () => {
    sharedBrowser = null;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  });
  resetIdleTimer();
  return sharedBrowser;
}

function resetIdleTimer(): void {
  idleTimer = setTimeout(() => {
    sharedBrowser?.close().catch(() => {});
    sharedBrowser = null;
    idleTimer = null;
  }, IDLE_MS);
}

/** Explicitly close the browser (called on app quit). */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
}

export async function playwrightAction(
  params: PlaywrightAction,
  timeoutMs = 30_000,
): Promise<PlaywrightResult> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(timeoutMs);

    if (params.url) {
      await page.goto(params.url, { waitUntil: 'domcontentloaded' });
    }

    switch (params.action) {
      case 'screenshot': {
        const buf = await page.screenshot({ type: 'png' });
        return { screenshot: buf.toString('base64'), url: page.url() };
      }
      case 'navigate': {
        await page.goto(params.url, { waitUntil: 'load' });
        return { url: page.url() };
      }
      case 'click': {
        await page.click(params.selector);
        return { url: page.url() };
      }
      case 'fill': {
        await page.fill(params.selector, params.value);
        return { url: page.url() };
      }
      case 'extract': {
        const text = await page.$eval(params.selector, (el) => el.textContent ?? '');
        return { text, url: page.url() };
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
}
