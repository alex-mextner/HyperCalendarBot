import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';
import { buildCatalogue } from './generate-intent-docs.ts';

const catalogue = buildCatalogue();
const total = catalogue.entries.length;
const directory = resolve(process.argv[2] ?? join(tmpdir(), 'hcb-intents-ssg'));
mkdirSync(directory, { recursive: true });

const countBy = (values: readonly string[]): { [key: string]: number } => {
  const counts: { [key: string]: number } = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};
const overflows = (page: Page): Promise<boolean> =>
  page.evaluate<boolean>('document.documentElement.scrollWidth > innerWidth');
const visibleCards = (page: Page): Promise<number> => page.locator('article[data-name]:not(.hidden)').count();

async function verifyFilters(page: Page): Promise<void> {
  for (const [category, expected] of Object.entries(countBy(catalogue.entries.map((e) => e.category)))) {
    await page.locator('#category').selectOption(category);
    assert.equal(await visibleCards(page), expected, `category ${category}`);
  }
  await page.locator('#category').selectOption('');
  for (const [risk, expected] of Object.entries(countBy(catalogue.entries.map((e) => e.risk)))) {
    await page.locator('#risk').selectOption(risk);
    assert.equal(await visibleCards(page), expected, `risk ${risk}`);
  }
  await page.locator('#risk').selectOption('');
  assert.equal(await visibleCards(page), total);
}

async function verifySearchAndDetails(page: Page): Promise<void> {
  const target = catalogue.entries[0]!;
  await page.locator('#search').fill(target.name);
  assert.ok((await visibleCards(page)) >= 1);
  assert.ok((await visibleCards(page)) < total);
  const card = page.locator(`article[data-name="${target.name}"]`);
  assert.equal(await card.isVisible(), true);
  assert.equal(await card.locator('> details h4').first().isVisible(), false);
  await card.locator('> details > summary').click();
  assert.equal(await card.locator('> details h4').first().isVisible(), true);
  await page.locator('#search').fill('нет-такого-правила-zzz');
  assert.equal(await visibleCards(page), 0);
  assert.equal(await page.locator('#empty').isVisible(), true);
  await page.locator('#search').fill('');
  assert.equal(await visibleCards(page), total);
}

async function verifyEngineAndLineage(page: Page): Promise<void> {
  const { source, database } = catalogue.lineage;
  assert.equal(await page.locator('#engine').isVisible(), true);
  assert.ok((await page.locator('#engine').innerText()).includes('Типы привязок'));
  const summary = page.locator('#lineage > details > summary').first();
  assert.ok((await summary.innerText()).includes(`(${source.total})`));
  assert.equal(await page.locator('#lineage table').first().isVisible(), false);
  await summary.click();
  assert.equal(await page.locator('#lineage table').first().isVisible(), true);
  const cohort = await page.locator('#lineage').innerText();
  if (database.provided) {
    assert.ok(cohort.includes(`(${database.total})`));
    assert.ok(cohort.includes(`слито ${database.merge}, переписано ${database.rewrite}, выведено ${database.retire}`));
  }
  for (const label of [`Слито в общие: ${source.merge}`, `переписано заново: ${source.rewrite}`])
    assert.ok(cohort.includes(label), label);
  assert.ok(
    (await page.locator('.metrics').innerText()).includes(`${source.merge} / ${source.rewrite} / ${source.retire}`),
  );
}

async function verifyLabels(page: Page): Promise<void> {
  for (const id of ['search', 'category', 'risk'])
    assert.equal(await page.locator(`label[for="${id}"]`).count(), 1, `label for ${id}`);
}

/** Follow the visible links with page JavaScript disabled, then check every complete workflow. */
async function verifyWorkflowPagesWithoutJavaScript(): Promise<void> {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage();
    await page.route('http://**/*', (route) => route.abort());
    await page.route('https://**/*', (route) => route.abort());
    const index = pathToFileURL(resolve(import.meta.dir, '../docs/intents/index.html')).href;
    await page.goto(index);
    const targets = new Map<string, typeof catalogue.entries>();
    for (const entry of catalogue.entries) {
      const link = page.locator(`article[data-name="${entry.name}"] a.workflow-link`);
      assert.equal(await link.count(), 1, entry.name);
      const href = await link.getAttribute('href');
      assert.ok(href, `workflow link for ${entry.name}`);
      const file = new URL(href, index);
      file.hash = '';
      const entries = targets.get(file.href) ?? [];
      entries.push(entry);
      targets.set(file.href, entries);
    }
    for (const [file, entries] of targets) {
      await page.goto(index);
      const first = entries[0]!;
      const card = page.locator(`article[data-name="${first.name}"]`);
      await card.locator('> details > summary').click();
      await card.locator('> details > details > summary').click();
      await card.locator('a.workflow-link').click();
      await page.waitForLoadState('load');
      assert.equal(page.url().split('#')[0], file);
      for (const entry of entries) {
        const block = page.locator(`section[id="${entry.name}"] > pre`);
        assert.equal(await block.isVisible(), true, entry.name);
        assert.equal(await block.textContent(), JSON.stringify(entry.workflow, null, 2), entry.name);
      }
      assert.equal(await overflows(page), false, file);
      await page.setViewportSize({ width: 360, height: 800 });
      assert.equal(await overflows(page), false, `${file} mobile`);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  } finally {
    await context.close();
  }
}

/** Without any installed font Chromium lays text out at zero height, so every innerText read comes back empty. */
async function verifyTextIsLaidOut(page: Page): Promise<void> {
  const height = await page.locator('h1').evaluate((heading) => heading.getBoundingClientRect().height);
  assert.ok(
    height > 0,
    'Chromium rendered the page heading with zero height: this host has no usable fonts (install fontconfig and a font, or set FONTCONFIG_FILE)',
  );
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.route('http://**/*', (r) => r.abort());
  await page.route('https://**/*', (r) => r.abort());
  await page.goto(pathToFileURL(resolve(import.meta.dir, '../docs/intents/index.html')).href);
  assert.equal(await page.locator('article[data-name]').count(), total);
  await verifyTextIsLaidOut(page);
  assert.equal(await page.locator('#count').innerText(), `Показано: ${total} из ${total}`);
  assert.equal(await overflows(page), false);
  await page.screenshot({ path: resolve(directory, 'catalogue-desktop.png') });
  await verifyLabels(page);
  await verifyWorkflowPagesWithoutJavaScript();
  await verifyFilters(page);
  await verifySearchAndDetails(page);
  await verifyEngineAndLineage(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator('#category').selectOption('');
  assert.equal(await overflows(page), false);
  await page.screenshot({ path: resolve(directory, 'catalogue-mobile.png') });
  console.log(
    JSON.stringify({
      catalogue: total,
      categories: countBy(catalogue.entries.map((e) => e.category)),
      risks: countBy(catalogue.entries.map((e) => e.risk)),
      lineage: {
        source: catalogue.lineage.source.total,
        database: catalogue.lineage.database.total,
      },
      search: true,
      filters: true,
      details: true,
      engine: true,
      workflowsWithoutJavaScript: true,
      desktopOverflow: false,
      mobileOverflow: false,
      images: [resolve(directory, 'catalogue-desktop.png'), resolve(directory, 'catalogue-mobile.png')],
    }),
  );
} finally {
  await browser.close();
}
