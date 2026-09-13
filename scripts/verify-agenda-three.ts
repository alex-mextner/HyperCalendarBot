// Standalone real Chromium regression: allocation guard, complete 100-event PNG and delivery policy.
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { mapDailyAgendaData } from '../src/services/image/data-mapper.ts';
import { sendAgendaImage } from '../src/utils/agenda-image.ts';
import { processRenderJob } from '../src/worker/image-render.queue.ts';
import { playwrightPool } from '../src/worker/playwright-pool.ts';
import { THEME_LIGHT } from '../src/worker/templates/themes.ts';
import { agendaEvent } from '../test/fixtures/agenda269.ts';

const directory = 'logs/agenda-three';
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1080, height: 800 }, deviceScaleFactor: 2 });
await page.route('**/*', (route) => route.abort());
const acquire = playwrightPool.acquire;
const release = playwrightPool.release;
playwrightPool.acquire = async () => page;
playwrightPool.release = async () => {};
try {
  const data = mapDailyAgendaData({
    occurrences: Array.from({ length: 100 }, (_, i) => ({
      event: agendaEvent({
        id: i + 1,
        title: `Synthetic event ${i + 1}`,
        description: 'DESCRIPTION_CANARY',
        location: `Complete venue ${i + 1} ${'address '.repeat(15)}`,
        displayMetadata: { invitationStatus: `Guest ${i + 1}: accepted; ${'Full participant name '.repeat(6)}` },
      }),
      occurrence_start: '2026-03-11T09:00:00Z',
      occurrence_end: '2026-03-11T10:00:00Z',
      is_recurring: false,
      is_exception: false,
    })),
    dateIso: '2026-03-11',
    timezone: 'UTC',
    locale: 'en',
    theme: THEME_LIGHT,
  });
  const evaluate = page.evaluate.bind(page);
  const viewport = page.setViewportSize.bind(page);
  let allocated = false;
  // Inject only the measured layout height; forbid a huge allocation even during the red run.
  page.evaluate = async () => 1_000_000;
  page.setViewportSize = async () => {
    allocated = true;
    throw new Error('Unsafe viewport allocation attempted');
  };
  await assert.rejects(processRenderJob({ type: 'daily-agenda', data, userId: 1 }), /too large|allocation limit/i);
  assert.equal(allocated, false);
  page.evaluate = evaluate;
  page.setViewportSize = viewport;
  const result = await processRenderJob({ type: 'daily-agenda', data, userId: 1 });
  const bytes = Buffer.from(result.bufferBase64, 'base64');
  await Bun.write(`${directory}/synthetic100.png`, bytes);
  await page.screenshot({ path: `${directory}/synthetic100-top.png`, clip: { x: 0, y: 0, width: 1080, height: 900 } });
  await page.screenshot({
    path: `${directory}/synthetic100-bottom.png`,
    clip: {
      x: 0,
      y: (await page.locator('#__root').evaluate((root) => root.scrollHeight)) - 900,
      width: 1080,
      height: 900,
    },
  });
  const body = await page.locator('body').innerText();
  assert(!body.includes('DESCRIPTION_CANARY'));
  const details = page.locator('.agenda-details__item');
  assert.equal(await details.count(), 100);
  for (let i = 1; i <= 100; i++) {
    assert(body.includes(`Complete venue ${i} ${'address '.repeat(15)}`.trim()));
    assert(body.includes(`Guest ${i}: accepted; ${'Full participant name '.repeat(6)}`.trim()));
  }
  const clipped = await details.evaluateAll((elements) =>
    elements.some((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1),
  );
  assert.equal(clipped, false);
  let delivered = false;
  await sendAgendaImage(new File([bytes], 'agenda.png', { type: 'image/png' }), {
    sendPhoto: async () => {
      throw new Error('100-event PNG incorrectly sent as photo');
    },
    sendDocument: async (file, options) => {
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      assert(options.caption.includes('lossless'));
      delivered = true;
    },
  });
  assert(delivered);
  const report = {
    events: 100,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bytes: bytes.length,
    document: delivered,
    clipped,
    descriptions: false,
    allocationGuard: true,
  };
  await Bun.write(`${directory}/chromium.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  playwrightPool.acquire = acquire;
  playwrightPool.release = release;
  await browser.close();
}
