# Daily Timeline Layout — Overlap & Scale Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the daily agenda timeline so short sequential events never visually overlap, overlapping events render side-by-side in capped columns, and overflow is shown as a "+N" indicator.

**Architecture:** Extract pixel-scale constants (`PX_PER_MIN`, `MIN_EVENT_DURATION_MIN`, `MAX_OVERLAP_COLUMNS`) to `helpers.ts`. Add `computeEventHeight()` that expands short events to the minimum height but clamps the expansion at the gap to the next sequential event in the same column (preventing visual overlap). Update `daily-agenda.ts` to use these constants throughout and render an overflow indicator block when `totalColumns > MAX_OVERLAP_COLUMNS`.

**Tech Stack:** TypeScript, Bun, `bun:test`, HTML template strings rendered by Playwright.

---

## File map

| File | Change |
|------|--------|
| `src/worker/templates/helpers.ts` | Add 3 exported constants + `computeEventHeight()` |
| `src/worker/templates/daily-agenda.ts` | Use constants, new height fn, overflow rendering, CSS hour-row height |
| `test/worker/templates/helpers.test.ts` | Tests for constants + `computeEventHeight` |
| `test/worker/templates/daily-agenda.test.ts` | Tests for layout — no visual overlap, overflow indicator |

---

## Task 1 — Constants + `computeEventHeight` in helpers.ts

**Files:**
- Modify: `src/worker/templates/helpers.ts`
- Modify: `test/worker/templates/helpers.test.ts`

### Background

`computeEventHeight` must prevent visual overlap between **sequential** (non-overlapping in time) events that share the same column. The trick: visual height may be expanded to `MIN_EVENT_DURATION_MIN` for readability, but must be **capped at the gap from this event's start to the next event's start in the same column**. This way, the next event's visual top is never lower than this event's visual bottom.

Formula:
```
durationMin  = endMinutes - startMinutes
expanded     = max(durationMin, MIN_EVENT_DURATION_MIN)
gapToNext    = nextSameColEvent.startMinutes - ev.startMinutes   (Infinity if none)
visual       = min(expanded, gapToNext)
height_px    = max(visual, durationMin) * PX_PER_MIN   ← never shrink below actual
```

- [ ] **Step 1: Write failing tests**

Add to `test/worker/templates/helpers.test.ts`:

```ts
import {
  MAX_OVERLAP_COLUMNS,
  MIN_EVENT_DURATION_MIN,
  PX_PER_MIN,
  computeEventColumns,
  computeEventHeight,
  // existing imports…
} from '../../../src/worker/templates/helpers.ts';

describe('layout constants', () => {
  test('PX_PER_MIN is 2', () => expect(PX_PER_MIN).toBe(2));
  test('MIN_EVENT_DURATION_MIN is 15', () => expect(MIN_EVENT_DURATION_MIN).toBe(15));
  test('MAX_OVERLAP_COLUMNS is 4', () => expect(MAX_OVERLAP_COLUMNS).toBe(4));
});

describe('computeEventHeight', () => {
  // single event — expands to minimum
  test('single 5-min event expands to MIN_EVENT_DURATION_MIN * PX_PER_MIN', () => {
    const events = [{ startMinutes: 540, endMinutes: 545 }];
    const cols = computeEventColumns(events);
    expect(computeEventHeight(events[0]!, 0, events, cols))
      .toBe(MIN_EVENT_DURATION_MIN * PX_PER_MIN); // 30
  });

  // single 30-min event — uses actual duration
  test('30-min event uses actual duration', () => {
    const events = [{ startMinutes: 540, endMinutes: 570 }];
    const cols = computeEventColumns(events);
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(60);
  });

  // two sequential 5-min events — first is clamped to gap, no visual overlap
  test('sequential 5-min events: first clamped to gap', () => {
    const events = [
      { startMinutes: 540, endMinutes: 545 },
      { startMinutes: 545, endMinutes: 550 },
    ];
    const cols = computeEventColumns(events);
    // gap = 545 - 540 = 5 min; expanded = 15; clamped = min(15,5) = 5; max(5,5)*2 = 10
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(10);
    // last event has no next → expands to 30
    expect(computeEventHeight(events[1]!, 1, events, cols)).toBe(30);
  });

  // sequential events with 20-min gap — gap is larger than MIN, so expansion wins
  test('20-min gap allows full expansion', () => {
    const events = [
      { startMinutes: 540, endMinutes: 545 },
      { startMinutes: 560, endMinutes: 600 },
    ];
    const cols = computeEventColumns(events);
    // gap = 560-540 = 20min * 2 = 40px; expanded = 30px; min(30,40) = 30
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(30);
  });

  // overlapping events are in different columns — don't interfere
  test('overlapping events in different columns do not affect each other height', () => {
    const events = [
      { startMinutes: 540, endMinutes: 600 }, // col 0
      { startMinutes: 550, endMinutes: 610 }, // col 1
    ];
    const cols = computeEventColumns(events);
    // no next event in same column → both expand normally
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(60 * PX_PER_MIN / PX_PER_MIN * PX_PER_MIN);
    // 60min * 2 = 120
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(120);
    expect(computeEventHeight(events[1]!, 1, events, cols)).toBe(120);
  });

  // actual 30-min events sequential — no expansion needed, no clamping
  test('30-min sequential events use actual height without clamping', () => {
    const events = [
      { startMinutes: 540, endMinutes: 570 },
      { startMinutes: 570, endMinutes: 600 },
    ];
    const cols = computeEventColumns(events);
    // gap to next = 570-540 = 30min = 60px; actual = 60px; min(60,60) = 60
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(60);
    expect(computeEventHeight(events[1]!, 1, events, cols)).toBe(60);
  });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
bun test test/worker/templates/helpers.test.ts 2>&1 | tail -10
```
Expected: fail on `computeEventHeight` and constants not found.

