// Run after preview-intent-catalogue.ts, passing the directory it printed. Uses only a synthetic local page.
import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { seedIntents } from '../src/services/intent/seed-catalog.ts';
import { seedSearchText } from './intent-catalogue-page.ts';

// The preview renders every shipped seed, each also as an approved database row.
const seeds = seedIntents.length;
// A seed name that no other card's search text contains, so searching for it leaves one card.
const uniqueName = seedIntents
  .map((s) => s.canonical_name)
  .find((name) =>
    seedIntents.every(
      (other) =>
        other.canonical_name === name ||
        !seedSearchText(other.canonical_name).toLocaleLowerCase().includes(name.toLocaleLowerCase()),
    ),
  );
assert(uniqueName, 'no seed name is unique within the catalogue search text');

if (!process.argv[2]) {
  console.error('Usage: bun scripts/verify-intent-catalogue.ts <directory printed by preview-intent-catalogue.ts>');
  process.exit(2);
}
const directory = resolve(process.argv[2]);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  await page.route('http://**/*', (r) => r.abort());
  await page.route('https://**/*', (r) => r.abort());
  await page.goto(`file://${directory}/index.html`);
  assert((await page.locator('.synthetic').innerText()).includes('ДЕМОНСТРАЦИОННЫЕ'));
  assert.equal(await page.locator('.seed').count(), seeds);
  assert(!(await page.evaluate<boolean>('document.documentElement.scrollWidth > window.innerWidth')));
  await page.screenshot({ path: `${directory}/desktop.png`, fullPage: false });
  await page.locator('#search').fill(uniqueName);
  assert.equal(await page.locator('.seed:not(.hidden)').count(), 1);
  await page.locator('#search').fill('');
  await page.locator('#filter').selectOption('approved');
  assert.equal(await page.locator('tr[data-kind="approved"]:not(.hidden)').count(), seeds);
  await page.locator('#filter').selectOption('all');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(!(await page.evaluate<boolean>('document.documentElement.scrollWidth > window.innerWidth')));
  await page.screenshot({ path: `${directory}/mobile.png`, fullPage: false });
  console.log(
    JSON.stringify({
      synthetic: true,
      cards: seeds,
      filter: true,
      desktopOverflow: false,
      mobileOverflow: false,
      screenshots: [`${directory}/desktop.png`, `${directory}/mobile.png`],
    }),
  );
} finally {
  await browser.close();
}
