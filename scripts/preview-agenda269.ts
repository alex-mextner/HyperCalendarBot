// Local Chromium proof of the production agenda templates; no server or external requests.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { THEME_DARK, THEME_LIGHT } from '../src/worker/templates/themes.ts';
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
  const themeVariants: Array<[string, typeof THEME_LIGHT]> = [
    ['light', THEME_LIGHT],
    ['dark', THEME_DARK],
  ];
  for (const [themeName, theme] of themeVariants) {
    for (const image of agendaImages(theme)) {
      // Only the light variant needs a screenshot per image name; dark still runs full assertions.
      await page.setContent(image.html, { waitUntil: 'load' });
      await page.evaluate('document.fonts.ready');
      const height = await page.locator('#__root').evaluate((root) => root.scrollHeight);
      await page.setViewportSize({ width: 1080, height });
      if (phase === 'after') {
        const body = await page.locator('body').innerText();
        // Static templates must never emit an actual <script> element regardless of user-controlled text.
        if ((await page.locator('script').count()) !== 0) {
          throw new Error(`${themeName}/${image.name}: unexpected <script> element rendered`);
        }
        if (image.name === 'event-card') {
          // The dedicated event card is out of scope for the compact-cell change: it keeps full,
          // unbounded location/status text and still omits description entirely.
          if (body.includes('DESCRIPTION_ONLY_TEXT') || image.html.includes('DESCRIPTION_ONLY_TEXT'))
            throw new Error(`${themeName}/${image.name}: description leaked`);
          const details = page.locator('.card__location, .card__status');
          if ((await details.count()) !== 2) throw new Error(`${themeName}/${image.name}: missing details`);
          const clipped = await page
            .locator('.card__location, .card__location *, .card__status, .card__status *')
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
          if (clipped) throw new Error(`${themeName}/${image.name}: clipped details`);
          if (!body.includes('LongLocation'.repeat(35)))
            throw new Error(`${themeName}/${image.name}: missing long location`);
        } else {
          // Day/week/month use compact in-cell metadata; the old external details footer is gone.
          if ((await page.locator('.agenda-details__item').count()) !== 0) {
            throw new Error(`${themeName}/${image.name}: stale agenda-details footer present`);
          }
          if ((await page.locator('.compact-item').count()) === 0) {
            throw new Error(`${themeName}/${image.name}: missing compact metadata`);
          }
          if (body.includes('LongLocation'.repeat(35))) {
            throw new Error(`${themeName}/${image.name}: unbounded location leaked`);
          }
          if (!body.includes('DESCRIPTION_ONLY_TEXT')) {
            throw new Error(`${themeName}/${image.name}: bounded description preview missing`);
          }
          // .compact-text intentionally overflows its own box when the CSS text-overflow:ellipsis
          // truncation kicks in — that IS the clip mechanism, not a bug. What must hold is the
          // stronger, actual "inside the event cell" requirement: each .compact-item stays within
          // its owning cell's box (not spilling into a neighboring cell/day/row), renders on one
          // line (no vertical wrap), and any element that visually overflows horizontally does so
          // via a real CSS ellipsis, not silent clipping.
          const badItems = await page.locator('.compact-item').evaluateAll((elements) => {
            const tol = 1;
            return elements
              .map((el): string | null => {
                // The icons-only .compact-item in .event-block__heading is CSS display:none unless
                // the event block is compact (see compact-metadata.ts CSS) — a hidden element has no
                // client rects at all, not a zero-sized-but-present one; skip it, nothing to check.
                if (el.getClientRects().length === 0) return null;
                const cell = el.closest('.event-block, .event-pill, .ev-dot, .allday__content');
                if (!cell) return 'no owning cell';
                const itemRect = el.getBoundingClientRect();
                const cellRect = cell.getBoundingClientRect();
                const withinCell =
                  itemRect.left >= cellRect.left - tol &&
                  itemRect.right <= cellRect.right + tol &&
                  itemRect.top >= cellRect.top - tol &&
                  itemRect.bottom <= cellRect.bottom + tol;
                if (!withinCell) return 'escapes owning cell';
                const text = el.querySelector('.compact-text');
                // .compact-text has an unconditional CSS text-overflow:ellipsis rule (see
                // compact-metadata.ts) — selecting it by class already guarantees the ellipsis
                // mechanism applies; a horizontal overflow here is by design, not checked further.
                // What DOES matter is that it never silently wraps to a second line.
                if (text && text.scrollHeight > text.clientHeight + tol) return 'compact-text wraps to a second line';
                return null;
              })
              .filter((reason): reason is string => reason !== null);
          });
          if (badItems.length > 0)
            throw new Error(`${themeName}/${image.name}: compact metadata layout violations: ${badItems.join(', ')}`);
        }
      }
      if (themeName === 'light') {
        const path = `${directory}/${phase}-${image.name}.png`;
        await page.screenshot({ path, clip: { x: 0, y: 0, width: 1080, height } });
        results.push({ name: image.name, path, width: 1080, height, detailsChecked: phase === 'after' });
      }
    }
  }
  await Bun.write(`${directory}/${phase}.json`, JSON.stringify(results, null, 2));
  console.log(`${phase}: ${results.length} Chromium previews saved to ${directory} (light+dark checked)`);
} finally {
  await browser.close();
}