- [ ] **Step 3: Add constants and `computeEventHeight` to helpers.ts**

Add after the closing `}` of `computeEventColumns`:

```ts
// ── Timeline layout constants ──────────────────────────────────────────────

/** Pixels per minute on the daily timeline (1 hour = 60 * PX_PER_MIN px). */
export const PX_PER_MIN = 2;

/** Minimum visual event height in minutes; short events expand to this for readability. */
export const MIN_EVENT_DURATION_MIN = 15;

/** Max side-by-side columns for overlapping events; beyond this an overflow indicator renders. */
export const MAX_OVERLAP_COLUMNS = 4;

/**
 * Computed rendered height (px) for one event on the daily timeline.
 *
 * Expands short events to MIN_EVENT_DURATION_MIN for readability, then caps the
 * expansion at the gap to the next sequential event in the same column so that
 * adjacent events never visually overlap. Never shrinks below the actual duration.
 */
export function computeEventHeight(
  event: TimeRange,
  eventIdx: number,
  allEvents: ReadonlyArray<TimeRange>,
  columns: ReadonlyArray<EventColumn>,
): number {
  const durationMin = event.endMinutes - event.startMinutes;
  const expandedDuration = Math.max(durationMin, MIN_EVENT_DURATION_MIN);

  // Nearest sequential event in the same column (starts at or after this event ends).
  const myColumn = columns[eventIdx]!.column;
  let nextSameColStart = Infinity;
  for (let j = 0; j < allEvents.length; j++) {
    if (j === eventIdx) continue;
    if (columns[j]?.column !== myColumn) continue;
    const other = allEvents[j]!;
    if (other.startMinutes < event.endMinutes) continue; // time-overlapping → different column
    if (other.startMinutes < nextSameColStart) nextSameColStart = other.startMinutes;
  }

  // Gap from THIS event's start to next event's start limits visual height.
  // (visual tops are spaced by startMinutes, so height ≤ gap prevents overlap)
  const maxDuration = isFinite(nextSameColStart)
    ? nextSameColStart - event.startMinutes
    : Infinity;

  const visualDuration = isFinite(maxDuration)
    ? Math.min(expandedDuration, maxDuration)
    : expandedDuration;

  return Math.max(visualDuration, durationMin) * PX_PER_MIN;
}
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
bun test test/worker/templates/helpers.test.ts 2>&1 | tail -5
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/worker/templates/helpers.ts test/worker/templates/helpers.test.ts
git commit -m "feat(timeline): add PX_PER_MIN, MIN_EVENT_DURATION_MIN, MAX_OVERLAP_COLUMNS, computeEventHeight"
```

---

## Task 2 — Update daily-agenda.ts

**Files:**
- Modify: `src/worker/templates/daily-agenda.ts`
- Modify: `test/worker/templates/daily-agenda.test.ts`

### What changes in daily-agenda.ts

**Import line** — add the four new exports:
```ts
import {
  MAX_OVERLAP_COLUMNS,
  MIN_EVENT_DURATION_MIN,
  PX_PER_MIN,
  computeEventColumns,
  computeEventHeight,
  escapeHtml,
  formatTime,
} from './helpers.ts';
```

**`renderTimeline`** — three structural changes:

1. **All pixel positions use `PX_PER_MIN`:**
   ```ts
   const containerHeight = totalMinutes * PX_PER_MIN;
   // hour rows:
   top: (h - minHour) * 60 * PX_PER_MIN
   // events:
   const top = (ev.startMinutes - minHour * 60) * PX_PER_MIN;
   // now-line:
   const top = (currentTimeMinutes - minHour * 60) * PX_PER_MIN;
   ```

