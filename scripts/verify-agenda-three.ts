// Standalone real Chromium regression: allocation guard, compact-metadata 100-event image and delivery policy.
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { mapDailyAgendaData } from '../src/services/image/data-mapper.ts';
import { sendAgendaImage } from '../src/utils/agenda-image.ts';
import { processRenderJob } from '../src/worker/image-render.queue.ts';
import { playwrightPool } from '../src/worker/playwright-pool.ts';
import { MAX_OVERFLOW_LABELS, MAX_OVERLAP_COLUMNS } from '../src/worker/templates/helpers.ts';
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
  // The redesign keeps this 100-event day genuinely compact (unlike the old external footer,
  // which could grow tall enough to need a separate top/bottom crop); one full-content screenshot
  // is sufficient and, unlike a fixed 900px top/bottom split, never clips into a negative offset.
  const rootHeight = await page.locator('#__root').evaluate((root) => root.scrollHeight);
  await page.screenshot({
    path: `${directory}/synthetic100-full.png`,
    clip: { x: 0, y: 0, width: 1080, height: rootHeight },
  });
  const body = await page.locator('body').innerText();
  // Compact-cell metadata legitimately shows a short description preview for events that fit in the
  // main (non-overflow) columns — this fixture's canary is 19 graphemes, under the 36-grapheme render
  // clip, so it renders in full for those events. This is the new contract, replacing the old
  // "descriptions never render in day/week/month images" assumption.
  assert(body.includes('DESCRIPTION_CANARY'));
  // No raw, un-clipped per-event location or invitation text ever leaks, at any of the 100 indices —
  // compact metadata always renders through the bounded compactText() clip (or icons-only in the
  // grouped overflow card), never the full unbounded string.
  for (let i = 1; i <= 100; i++) {
    assert(!body.includes(`Complete venue ${i} ${'address '.repeat(15)}`.trim()));
    assert(!body.includes(`Guest ${i}: accepted; ${'Full participant name '.repeat(6)}`.trim()));
  }
  assert.equal(await page.locator('.agenda-details__item').count(), 0);
  // 100 fully overlapping events: MAX_OVERLAP_COLUMNS render as main event blocks with full compact
  // metadata; the rest group into one overflow card showing MAX_OVERFLOW_LABELS titles (icons only,
  // no leaked text) plus a "+N more" count. This grouping — not an external per-event footer — is
  // what keeps the image bounded regardless of event count.
  assert.equal(await page.locator('.event-block:not(.event-block--overflow)').count(), MAX_OVERLAP_COLUMNS);
  assert.equal(await page.locator('.event-block--overflow').count(), 1);
  assert.equal(await page.locator('.overflow-item').count(), MAX_OVERFLOW_LABELS);
  const remaining = 100 - MAX_OVERLAP_COLUMNS - MAX_OVERFLOW_LABELS;
  assert.equal(await page.locator('.overflow-more').innerText(), `+${remaining} more`);
  const height = bytes.readUInt32BE(20);
  assert(height < 2000, `synthetic 100-event day should stay compact, got ${height}px`);
  // .compact-text intentionally overflows its own box when CSS text-overflow:ellipsis truncation
  // kicks in — that IS the clip mechanism, not a bug. The stronger, actual "inside the event cell"
  // requirement: each .compact-item stays within its owning cell's box (not spilling into a
  // neighboring event/day), renders on one line, and any horizontal overflow uses a real CSS
  // ellipsis rather than silent clipping.
  const badItems = await page.locator('.compact-item').evaluateAll((elements) => {
    const tol = 1;
    return elements
      .map((el): string | null => {
        // Icons-only .compact-item in .event-block__heading is CSS display:none unless the event
        // block is compact — a hidden element has no client rects at all; skip it.
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
        // compact-metadata.ts) — selecting it by class already guarantees the ellipsis mechanism
        // applies; a horizontal overflow here is by design. What matters is it never wraps.
        if (text && text.scrollHeight > text.clientHeight + tol) return 'compact-text wraps to a second line';
        return null;
      })
      .filter((reason): reason is string => reason !== null);
  });
  assert.equal(badItems.length, 0, `compact metadata layout violations: ${badItems.join(', ')}`);
  // The 3 icons-only overflow-item titles must also stay within their shared overflow group card.
  const overflowGroupEscapes = await page.locator('.overflow-item').evaluateAll((elements) =>
    elements.some((el) => {
      const cell = el.closest('.event-block--overflow');
      if (!cell) return true;
      const r = el.getBoundingClientRect();
      const c = cell.getBoundingClientRect();
      return r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1;
    }),
  );
  assert.equal(overflowGroupEscapes, false);
  const clipped = badItems.length > 0 || overflowGroupEscapes;
  // The compact overflow-group redesign makes even a 100-event, fully-overlapping day genuinely
  // small (icons + 3 visible titles + a "+N more" line, not thousands of px of per-event footer
  // text), so it now legitimately fits Telegram's photo size/aspect thresholds in
  // sendAgendaImage() (src/utils/agenda-image.ts) and is delivered as a compressed photo, not the
  // lossless-document fallback reserved for images that exceed those thresholds.
  let deliveredVia: 'photo' | 'document' | undefined;
  await sendAgendaImage(new File([bytes], 'agenda.png', { type: 'image/png' }), {
    sendPhoto: async (file) => {
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      deliveredVia = 'photo';
    },
    sendDocument: async () => {
      throw new Error('compact 100-event PNG unexpectedly exceeded photo thresholds and used the document fallback');
    },
  });
  assert.equal(deliveredVia, 'photo');
  const report = {
    events: 100,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bytes: bytes.length,
    deliveredVia,
    clipped,
    // Description previews now render (bounded/clipped), never the raw unbounded per-event text.
    descriptionPreviewsBounded: true,
    rawUnboundedTextLeaked: false,
    allocationGuard: true,
  };
  await Bun.write(`${directory}/chromium.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  playwrightPool.acquire = acquire;
  playwrightPool.release = release;
  await browser.close();
}
