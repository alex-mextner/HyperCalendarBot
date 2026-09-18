// Run after preview-intent-catalogue.ts. Uses only a synthetic local page.
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const directory = resolve(process.argv[2] ?? '/tmp/hcb-intent-catalogue/synthetic');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  await page.route('http://**/*', (r) => r.abort());
  await page.route('https://**/*', (r) => r.abort());
  await page.goto(`file://${directory}/index.html`);
  assert((await page.locator('.synthetic').innerText()).includes('ДЕМОНСТРАЦИОННЫЕ'));
  assert.equal(await page.locator('.seed').count(), 6);
  assert(!(await page.evaluate<boolean>('document.documentElement.scrollWidth > window.innerWidth')));
  await page.screenshot({ path: `${directory}/desktop.png`, fullPage: false });
  await page.locator('#search').fill('search_events');
  assert.equal(await page.locator('.seed:not(.hidden)').count(), 1);
  await page.locator('#search').fill('');
  await page.locator('#filter').selectOption('approved');
  assert.equal(await page.locator('tr[data-kind="approved"]:not(.hidden)').count(), 6);
  await page.locator('#filter').selectOption('all');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(!(await page.evaluate<boolean>('document.documentElement.scrollWidth > window.innerWidth')));
  await page.screenshot({ path: `${directory}/mobile.png`, fullPage: false });
  console.log(
    JSON.stringify({
      synthetic: true,
      cards: 6,
      filter: true,
      desktopOverflow: false,
      mobileOverflow: false,
      screenshots: [`${directory}/desktop.png`, `${directory}/mobile.png`],
    }),
  );
} finally {
  await browser.close();
}