2. **Event height via `computeEventHeight`** (replaces the old `Math.max(..., 20)`):
   ```ts
   const height = computeEventHeight(ev, i, timedEvents, cols);
   ```
   Compact threshold: `height <= MIN_EVENT_DURATION_MIN * PX_PER_MIN` (= 30px).

3. **Column width uses `effectiveCols`** (caps at `MAX_OVERLAP_COLUMNS`):
   ```ts
   const effectiveCols = Math.min(col.totalColumns, MAX_OVERLAP_COLUMNS);
   const widthPct = 100 / effectiveCols;
   const leftPct = col.column * widthPct;
   ```
   Overflow condition:
   ```ts
   if (col.totalColumns > MAX_OVERLAP_COLUMNS && col.column >= MAX_OVERLAP_COLUMNS - 1) {
     // collect overflow item, skip normal render
   }
   ```

**Overflow indicator rendering** — merge overlapping overflow items into blocks, one `event-block--overflow` div per block:
```ts
// Collect overflow items while building eventBlocksHtml:
const overflowItems: Array<{ top: number; endPx: number }> = [];
// …inside loop, when isOverflow:
overflowItems.push({ top, endPx: top + height });

// After loop — merge overlapping items:
const sorted = overflowItems.sort((a, b) => a.top - b.top);
const blocks: Array<{ top: number; endPx: number; count: number }> = [];
for (const item of sorted) {
  const last = blocks[blocks.length - 1];
  if (last && item.top < last.endPx) {
    last.endPx = Math.max(last.endPx, item.endPx);
    last.count++;
  } else {
    blocks.push({ top: item.top, endPx: item.endPx, count: 1 });
  }
}

const overflowWPct = 100 / MAX_OVERLAP_COLUMNS;
const overflowLPct = (MAX_OVERLAP_COLUMNS - 1) * overflowWPct;
const overflowHtml = blocks.map(({ top, endPx, count }) => {
  const h = Math.max(endPx - top, MIN_EVENT_DURATION_MIN * PX_PER_MIN);
  const compact = h <= MIN_EVENT_DURATION_MIN * PX_PER_MIN;
  return `<div class="event-block event-block--overflow${compact ? ' event-block--compact' : ''}"
    style="top:${top}px;height:${h}px;left:calc(${overflowLPct}%);width:calc(${overflowWPct}% - 8px);">
    <div class="event-block__overflow-count">+${count}</div>
  </div>`;
}).join('');
```

**CSS** — two additions:
```css
/* was hardcoded 60px, now scales with PX_PER_MIN */
.timeline__hour-row {
  height: ${60 * PX_PER_MIN}px;
  …
}

/* overflow indicator */
.event-block--overflow {
  display: flex;
  align-items: center;
  justify-content: center;
  border-left: 4px solid ${t.textSecondary}40;
  background: ${t.cardBg};
  color: ${t.textSecondary};
}
.event-block__overflow-count {
  font-size: 18px;
  font-weight: 700;
  opacity: 0.7;
}
```

- [ ] **Step 1: Write failing tests**

Add to `test/worker/templates/daily-agenda.test.ts`:

