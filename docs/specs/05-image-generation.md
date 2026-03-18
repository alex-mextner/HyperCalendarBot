# Sub-Project #5: Image Generation

Generate shareable calendar agenda images (daily, weekly, event card) using HTML/CSS templates rendered via Playwright in a worker process.

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Template System](#2-template-system)
3. [Image Types](#3-image-types)
4. [Rendering Pipeline](#4-rendering-pipeline)
5. [Playwright Pooling](#5-playwright-pooling)
6. [BullMQ Job Definition](#6-bullmq-job-definition)
7. [Caching Strategy](#7-caching-strategy)
8. [Performance Considerations](#8-performance-considerations)
9. [Example Template: Daily Agenda](#9-example-template-daily-agenda)
10. [File Structure](#10-file-structure)
11. [API Surface](#11-api-surface)
12. [Mini App Auto-Timezone Detection](#12-mini-app-auto-timezone-detection)

---

## 1. Architecture Overview

```
Bot Process                          Worker Process
┌─────────────┐                     ┌──────────────────────┐
│  /agenda cmd │──BullMQ job───────>│  ImageRenderWorker   │
│  /week cmd   │                    │  ┌────────────────┐  │
│  /event cmd  │                    │  │ Template Engine │  │
│              │<──job result───────│  │  (HTML + CSS)   │  │
│  Send PNG    │   (Buffer)         │  ├────────────────┤  │
└─────────────┘                     │  │ PlaywrightPool │  │
                                    │  │  (Browser ctx)  │  │
                                    │  └────────────────┘  │
                                    └──────────────────────┘
                                              │
                                    ┌─────────┴──────────┐
                                    │   Redis (BullMQ)   │
                                    └────────────────────┘
```

The bot process never touches Playwright. It enqueues a BullMQ job with the data payload, the worker renders HTML to PNG, and the result comes back as a `Buffer`.

### Why not render in the bot process?

- Playwright is heavy (~200MB+ memory per browser instance)
- Rendering blocks the event loop; the bot must stay responsive
- Worker crash doesn't kill the bot
- Queue gives natural backpressure and retry semantics

---

## 2. Template System

### Engine Choice: Tagged Template Literals (no Handlebars)

Handlebars adds a dependency for something TypeScript can already do. We use a simple template function approach:

```ts
// src/worker/templates/types.ts
export interface TemplateRenderer<TData> {
  render(data: TData): string; // returns full HTML document
}
```

Each template is a module that exports a `render(data)` function returning a complete HTML string with inlined CSS. No partial files, no compilation step, no external assets.

### Why inline everything?

Playwright renders from `page.setContent(html)`, not from a URL. External CSS/fonts would require either:

- A local HTTP server (complexity)
- `file://` paths (fragile)

Instead: inline CSS in `<style>`, embed fonts as base64 `@font-face`, embed icons as inline SVG.

### Fonts

Bundle 2 font files (regular + bold) as base64 in a shared constant:

```ts
// src/worker/templates/fonts.ts
// Inter is ~100KB per weight as woff2 — acceptable for base64
export const FONT_INTER_REGULAR = "data:font/woff2;base64,...";
export const FONT_INTER_BOLD = "data:font/woff2;base64,...";

export const fontFaceCSS = `
  @font-face {
    font-family: 'Inter';
    font-weight: 400;
    src: url('${FONT_INTER_REGULAR}') format('woff2');
  }
  @font-face {
    font-family: 'Inter';
    font-weight: 700;
    src: url('${FONT_INTER_BOLD}') format('woff2');
  }
`;
```

### Theming

```ts
export interface Theme {
  name: string;
  bg: string;
  cardBg: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  border: string;
  eventColors: string[]; // palette for event blocks
}

export const THEME_LIGHT: Theme = {
  name: "light",
  bg: "#F8F9FA",
  cardBg: "#FFFFFF",
  textPrimary: "#1A1A2E",
  textSecondary: "#6B7280",
  accent: "#6366F1",
  border: "#E5E7EB",
  eventColors: ["#6366F1", "#EC4899", "#14B8A6", "#F59E0B", "#EF4444", "#8B5CF6"],
};

export const THEME_DARK: Theme = {
  name: "dark",
  bg: "#0F172A",
  cardBg: "#1E293B",
  textPrimary: "#F1F5F9",
  textSecondary: "#94A3B8",
  accent: "#818CF8",
  border: "#334155",
  eventColors: ["#818CF8", "#F472B6", "#2DD4BF", "#FBBF24", "#FB7185", "#A78BFA"],
};
```

User picks theme in settings; default is `light`.

### Locale

Templates receive a `locale: "ru" | "en"` field. Date formatting and labels (e.g., "Today", "Сегодня") are handled via a simple dictionary object, not `Intl` (because Playwright's Chromium may have limited locale data).

```ts
const labels = {
  ru: { today: "Сегодня", tomorrow: "Завтра", noEvents: "Нет событий", allDay: "Весь день" },
  en: { today: "Today", tomorrow: "Tomorrow", noEvents: "No events", allDay: "All day" },
};
```

---

## 3. Image Types

### 3.1 Daily Agenda (`daily-agenda`)

**Dimensions:** 1080 x dynamic height (typically 800-1600px depending on event count)

**Visual description:**

```
┌──────────────────────────────────────┐
│  ┌─ Header ───────────────────────┐  │
│  │      Tuesday, March 11         │  │
│  │      Сегодня  ·  5 events      │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌─ Timeline ─────────────────────┐  │
│  │ 08:00 ┊                        │  │
│  │ 09:00 ┊ ██████████████████████ │  │
│  │       ┊ █ Team standup        █ │  │
│  │       ┊ █ 09:00–09:30 · Zoom █ │  │
│  │       ┊ ██████████████████████ │  │
│  │ 10:00 ┊                        │  │
│  │ ------┊--- 10:15 now ---------│  │  <- current time line (red/accent)
│  │ 11:00 ┊ ██████████████████████ │  │
│  │       ┊ █ Design review      █ │  │
│  │       ┊ █ 11:00–12:00        █ │  │
│  │       ┊ █ Room 42            █ │  │
│  │       ┊ ██████████████████████ │  │
│  │ 12:00 ┊                        │  │
│  │  ...  ┊                        │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌─ All-day events ──────────────┐   │
│  │  Alex's Birthday              │   │
│  │  Company Holiday              │   │
│  └────────────────────────────────┘  │
│                                      │
│  ┌─ Footer ──────────────────────┐   │
│  │  HyperCalendar · @botname     │   │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

**Key details:**

- Hour markers on the left (08:00-23:00, only show hours that have events +/- 1h padding)
- Event blocks are colored rectangles (each calendar gets a color from the palette)
- Current time: dashed horizontal line with a dot, colored in accent/red
- All-day events shown in a separate section above the timeline
- Empty hours are collapsed (don't waste vertical space showing 6 empty hours)
- If no events: show a friendly "No events today" message with subtle illustration (inline SVG)
- Holiday indicator: subtle badge next to the date if it's a holiday
- Footer with bot branding (subtle, not obnoxious)

**Data contract:**

```ts
interface DailyAgendaData {
  date: string;           // ISO date "2026-03-11"
  dayOfWeek: string;      // "Tuesday" / "Вторник"
  dateFormatted: string;  // "March 11, 2026" / "11 марта 2026"
  relativeDay?: string;   // "Today" / "Сегодня" / undefined
  eventCount: number;
  currentTimeMinutes?: number; // minutes since midnight (615 = 10:15)
  isHoliday?: boolean;
  holidayName?: string;
  allDayEvents: AgendaEvent[];
  timedEvents: AgendaEvent[];
  theme: Theme;
  locale: "ru" | "en";
}

interface AgendaEvent {
  id: string;
  title: string;
  startMinutes: number;   // minutes since midnight
  endMinutes: number;
  location?: string;
  calendarColor: string;  // hex color
  calendarName?: string;
  isAllDay: boolean;
  emoji?: string;         // user-assigned or auto-detected
}
```

### 3.2 Weekly Overview (`weekly-overview`)

**Dimensions:** 1080 x ~900px (fixed, 7-column grid)

**Visual description:**

```
┌──────────────────────────────────────────────┐
│  Week of March 9-15, 2026                    │
│                                              │
│  Mon    Tue    Wed    Thu    Fri   Sat   Sun  │
│  ┌───┐  ┌───┐  ┌───┐  ┌───┐ ┌───┐ ┌───┐ ┌───┐
│  │ 9 │  │10 │  │11*│  │12 │ │13 │ │14 │ │15 │
│  │   │  │   │  │   │  │   │ │   │ │   │ │   │
│  │ # │  │ # │  │###│  │ # │ │   │ │ # │ │   │
│  │ # │  │   │  │## │  │   │ │   │ │   │ │   │
│  │   │  │   │  │#  │  │   │ │   │ │   │ │   │
│  │   │  │   │  │   │  │   │ │   │ │   │ │   │
│  │2ev│  │1ev│  │5ev│  │1ev│ │0  │ │1ev│ │0  │
│  └───┘  └───┘  └───┘  └───┘ └───┘ └───┘ └───┘
│                                              │
│  HyperCalendar · @botname                    │
└──────────────────────────────────────────────┘
```

**Key details:**

- 7 columns, each representing a day
- Today highlighted with an accent circle/dot around the day number
- Each day shows mini color blocks representing events (proportional to duration)
- Event count at the bottom of each column
- Weekend columns slightly muted background
- Static image; bot can offer `/day 12` to drill down

**Data contract:**

```ts
interface WeeklyOverviewData {
  weekLabel: string;       // "March 9-15, 2026"
  days: WeekDay[];
  todayIndex?: number;     // 0-6, which day is today (undefined if viewing past/future week)
  theme: Theme;
  locale: "ru" | "en";
}

interface WeekDay {
  dayNumber: number;
  dayName: string;         // "Mon" / "Пн"
  eventCount: number;
  isWeekend: boolean;
  events: MiniEvent[];     // simplified, just for color blocks
}

interface MiniEvent {
  startMinutes: number;
  endMinutes: number;
  color: string;
  isAllDay: boolean;
}
```

### 3.3 Event Card (`event-card`)

**Dimensions:** 1080 x ~600px

**Visual description:**

```
┌──────────────────────────────────────┐
│                                      │
│  ┌────────────────────────────────┐  │
│  │  |  Design Review              │  │  <- thick left border in calendar color
│  │  |                             │  │
│  │  |  Tuesday, March 11          │  │
│  │  |  11:00 - 12:00 (1h)        │  │
│  │  |  Room 42, Building A       │  │
│  │  |  Review Q1 design          │  │  <- description (first 2-3 lines)
│  │  |     proposals               │  │
│  │  |                             │  │
│  │  |  Alex, Maria, +3           │  │  <- attendees
│  │  |                             │  │
│  │  |  meet.google.com/abc       │  │  <- conference link
│  │  |                             │  │
│  │  └────────────────────────────┘  │
│  │                                   │
│  │  Work Calendar                    │
│  │  HyperCalendar · @botname        │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

**Key details:**

- Single event presented as a card
- Thick left border in calendar color
- All available metadata shown: time, location, description, attendees, link
- Description truncated to 3 lines max
- Attendees truncated to 3 names + overflow count
- Clean, shareable -- looks good when forwarded in Telegram

**Data contract:**

```ts
interface EventCardData {
  title: string;
  dateFormatted: string;   // "Tuesday, March 11, 2026"
  timeFormatted: string;   // "11:00 - 12:00"
  duration: string;        // "1h" / "30min" / "2h 15min"
  location?: string;
  description?: string;    // truncated to ~200 chars
  attendees?: string[];    // first 3 names
  attendeeOverflow?: number;
  conferenceLink?: string;
  calendarName: string;
  calendarColor: string;
  isAllDay: boolean;
  theme: Theme;
  locale: "ru" | "en";
}
```

---

## 4. Rendering Pipeline

### Flow

```
1. Bot command handler
   |
   +-- Validate input (date, event ID, etc.)
   +-- Fetch events from DB/Google Calendar
   +-- Build data payload (DailyAgendaData, etc.)
   |
   +-- Enqueue BullMQ job
       |
       v
2. Worker picks up job
   |
   +-- Select template by job.type
   +-- Call template.render(data) -> HTML string
   +-- Acquire Playwright page from pool
   +-- page.setContent(html, { waitUntil: "load" })
   +-- Measure actual content height via page.evaluate()
   +-- page.setViewportSize({ width: 1080, height: calculatedHeight })
   +-- const buffer = await page.screenshot({ type: "png", fullPage: true })
   +-- Release page back to pool
   |
   +-- Return { buffer, width, height }
       |
       v
3. Bot receives job result
   |
   +-- Send PNG to user via Telegram API
```

### Height Calculation

The template includes a self-reporting mechanism:

```ts
// In the HTML template, at the end of <body>:
// <div id="__root" style="width: 1080px; display: inline-block;">
//   ... all content ...
// </div>

// In the renderer:
await page.setContent(html, { waitUntil: "load" });
const height = await page.evaluate(() => {
  const root = document.getElementById("__root");
  return root ? root.scrollHeight : 800;
});
await page.setViewportSize({ width: 1080, height });
const buffer = await page.screenshot({
  type: "png",
  clip: { x: 0, y: 0, width: 1080, height },
});
```

This way the image height adapts to content -- 3 events produce a shorter image than 15.

### Screenshot Options

```ts
{
  type: "png",
  clip: { x: 0, y: 0, width: 1080, height },
  // No need for omitBackground -- we have our own bg
}
```

No JPEG -- PNG gives crisp text and smaller file sizes for graphics-heavy content with flat colors. Telegram handles PNG well.

---

## 5. Playwright Pooling

### Why Pool, Not Singleton?

ExpenseSyncBot uses a singleton browser with `newContext()` per request. That works when you have 1-2 requests/minute. For HyperCalendarBot, morning notification bursts could mean 50+ renders in a few seconds. A pool of browser contexts (not browsers) is better.

### Strategy: Single Browser, Context Pool

```ts
// src/worker/playwright-pool.ts

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

interface PooledPage {
  page: Page;
  context: BrowserContext;
  inUse: boolean;
  createdAt: number;
  useCount: number;
}

class PlaywrightPool {
  private browser: Browser | null = null;
  private pages: PooledPage[] = [];
  private readonly maxPages: number;
  private readonly maxUseCount: number; // recycle after N uses to prevent memory leaks
  private readonly maxAgeMs: number;    // recycle after N ms

  constructor(options?: { maxPages?: number; maxUseCount?: number; maxAgeMs?: number }) {
    this.maxPages = options?.maxPages ?? 4;
    this.maxUseCount = options?.maxUseCount ?? 50;
    this.maxAgeMs = options?.maxAgeMs ?? 5 * 60 * 1000; // 5 min
  }

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process", // reduces memory in containerized envs
      ],
    });
  }

  async acquire(): Promise<Page> {
    if (!this.browser) await this.initialize();

    // Find a free page
    const free = this.pages.find((p) => !p.inUse && !this.isStale(p));
    if (free) {
      free.inUse = true;
      free.useCount++;
      return free.page;
    }

    // Recycle stale pages
    await this.recycleStale();

    // Create new if under limit
    if (this.pages.length < this.maxPages) {
      const context = await this.browser!.newContext({
        viewport: { width: 1080, height: 800 },
        deviceScaleFactor: 2, // retina-quality rendering
      });
      const page = await context.newPage();
      const pooled: PooledPage = {
        page,
        context,
        inUse: true,
        createdAt: Date.now(),
        useCount: 1,
      };
      this.pages.push(pooled);
      return page;
    }

    // All pages busy -- wait with timeout
    return this.waitForFreePage(10_000);
  }

  async release(page: Page): Promise<void> {
    const pooled = this.pages.find((p) => p.page === page);
    if (pooled) {
      pooled.inUse = false;
      // Clear page state for next use
      await page.setContent("<html><body></body></html>").catch(() => {});
    }
  }

  private isStale(p: PooledPage): boolean {
    return p.useCount >= this.maxUseCount || Date.now() - p.createdAt > this.maxAgeMs;
  }

  private async recycleStale(): Promise<void> {
    const stale = this.pages.filter((p) => !p.inUse && this.isStale(p));
    for (const p of stale) {
      await p.context.close().catch(() => {});
      this.pages = this.pages.filter((x) => x !== p);
    }
  }

  private waitForFreePage(timeoutMs: number): Promise<Page> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(async () => {
        const free = this.pages.find((p) => !p.inUse && !this.isStale(p));
        if (free) {
          clearInterval(interval);
          free.inUse = true;
          free.useCount++;
          resolve(free.page);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error("PlaywrightPool: timeout waiting for free page"));
        }
      }, 100);
    });
  }

  async shutdown(): Promise<void> {
    for (const p of this.pages) {
      await p.context.close().catch(() => {});
    }
    this.pages = [];
    await this.browser?.close();
    this.browser = null;
  }
}

export const playwrightPool = new PlaywrightPool();
```

### Pool Sizing

| Environment | `maxPages` | Rationale |
|-------------|-----------|-----------|
| Dev / single-user | 1 | Plenty |
| Production, small | 2-4 | 4 concurrent renders, ~800MB total browser memory |
| Production, heavy | 4-8 | More if server has 4GB+ RAM |

`deviceScaleFactor: 2` gives us 2160px-wide actual screenshots scaled down to 1080px logical -- crisp on any screen. The PNG will be ~2x file size but still under 500KB for most agendas.

> **Note:** Retina rendering (`deviceScaleFactor: 2`) is mandatory per project convention — images must look crisp on all devices. Do not reduce DPR to 1 without explicit approval.

---

## 6. BullMQ Job Definition

### Queue Name

`image-render`

### Job Types

```ts
// src/worker/jobs/image-render.types.ts

type ImageRenderJob =
  | { type: "daily-agenda"; data: DailyAgendaData; userId: number }
  | { type: "weekly-overview"; data: WeeklyOverviewData; userId: number }
  | { type: "event-card"; data: EventCardData; userId: number };

interface ImageRenderResult {
  buffer: Buffer;   // PNG buffer
  width: number;
  height: number;
  renderTimeMs: number;
}
```

### Job Options

```ts
const defaultJobOptions: JobsOptions = {
  attempts: 2,
  backoff: { type: "fixed", delay: 1000 },
  timeout: 15_000,        // kill job if it takes >15s
  removeOnComplete: {
    age: 60,               // keep completed jobs for 1 min (for result retrieval)
    count: 100,
  },
  removeOnFail: {
    age: 3600,             // keep failed jobs for 1 hour (debugging)
  },
};
```

### Job Priority

Regular user requests: default priority.
Morning notification batch: lower priority (bulk renders shouldn't block interactive requests).

```ts
// Interactive render -- user is waiting
await queue.add("render", jobData, { ...defaultJobOptions, priority: 1 });

// Batch morning notifications
await queue.add("render", jobData, { ...defaultJobOptions, priority: 10 });
```

### Worker Setup

```ts
// src/worker/image-render.worker.ts

import { Worker } from "bullmq";
import { playwrightPool } from "./playwright-pool";
import { getTemplate } from "./templates";

const worker = new Worker("image-render", async (job) => {
  const { type, data } = job.data as ImageRenderJob;
  const start = performance.now();

  // 1. Render HTML
  const template = getTemplate(type);
  const html = template.render(data);

  // 2. Screenshot
  const page = await playwrightPool.acquire();
  try {
    await page.setContent(html, { waitUntil: "load" });

    const height = await page.evaluate(() => {
      return document.getElementById("__root")?.scrollHeight ?? 800;
    });

    await page.setViewportSize({ width: 1080, height });

    const buffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: 1080, height },
    });

    return {
      buffer: Buffer.from(buffer),
      width: 1080,
      height,
      renderTimeMs: performance.now() - start,
    } satisfies ImageRenderResult;
  } finally {
    await playwrightPool.release(page);
  }
}, {
  connection: { host: "localhost", port: 6379 },
  concurrency: 4, // matches pool maxPages
  limiter: {
    max: 20,
    duration: 60_000, // max 20 renders per minute
  },
});
```

### Rate Limiter Rationale

`20/min` prevents a runaway loop or abuse from eating all CPU. At ~3s per render, 4 concurrent workers handle 80 renders/min at full capacity, but the limiter adds headroom for the server to breathe.

---

## 7. Caching Strategy

**No image caching. Render fresh on every request.**

Per the project-wide convention defined in `00-common-architecture.md` (Section 6):

- **Telegram caches images on its own servers.** Once we send a photo via `sendPhoto`, Telegram stores it and serves it from their CDN on subsequent views. We don't need to duplicate this.
- **Typical render time is 1.3-1.8s** — well within acceptable limits for an interactive response. The user sees a "generating..." placeholder for under 2 seconds.
- **No Redis image cache, no disk cache, no pub/sub invalidation.** This eliminates an entire class of bugs (stale cache, memory pressure, invalidation races, the "current time" staleness problem).
- **No `eventsHash` computation needed** — one fewer thing to get wrong.

If performance becomes an issue later (e.g., morning notification bursts overwhelm the worker), add a short-lived Redis cache with 5-minute TTL and cache key: `user_id + date + events_hash + theme + locale`. But don't build this until there's a measured need.

---

## 8. Performance Considerations

### Render Time Budget: 3 seconds

| Step | Target | Notes |
|------|--------|-------|
| Template render (HTML string) | <10ms | Pure string ops |
| `page.setContent()` | ~200ms | Parse HTML + CSS |
| Font rendering | ~300ms | Base64 fonts, first render slower |
| Layout + paint | ~200ms | CSS grid, no JS |
| `page.evaluate()` (height) | ~50ms | |
| `page.screenshot()` | ~500-1000ms | PNG encoding, 2x DPR |
| **Total** | **~1.3-1.8s** | Well under 3s budget |

### Memory

- Chromium browser: ~150-200MB base
- Per context: ~30-50MB additional
- 4 contexts: ~350-400MB total for Playwright
- Worker process overhead: ~50MB
- **Total worker: ~400-500MB**

### Optimization Levers (if needed later)

1. ~~**Reduce DPR to 1**~~: Not an option. Retina rendering (`deviceScaleFactor: 2`) is mandatory per project convention.
2. **Pre-warm pages**: On worker start, create all pool pages immediately instead of lazily.
3. **Sharp post-processing**: If PNG files are too large, pipe through Sharp for optimization. Likely unnecessary -- Playwright's PNG encoder is decent.
4. **WebP format**: Telegram supports WebP. ~30% smaller than PNG. Switch if bandwidth becomes an issue.

### Error Handling

```
Template render failure  -> return text fallback (never leave user hanging)
Playwright crash         -> restart browser, retry job (BullMQ handles this)
Pool timeout             -> return error to bot, bot sends text-only agenda as fallback
OOM                      -> worker process dies, systemd/pm2 restarts it,
                            BullMQ retries stalled jobs
```

The bot must always have a text-based fallback for agenda display. The image is a nice-to-have, not a hard dependency.

---

## 9. Example Template: Daily Agenda

Full implementation of the daily agenda template with HTML/CSS:

```ts
// src/worker/templates/daily-agenda.ts

import { fontFaceCSS } from "./fonts";
import type { DailyAgendaData, AgendaEvent, Theme } from "./types";
import type { TemplateRenderer } from "./types";

export const dailyAgendaTemplate: TemplateRenderer<DailyAgendaData> = {
  render(data: DailyAgendaData): string {
    const { theme, locale } = data;

    // Calculate visible hour range
    const allTimed = data.timedEvents.filter((e) => !e.isAllDay);
    const minHour = allTimed.length > 0
      ? Math.max(0, Math.floor(Math.min(...allTimed.map((e) => e.startMinutes)) / 60) - 1)
      : 8;
    const maxHour = allTimed.length > 0
      ? Math.min(24, Math.ceil(Math.max(...allTimed.map((e) => e.endMinutes)) / 60) + 1)
      : 18;

    return /* html */ `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  ${fontFaceCSS}

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: ${theme.bg};
    color: ${theme.textPrimary};
    -webkit-font-smoothing: antialiased;
  }

  #__root {
    width: 1080px;
    padding: 48px;
  }

  /* ---- Header ---- */
  .header {
    margin-bottom: 40px;
  }

  .header__date {
    font-size: 42px;
    font-weight: 700;
    line-height: 1.2;
    letter-spacing: -0.02em;
  }

  .header__meta {
    font-size: 22px;
    color: ${theme.textSecondary};
    margin-top: 8px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .header__badge {
    display: inline-block;
    background: ${theme.accent}22;
    color: ${theme.accent};
    padding: 4px 14px;
    border-radius: 100px;
    font-size: 18px;
    font-weight: 600;
  }

  .holiday-badge {
    background: #FEF3C7;
    color: #D97706;
  }

  /* ---- Timeline ---- */
  .timeline {
    position: relative;
    margin-bottom: 40px;
  }

  .timeline__hour-row {
    display: flex;
    align-items: flex-start;
    min-height: 60px;
    position: relative;
  }

  .timeline__hour-label {
    width: 80px;
    flex-shrink: 0;
    font-size: 18px;
    color: ${theme.textSecondary};
    padding-top: 2px;
    text-align: right;
    padding-right: 20px;
  }

  .timeline__hour-line {
    flex: 1;
    border-top: 1px solid ${theme.border};
    position: relative;
    min-height: 60px;
  }

  .timeline__events {
    position: absolute;
    left: 80px;
    right: 0;
    top: 0;
    bottom: 0;
  }

  .event-block {
    position: absolute;
    left: 16px;
    right: 16px;
    border-radius: 12px;
    padding: 14px 18px;
    overflow: hidden;
    min-height: 48px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .event-block__title {
    font-size: 20px;
    font-weight: 600;
    color: #FFFFFF;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .event-block__time {
    font-size: 16px;
    color: rgba(255, 255, 255, 0.85);
    margin-top: 4px;
  }

  .event-block__location {
    font-size: 16px;
    color: rgba(255, 255, 255, 0.75);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---- Current time indicator ---- */
  .now-line {
    position: absolute;
    left: 70px;
    right: 0;
    height: 3px;
    background: #EF4444;
    z-index: 10;
  }

  .now-line::before {
    content: '';
    position: absolute;
    left: 0;
    top: -5px;
    width: 13px;
    height: 13px;
    background: #EF4444;
    border-radius: 50%;
  }

  /* ---- All-day section ---- */
  .allday {
    background: ${theme.cardBg};
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 40px;
    border: 1px solid ${theme.border};
  }

  .allday__label {
    font-size: 16px;
    font-weight: 600;
    color: ${theme.textSecondary};
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 16px;
  }

  .allday__event {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    font-size: 20px;
  }

  .allday__event + .allday__event {
    border-top: 1px solid ${theme.border};
  }

  .allday__dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ---- Empty state ---- */
  .empty-state {
    text-align: center;
    padding: 80px 0;
    color: ${theme.textSecondary};
  }

  .empty-state__text {
    font-size: 24px;
  }

  /* ---- Footer ---- */
  .footer {
    text-align: center;
    font-size: 16px;
    color: ${theme.textSecondary};
    opacity: 0.5;
    padding-top: 20px;
    border-top: 1px solid ${theme.border};
  }
</style>
</head>
<body>
<div id="__root">

  <!-- Header -->
  <div class="header">
    <div class="header__date">${escapeHtml(data.dateFormatted)}</div>
    <div class="header__meta">
      ${data.relativeDay
        ? `<span class="header__badge">${escapeHtml(data.relativeDay)}</span>`
        : ""}
      <span>${escapeHtml(data.dayOfWeek)}</span>
      <span>&middot;</span>
      <span>${data.eventCount} ${pluralizeEvents(data.eventCount, locale)}</span>
      ${data.isHoliday
        ? `<span class="header__badge holiday-badge">${escapeHtml(
            data.holidayName ?? (locale === "ru" ? "Праздник" : "Holiday")
          )}</span>`
        : ""}
    </div>
  </div>

  <!-- All-day events -->
  ${data.allDayEvents.length > 0 ? renderAllDaySection(data.allDayEvents, locale) : ""}

  <!-- Timeline or empty state -->
  ${allTimed.length > 0
    ? renderTimeline(allTimed, minHour, maxHour, data.currentTimeMinutes, theme)
    : renderEmptyState(locale)}

  <div class="footer">HyperCalendar</div>

</div>
</body>
</html>`;
  },
};

// --- Helper functions ---

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pluralizeEvents(count: number, locale: string): string {
  if (locale === "ru") {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return "событие";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "события";
    return "событий";
  }
  return count === 1 ? "event" : "events";
}

function renderAllDaySection(events: AgendaEvent[], locale: string): string {
  return /* html */ `
  <div class="allday">
    <div class="allday__label">${locale === "ru" ? "Весь день" : "All day"}</div>
    ${events
      .map(
        (e) => `
      <div class="allday__event">
        <div class="allday__dot" style="background: ${e.calendarColor}"></div>
        <span>${e.emoji ? e.emoji + " " : ""}${escapeHtml(e.title)}</span>
      </div>
    `
      )
      .join("")}
  </div>`;
}

function renderTimeline(
  events: AgendaEvent[],
  minHour: number,
  maxHour: number,
  currentTimeMinutes: number | undefined,
  theme: Theme
): string {
  const hourHeight = 60; // px per hour
  const totalHeight = (maxHour - minHour) * hourHeight;

  const hourRows = [];
  for (let h = minHour; h < maxHour; h++) {
    hourRows.push(`
      <div class="timeline__hour-row">
        <div class="timeline__hour-label">${String(h).padStart(2, "0")}:00</div>
        <div class="timeline__hour-line"></div>
      </div>
    `);
  }

  const eventBlocks = events
    .map((e) => {
      const top =
        ((e.startMinutes / 60 - minHour) / (maxHour - minHour)) * totalHeight;
      const height = Math.max(
        48,
        ((e.endMinutes - e.startMinutes) / 60 / (maxHour - minHour)) *
          totalHeight -
          4
      );
      const startF = formatTime(e.startMinutes);
      const endF = formatTime(e.endMinutes);

      return `
      <div class="event-block" style="
        top: ${top}px;
        height: ${height}px;
        background: ${e.calendarColor};
      ">
        <div class="event-block__title">${escapeHtml(e.title)}</div>
        <div class="event-block__time">${startF} – ${endF}</div>
        ${
          e.location
            ? `<div class="event-block__location">${escapeHtml(e.location)}</div>`
            : ""
        }
      </div>`;
    })
    .join("");

  let nowLine = "";
  if (currentTimeMinutes !== undefined) {
    const nowTop =
      ((currentTimeMinutes / 60 - minHour) / (maxHour - minHour)) *
      totalHeight;
    if (nowTop >= 0 && nowTop <= totalHeight) {
      nowLine = `<div class="now-line" style="top: ${nowTop}px;"></div>`;
    }
  }

  return /* html */ `
  <div class="timeline" style="height: ${totalHeight}px; position: relative;">
    ${hourRows.join("")}
    <div class="timeline__events">
      ${eventBlocks}
      ${nowLine}
    </div>
  </div>`;
}

function renderEmptyState(locale: string): string {
  return /* html */ `
  <div class="empty-state">
    <div class="empty-state__text">${
      locale === "ru" ? "Нет событий на этот день" : "No events for this day"
    }</div>
  </div>`;
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
```

---

## 10. File Structure

```
src/
  worker/
    index.ts                    # Worker entry point (starts BullMQ workers)
    playwright-pool.ts          # Browser context pool
    jobs/
      image-render.worker.ts    # BullMQ worker processor
      image-render.types.ts     # Job/result type definitions
    templates/
      types.ts                  # TemplateRenderer interface, Theme, data contracts
      fonts.ts                  # Base64 font data
      themes.ts                 # Light/dark theme definitions
      shared.css.ts             # Common CSS (exported as string)
      labels.ts                 # i18n labels dictionary
      daily-agenda.ts           # Daily agenda template
      weekly-overview.ts        # Weekly overview template
      event-card.ts             # Event card template
      index.ts                  # getTemplate() registry
  services/
    image/
      render-service.ts         # Bot-side: enqueue job, await result, return Buffer
```

---

## 11. API Surface

The bot process interacts with image generation through a single service:

```ts
// src/services/image/render-service.ts

export interface ImageService {
  /** Render daily agenda. Returns PNG buffer. */
  renderDailyAgenda(
    userId: number,
    date: string,
    locale: "ru" | "en",
    theme?: string
  ): Promise<Buffer>;

  /** Render weekly overview. Returns PNG buffer. */
  renderWeeklyOverview(
    userId: number,
    weekStart: string,
    locale: "ru" | "en",
    theme?: string
  ): Promise<Buffer>;

  /** Render single event card. Returns PNG buffer. */
  renderEventCard(
    userId: number,
    eventId: string,
    locale: "ru" | "en",
    theme?: string
  ): Promise<Buffer>;
}
```

Each method:

1. Fetches event data from the database
2. Builds the typed data payload
3. Enqueues BullMQ job, waits for result (with 10s timeout)
4. Returns Buffer to the bot command handler

The bot command handler then calls `ctx.sendPhoto(buffer)`. No caching layer — every call renders fresh (see Section 7).

---

## Open Questions

1. **Overlapping events** -- The daily agenda template above naively stacks events. If two events overlap (e.g., 10:00-11:00 and 10:30-11:30), they need side-by-side layout. This is a non-trivial layout problem. Options:
   - Pre-compute column assignments in TypeScript (like Google Calendar does) and pass `left`/`width` to each event block. **Recommended** -- it's ~30 lines of code and makes the image look professional.
   - Accept overlap and just layer them with slight offset + transparency. Simpler, less polished.

2. **Weather** -- Marked as "future, optional slot." Leave a visual placeholder in the template (an empty `<div>` with a comment) so adding weather later doesn't require redesigning the header.

4. **Notification images** -- Morning notifications (sub-project #4) will likely want to send a daily agenda image. Should the notification system call `ImageService.renderDailyAgenda()` directly, or should it enqueue its own batch job? Batch job is better -- it can pre-render all user agendas at 06:50 and have them ready by 07:00.

---

## 12. Mini App Auto-Timezone Detection

When a Mini App is opened for calendar viewing (agenda images, interactive calendar, etc.), it can detect the user's current timezone via browser API and update it automatically.

### How it works

1. Mini App frontend calls `Intl.DateTimeFormat().resolvedOptions().timeZone` on load
2. Compares with the user's stored timezone (passed via Mini App init data or fetched from API)
3. If different — sends update request to the bot backend
4. Backend updates `users.timezone` and optionally notifies the user: "Your timezone was updated to X"

### Implementation

```typescript
// Mini App frontend (runs in Telegram WebView)
const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Compare with stored timezone (from WebApp.initData or API call)
if (detectedTz && detectedTz !== storedTimezone) {
  // POST to bot backend or send via WebApp.sendData()
  window.Telegram.WebApp.sendData(JSON.stringify({
    action: 'update_timezone',
    timezone: detectedTz,
  }));
}
```

### UX considerations

- **Silent update by default** — don't interrupt the user with a modal. Just update and show a brief toast: "Timezone updated to Europe/Berlin".
- **Edge case: VPN** — browser timezone reflects OS settings, not network location. If user is on VPN in Japan but OS is set to Moscow time, `Intl` returns Moscow. This is correct behavior — we want the user's actual local time, not their IP location.
- **Frequency** — check on every Mini App open, but only send update if timezone actually changed. No polling.

### Why Phase C

This feature naturally fits Phase C because:
- Mini App frontend is first built for image-based calendar viewing
- The WebView is already loaded and has browser API access
- No extra infrastructure needed — just a few lines of JS on the frontend side
