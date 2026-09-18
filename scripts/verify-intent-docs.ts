import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const directory = resolve(process.argv[2] ?? '/tmp/hcb-intents-ssg-20260918');
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route('http://**/*', (r) => r.abort());
  await page.route('https://**/*', (r) => r.abort());
  await page.goto(pathToFileURL(resolve(import.meta.dir, '../docs/intents/index.html')).href);
  assert.equal(await page.locator('article').count(), 104);
  assert.equal(await page.locator('#count').innerText(), 'Показано: 104');
  assert.equal(await page.evaluate<boolean>('document.documentElement.scrollWidth > innerWidth'), false);
  await page.screenshot({ path: resolve(directory, 'catalogue104-desktop.png') });
  assert.equal(await page.locator('#scope option').count(), 3);
  for (const [index, value] of ['all', 'active', 'candidate'].entries()) {
    assert.equal(await page.locator('#scope option').nth(index).getAttribute('value'), value);
  }
  await page.locator('#scope').selectOption('active');
  assert.equal(await page.locator('article:not(.hidden)').count(), 6);
  await page.locator('#scope').selectOption('candidate');
  assert.equal(await page.locator('article:not(.hidden)').count(), 98);
  await page.locator('#search').fill('rename_event');
  assert.equal(await page.locator('article:not(.hidden)').count(), 1);
  assert.equal(await page.locator('article:not(.hidden) pre').isVisible(), false);
  await page.locator('article:not(.hidden) summary').click();
  assert.equal(await page.locator('article:not(.hidden) pre').isVisible(), true);
  await page.locator('article:not(.hidden) summary').click();
  assert.equal(await page.locator('article:not(.hidden) pre').isVisible(), false);
  await page.locator('#search').fill('');
  await page.locator('#scope').selectOption('all');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate<boolean>('document.documentElement.scrollWidth > innerWidth'), false);
  await page.screenshot({ path: resolve(directory, 'catalogue104-mobile.png') });
  console.log(
    JSON.stringify({
      catalogue: 104,
      active: 6,
      candidates: 98,
      search: true,
      details: true,
      desktopOverflow: false,
      mobileOverflow: false,
      images: [resolve(directory, 'catalogue104-desktop.png'), resolve(directory, 'catalogue104-mobile.png')],
    }),
  );
} finally {
  await browser.close();
}