```ts
import { MAX_OVERLAP_COLUMNS, MIN_EVENT_DURATION_MIN, PX_PER_MIN } from '../../../src/worker/templates/helpers.ts';

// helper
function ev(id: number, start: number, end: number, color = '#6366F1') {
  return { id, title: `Event ${id}`, startMinutes: start, endMinutes: end, calendarColor: color, isAllDay: false };
}

test('event top position scales with PX_PER_MIN', () => {
  const html = dailyAgendaTemplate.render(makeData({
    eventCount: 1,
    timedEvents: [ev(1, 540, 600)],
  }));
  // minHour = floor(540/60) - 1 = 8; top = (540 - 8*60) * PX_PER_MIN = (540-480)*2 = 120
  expect(html).toContain('top:120px');
});

test('sequential 5-min events do not visually overlap', () => {
  const html = dailyAgendaTemplate.render(makeData({
    eventCount: 2,
    timedEvents: [ev(1, 540, 545), ev(2, 545, 550)],
  }));
  // Event 1: top=0px (relative to minHour), height=10px (clamped to gap 5min*2)
  // Event 2: top=10px, height=30px (expanded, no next event)
  // Key: event 2 top (10px) >= event 1 top + height (0+10=10) → no overlap
  expect(html).toContain('top:10px'); // event 2 top
  // Event 1 height must be <= gap (10px)
  const match = html.match(/top:0px.*?height:(\d+)px/s);
  const height1 = match ? Number.parseInt(match[1]!) : 0;
  expect(height1).toBeLessThanOrEqual(10);
});

test('two overlapping events render side by side (50% width each)', () => {
  const html = dailyAgendaTemplate.render(makeData({
    eventCount: 2,
    timedEvents: [ev(1, 540, 600), ev(2, 560, 620)],
  }));
  expect(html).toContain('width:calc(50% - 8px)');
});

test('overflow indicator appears when more than MAX_OVERLAP_COLUMNS events overlap', () => {
  const overlapping = Array.from({ length: MAX_OVERLAP_COLUMNS + 1 }, (_, i) =>
    ev(i + 1, 540, 600, '#6366F1'));
  const html = dailyAgendaTemplate.render(makeData({
    eventCount: overlapping.length,
    timedEvents: overlapping,
  }));
  expect(html).toContain('event-block--overflow');
  expect(html).toContain('overflow-count');
});

test('no overflow indicator for exactly MAX_OVERLAP_COLUMNS events', () => {
  const events = Array.from({ length: MAX_OVERLAP_COLUMNS }, (_, i) =>
    ev(i + 1, 540, 600, '#6366F1'));
  const html = dailyAgendaTemplate.render(makeData({
    eventCount: events.length,
    timedEvents: events,
  }));
  expect(html).not.toContain('event-block--overflow');
});

test('hour row height scales with PX_PER_MIN', () => {
  const html = dailyAgendaTemplate.render(makeData({
    eventCount: 1,
    timedEvents: [ev(1, 540, 600)],
  }));
  expect(html).toContain(`height: ${60 * PX_PER_MIN}px`);
});

test('compact class for short events (≤ MIN_EVENT_DURATION_MIN * PX_PER_MIN px)', () => {
  // Two 5-min sequential events; first is clamped to 10px → compact
  const html = dailyAgendaTemplate.render(makeData({
    eventCount: 2,
    timedEvents: [ev(1, 540, 545), ev(2, 545, 550)],
  }));
  expect(html).toContain('event-block--compact');
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
bun test test/worker/templates/daily-agenda.test.ts 2>&1 | tail -10
```
Expected: new tests fail.

- [ ] **Step 3: Update import in daily-agenda.ts**

```ts
// old:
import { computeEventColumns, escapeHtml, formatTime } from './helpers.ts';
// new:
import {
  MAX_OVERLAP_COLUMNS,
  MIN_EVENT_DURATION_MIN,
  PX_PER_MIN,
  computeEventColumns,
  computeEventHeight,
  escapeHtml,
  formatTime,
} from './helpers.ts';
```

- [ ] **Step 4: Rewrite `renderTimeline` function**

Replace the entire `renderTimeline` function body with the new implementation (see Architecture section above). Key points:
- `containerHeight = totalMinutes * PX_PER_MIN`
- Hour row `top: (h - minHour) * 60 * PX_PER_MIN`
- Event `top = (ev.startMinutes - minHour * 60) * PX_PER_MIN`
- Event `height = computeEventHeight(ev, i, timedEvents, cols)`
- Compact: `height <= MIN_EVENT_DURATION_MIN * PX_PER_MIN`
- `effectiveCols = Math.min(col.totalColumns, MAX_OVERLAP_COLUMNS)`
- Overflow: collect, merge, render indicators
- `now-line top = (currentTimeMinutes - minHour * 60) * PX_PER_MIN`

- [ ] **Step 5: Update CSS in `css()` function**

Change `.timeline__hour-row { height: 60px }` → `height: ${60 * PX_PER_MIN}px`.

Add `.event-block--overflow` and `.event-block__overflow-count` CSS rules.

- [ ] **Step 6: Run tests — confirm PASS**

```bash
bun test test/worker/templates/ 2>&1 | tail -10
```
Expected: all pass.

- [ ] **Step 7: Lint**

```bash
bun run lint
```
Fix any issues: `bun run lint:fix`

- [ ] **Step 8: Full test suite**

```bash
bun test 2>&1 | tail -5
```
Expected: all pass, 0 fail.

- [ ] **Step 9: Commit**

```bash
git add src/worker/templates/daily-agenda.ts test/worker/templates/daily-agenda.test.ts
git commit -m "feat(timeline): scale by PX_PER_MIN, no visual overlap, overflow indicator"
```

---

## Done criteria

- `bun test` — 0 failures
- `bun run lint` — 0 warnings or errors
- Sequential 5-minute events no longer visually overlap
- `MAX_OVERLAP_COLUMNS + 1` concurrent events → `event-block--overflow` in HTML
- `MAX_OVERLAP_COLUMNS` concurrent events → no overflow block
- Hour row height = `60 * PX_PER_MIN` px
- All pixel positions scale with `PX_PER_MIN`
