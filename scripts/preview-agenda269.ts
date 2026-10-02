// Local Chromium proof of the production agenda templates; no server or external requests.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { agendaImages } from '../test/fixtures/agenda269-images.ts';

const phase = process.argv[2] ?? 'after';
if (!['before', 'after'].includes(phase)) throw new Error('Expected before or after');
const directory = '/tmp/hcb-agenda269';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 800 } });
  await page.route('**/*', (route) => route.abort());
  const results = [];
  for (const image of agendaImages()) {
    await page.setContent(image.html, { waitUntil: 'load' });
    await page.evaluate('document.fonts.ready');
    const height = await page.locator('#__root').evaluate((root) => root.scrollHeight);
    await page.setViewportSize({ width: 1080, height });
    if (phase === 'after') {
      const body = await page.locator('body').innerText();
      if (body.includes('DESCRIPTION_ONLY_TEXT') || image.html.includes('DESCRIPTION_ONLY_TEXT'))
        throw new Error(`${image.name}: description leaked`);
      const details = page.locator('.agenda-details__item, .card__location, .card__status');
      if ((await details.count()) !== (image.name === 'event-card' ? 2 : 8)) {
        throw new Error(`${image.name}: missing details`);
      }
      const clipped = await page
        .locator(
          '.agenda-details__item, .agenda-details__item *, .card__location, .card__location *, .card__status, .card__status *',
        )
        .evaluateAll((elements) =>
          elements.some((element) => {
            const rect = element.getBoundingClientRect();
            return (
              element.scrollWidth > element.clientWidth + 1 ||
              element.scrollHeight > element.clientHeight + 1 ||
              rect.left < 0 ||
              rect.right > 1080 ||
              rect.bottom > (element.ownerDocument.getElementById('__root')?.scrollHeight ?? 0)
            );
          }),
        );
      if (clipped) throw new Error(`${image.name}: clipped details`);
      if (!body.includes('LongLocation'.repeat(35))) throw new Error(`${image.name}: missing long location`);
    }
    const path = `${directory}/${phase}-${image.name}.png`;
    await page.screenshot({ path, clip: { x: 0, y: 0, width: 1080, height } });
    results.push({ name: image.name, path, width: 1080, height, detailsChecked: phase === 'after' });
  }
  await Bun.write(`${directory}/${phase}.json`, JSON.stringify(results, null, 2));
  console.log(`${phase}: ${results.length} Chromium previews saved to ${directory}`);
} finally {
  await browser.close();
}
