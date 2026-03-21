import { chromium } from 'playwright';

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

export async function playwrightAction(
  params: PlaywrightAction,
  timeoutMs = 30_000,
): Promise<PlaywrightResult> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
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
    await browser.close();
  }
}
