> Part 1 of 2 of [Sub-Project #5: Image Generation](../05-image-generation.md) — next: [02-sections-7-12.md](02-sections-7-12.md)

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Template System](#2-template-system)
3. [Image Types](#3-image-types)
4. [Rendering Pipeline](#4-rendering-pipeline)
5. [Playwright Pooling](#5-playwright-pooling)
6. [BullMQ Job Definition](#6-bullmq-job-definition)
7. [Caching Strategy](02-sections-7-12.md#7-caching-strategy)
8. [Performance Considerations](02-sections-7-12.md#8-performance-considerations)
9. [Example Template: Daily Agenda](02-sections-7-12.md#9-example-template-daily-agenda)
10. [File Structure](02-sections-7-12.md#10-file-structure)
11. [API Surface](02-sections-7-12.md#11-api-surface)
12. [Mini App Auto-Timezone Detection](02-sections-7-12.md#12-mini-app-auto-timezone-detection)

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

