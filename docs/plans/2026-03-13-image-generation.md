# Image Generation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render shareable calendar agenda images (daily, weekly, event card) via HTML/CSS templates + Playwright screenshots, delivered through BullMQ worker queue.

**Architecture:** Bot command builds data payload from EventService → enqueues BullMQ job → Worker renders HTML via template → Playwright screenshots to PNG → base64 result returned via BullMQ → Bot decodes and sends PNG to Telegram. Playwright pool limits concurrency (4 pages). Worker runs in-process (matches existing notification/sync queue pattern).

**Tech Stack:** Playwright (chromium headless), BullMQ (installed), Redis (configured), HTML/CSS tagged template literals, Inter font (woff2 base64), `@date-fns/tz` (installed)

---

## Prerequisites

```bash
bun add playwright
bunx playwright install chromium
```

---

## File Structure

### New Files

```
src/worker/
  playwright-pool.ts              # Browser context pool
  image-render.queue.ts           # BullMQ queue + worker + job types
  templates/
    types.ts                      # TemplateRenderer<T>, Theme, data contracts
    themes.ts                     # THEME_LIGHT, THEME_DARK, getTheme()
    labels.ts                     # i18n labels, pluralizeEvents()
    helpers.ts                    # escapeHtml, formatTime, computeEventColumns
    shared-css.ts                 # Common CSS (reset, font-face, base)
    fonts.ts                      # Base64 Inter Regular + Bold (generated)
    daily-agenda.ts               # Daily agenda template
    weekly-overview.ts            # Weekly overview template
    event-card.ts                 # Event card template
    index.ts                      # getTemplate() registry

src/services/image/
  data-mapper.ts                  # EventOccurrence[] → template data
  render-service.ts               # Bot-side: enqueue job, await result

scripts/
  generate-fonts.ts               # One-time: fetch Inter woff2 → base64

test/worker/
  playwright-pool.test.ts
  templates/
    helpers.test.ts
    labels.test.ts
    themes.test.ts
    daily-agenda.test.ts
    weekly-overview.test.ts
    event-card.test.ts
    registry.test.ts

test/services/image/
  data-mapper.test.ts
  render-service.test.ts
```

### Modified Files

```
src/utils/logger.ts                    # Add imageLogger child
src/config/constants.ts                # Add CB.IMG_DAILY, CB.IMG_WEEKLY
src/index.ts                           # Wire image queue + render service
src/bot/commands/today.ts              # Add 📷 button
src/bot/commands/week.ts               # Add 📷 button
src/bot/handlers/callback.handler.ts   # Handle IMG_* callbacks
src/bot/index.ts                       # Pass renderService to handlers
```

---

## Chunk 1: Template Foundation

### Task 1: Data contracts & template types

**Files:**
- Create: `src/worker/templates/types.ts`

No runtime test — pure interfaces, TypeScript compiler validates.

- [ ] **Step 1: Create types file**

```ts
// src/worker/templates/types.ts

export interface TemplateRenderer<TData> {
  render(data: TData): string;
}

export interface Theme {
  name: string;
  bg: string;
  cardBg: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  border: string;
  eventColors: string[];
}

export interface AgendaEvent {
  id: number;
  title: string;
  startMinutes: number;   // minutes since midnight in user TZ
  endMinutes: number;
  location?: string;
  calendarColor: string;
  calendarName?: string;
  isAllDay: boolean;
  emoji?: string;
}

export interface DailyAgendaData {
  date: string;            // ISO "2026-03-11"
  dayOfWeek: string;       // "Wednesday" / "Среда"
  dateFormatted: string;   // "March 11, 2026" / "11 марта 2026"
  relativeDay?: string;    // "Today" / "Сегодня"
  eventCount: number;
  currentTimeMinutes?: number;
  isHoliday?: boolean;
  holidayName?: string;
  allDayEvents: AgendaEvent[];
  timedEvents: AgendaEvent[];
  theme: Theme;
  locale: "ru" | "en";
}

export interface MiniEvent {
  startMinutes: number;
  endMinutes: number;
  color: string;
  isAllDay: boolean;
}

export interface WeekDay {
  dayNumber: number;
  dayName: string;
  eventCount: number;
  isWeekend: boolean;
  events: MiniEvent[];
}

export interface WeeklyOverviewData {
  weekLabel: string;
  days: WeekDay[];
  todayIndex?: number;
  theme: Theme;
  locale: "ru" | "en";
}

export interface EventCardData {
  title: string;
  dateFormatted: string;
  timeFormatted: string;
  duration: string;
  location?: string;
  description?: string;
  attendees?: string[];
  attendeeOverflow?: number;
  conferenceLink?: string;
  calendarName: string;
  calendarColor: string;
  isAllDay: boolean;
  theme: Theme;
  locale: "ru" | "en";
}

export type ImageType = "daily-agenda" | "weekly-overview" | "event-card";
```

- [ ] **Step 2: Verify compiles**

Run: `bunx tsc --noEmit src/worker/templates/types.ts`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/worker/templates/types.ts
git commit -m "feat(image): add template data contracts and types"
```

---

### Task 2: Theme definitions

**Files:**
- Create: `src/worker/templates/themes.ts`
- Test: `test/worker/templates/themes.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/worker/templates/themes.test.ts
import { describe, expect, test } from "bun:test";
import { THEME_DARK, THEME_LIGHT, getTheme } from "../../../src/worker/templates/themes.ts";

describe("themes", () => {
  test("THEME_LIGHT has all required fields", () => {
    expect(THEME_LIGHT.name).toBe("light");
    expect(THEME_LIGHT.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(THEME_LIGHT.eventColors.length).toBeGreaterThanOrEqual(4);
  });

  test("THEME_DARK has all required fields", () => {
    expect(THEME_DARK.name).toBe("dark");
    expect(THEME_DARK.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(THEME_DARK.eventColors.length).toBeGreaterThanOrEqual(4);
  });

  test("getTheme returns light by default", () => {
    expect(getTheme()).toBe(THEME_LIGHT);
    expect(getTheme("light")).toBe(THEME_LIGHT);
  });

  test("getTheme returns dark", () => {
    expect(getTheme("dark")).toBe(THEME_DARK);
  });

  test("getTheme returns light for unknown theme", () => {
    expect(getTheme("neon")).toBe(THEME_LIGHT);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test test/worker/templates/themes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/worker/templates/themes.ts
import type { Theme } from "./types.ts";

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

const themes: Record<string, Theme> = { light: THEME_LIGHT, dark: THEME_DARK };

export function getTheme(name?: string): Theme {
  return themes[name ?? "light"] ?? THEME_LIGHT;
}
```

- [ ] **Step 4: Run test — verify passes**

Run: `bun test test/worker/templates/themes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/templates/themes.ts test/worker/templates/themes.test.ts
git commit -m "feat(image): add light/dark theme definitions"
```

---

### Task 3: i18n labels + pluralization

**Files:**
- Create: `src/worker/templates/labels.ts`
- Test: `test/worker/templates/labels.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/worker/templates/labels.test.ts
import { describe, expect, test } from "bun:test";
import { getLabels, pluralizeEvents } from "../../../src/worker/templates/labels.ts";

describe("getLabels", () => {
  test("Russian labels", () => {
    const l = getLabels("ru");
    expect(l.today).toBe("Сегодня");
    expect(l.noEvents).toBe("Нет событий");
    expect(l.allDay).toBe("Весь день");
  });

  test("English labels", () => {
    const l = getLabels("en");
    expect(l.today).toBe("Today");
    expect(l.allDay).toBe("All day");
  });

  test("weekDaysShort has 7 entries", () => {
    expect(getLabels("ru").weekDaysShort).toHaveLength(7);
    expect(getLabels("en").weekDaysShort).toHaveLength(7);
  });

  test("monthNames has 12 entries", () => {
    expect(getLabels("ru").monthNames).toHaveLength(12);
    expect(getLabels("en").monthNames).toHaveLength(12);
  });
});

describe("pluralizeEvents", () => {
  test("Russian: 1 событие", () => {
    expect(pluralizeEvents(1, "ru")).toBe("событие");
  });

  test("Russian: 2-4 события", () => {
    expect(pluralizeEvents(2, "ru")).toBe("события");
    expect(pluralizeEvents(3, "ru")).toBe("события");
    expect(pluralizeEvents(4, "ru")).toBe("события");
  });

  test("Russian: 5-20 событий", () => {
    expect(pluralizeEvents(5, "ru")).toBe("событий");
    expect(pluralizeEvents(11, "ru")).toBe("событий");
    expect(pluralizeEvents(20, "ru")).toBe("событий");
  });

  test("Russian: 21 событие, 22 события", () => {
    expect(pluralizeEvents(21, "ru")).toBe("событие");
    expect(pluralizeEvents(22, "ru")).toBe("события");
  });

  test("English: singular/plural", () => {
    expect(pluralizeEvents(1, "en")).toBe("event");
    expect(pluralizeEvents(0, "en")).toBe("events");
    expect(pluralizeEvents(5, "en")).toBe("events");
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `bun test test/worker/templates/labels.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
// src/worker/templates/labels.ts

export interface Labels {
  today: string;
  tomorrow: string;
  noEvents: string;
  allDay: string;
  holiday: string;
  weekDaysShort: string[];
  weekDaysFull: string[];
  monthNames: string[];
}

const labelsDict: Record<string, Labels> = {
  ru: {
    today: "Сегодня",
    tomorrow: "Завтра",
    noEvents: "Нет событий",
    allDay: "Весь день",
    holiday: "Праздник",
    weekDaysShort: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
    weekDaysFull: ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"],
    monthNames: [
      "января", "февраля", "марта", "апреля", "мая", "июня",
      "июля", "августа", "сентября", "октября", "ноября", "декабря",
    ],
  },
  en: {
    today: "Today",
    tomorrow: "Tomorrow",
    noEvents: "No events",
    allDay: "All day",
    holiday: "Holiday",
    weekDaysShort: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    weekDaysFull: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    monthNames: [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ],
  },
};

export function getLabels(locale: string): Labels {
  return labelsDict[locale] ?? labelsDict.en;
}

export function pluralizeEvents(count: number, locale: string): string {
  if (locale === "ru") {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return "событие";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "события";
    return "событий";
  }
  return count === 1 ? "event" : "events";
}
```

- [ ] **Step 4: Run test — verify passes**

Run: `bun test test/worker/templates/labels.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/templates/labels.ts test/worker/templates/labels.test.ts
git commit -m "feat(image): add i18n labels and event pluralization"
```

---

### Task 4: HTML helpers + overlapping event columns

**Files:**
- Create: `src/worker/templates/helpers.ts`
- Test: `test/worker/templates/helpers.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/worker/templates/helpers.test.ts
import { describe, expect, test } from "bun:test";
import {
  computeEventColumns,
  escapeHtml,
  formatDuration,
  formatTime,
} from "../../../src/worker/templates/helpers.ts";

describe("escapeHtml", () => {
  test("escapes special characters", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  test("escapes ampersand", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  test("passes through safe strings", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });
});

describe("formatTime", () => {
  test("midnight", () => expect(formatTime(0)).toBe("00:00"));
  test("morning", () => expect(formatTime(570)).toBe("09:30"));
  test("afternoon", () => expect(formatTime(845)).toBe("14:05"));
  test("end of day", () => expect(formatTime(1439)).toBe("23:59"));
});

describe("formatDuration", () => {
  test("minutes only", () => expect(formatDuration(30)).toBe("30min"));
  test("hours only", () => expect(formatDuration(120)).toBe("2h"));
  test("hours and minutes", () => expect(formatDuration(90)).toBe("1h 30min"));
  test("zero", () => expect(formatDuration(0)).toBe(""));
});

describe("computeEventColumns", () => {
  test("single event → column 0, totalColumns 1", () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 600 },
    ]);
    expect(result).toEqual([{ column: 0, totalColumns: 1 }]);
  });

  test("non-overlapping → all column 0", () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 600 },
      { startMinutes: 660, endMinutes: 720 },
    ]);
    expect(result).toEqual([
      { column: 0, totalColumns: 1 },
      { column: 0, totalColumns: 1 },
    ]);
  });

  test("two overlapping → columns 0 and 1", () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 660 },
      { startMinutes: 600, endMinutes: 720 },
    ]);
    expect(result).toEqual([
      { column: 0, totalColumns: 2 },
      { column: 1, totalColumns: 2 },
    ]);
  });

  test("three overlapping → columns 0, 1, 2", () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 720 },
      { startMinutes: 600, endMinutes: 660 },
      { startMinutes: 630, endMinutes: 750 },
    ]);
    expect(result[0].column).toBe(0);
    expect(result[1].column).toBe(1);
    expect(result[2].column).toBe(2);
    for (const r of result) expect(r.totalColumns).toBe(3);
  });

  test("partial overlap chain: A↔B, B↔C, not A↔C", () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 600 },
      { startMinutes: 570, endMinutes: 660 },
      { startMinutes: 630, endMinutes: 720 },
    ]);
    expect(result[0]).toEqual({ column: 0, totalColumns: 2 });
    expect(result[1]).toEqual({ column: 1, totalColumns: 2 });
    expect(result[2]).toEqual({ column: 0, totalColumns: 2 });
  });

  test("empty → empty", () => {
    expect(computeEventColumns([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `bun test test/worker/templates/helpers.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
// src/worker/templates/helpers.ts

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

interface TimeRange {
  startMinutes: number;
  endMinutes: number;
}

export interface EventColumn {
  column: number;
  totalColumns: number;
}

export function computeEventColumns(events: TimeRange[]): EventColumn[] {
  if (events.length === 0) return [];

  const indices = events
    .map((_, i) => i)
    .sort((a, b) => events[a].startMinutes - events[b].startMinutes);

  const columns: EventColumn[] = new Array(events.length);
  const columnEnds: number[] = [];

  for (const i of indices) {
    const ev = events[i];
    let col = 0;
    while (col < columnEnds.length && columnEnds[col] > ev.startMinutes) {
      col++;
    }
    columnEnds[col] = ev.endMinutes;
    columns[i] = { column: col, totalColumns: 0 };
  }

  for (let i = 0; i < events.length; i++) {
    let maxCol = columns[i].column;
    for (let j = 0; j < events.length; j++) {
      if (i === j) continue;
      if (events[j].startMinutes < events[i].endMinutes && events[j].endMinutes > events[i].startMinutes) {
        maxCol = Math.max(maxCol, columns[j].column);
      }
    }
    columns[i].totalColumns = maxCol + 1;
  }

  return columns;
}
```

- [ ] **Step 4: Run test — verify passes**

Run: `bun test test/worker/templates/helpers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/templates/helpers.ts test/worker/templates/helpers.test.ts
git commit -m "feat(image): add HTML helpers and event column layout"
```

---

### Task 5: Fonts + shared CSS

**Files:**
- Create: `scripts/generate-fonts.ts`
- Create: `src/worker/templates/fonts.ts` (generated)
- Create: `src/worker/templates/shared-css.ts`

- [ ] **Step 1: Create font generation script**

```ts
// scripts/generate-fonts.ts
// Run once: bun run scripts/generate-fonts.ts

const INTER_REGULAR_URL =
  "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hjQ.woff2";
const INTER_BOLD_URL =
  "https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYAZ9hjQ.woff2";

async function downloadBase64(url: string): Promise<string> {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

const [regular, bold] = await Promise.all([
  downloadBase64(INTER_REGULAR_URL),
  downloadBase64(INTER_BOLD_URL),
]);

const output = `// Generated by scripts/generate-fonts.ts — do not edit manually

export const FONT_INTER_REGULAR = "data:font/woff2;base64,${regular}";

export const FONT_INTER_BOLD = "data:font/woff2;base64,${bold}";

export const fontFaceCSS = \`
  @font-face {
    font-family: 'Inter';
    font-weight: 400;
    src: url('\${FONT_INTER_REGULAR}') format('woff2');
  }
  @font-face {
    font-family: 'Inter';
    font-weight: 700;
    src: url('\${FONT_INTER_BOLD}') format('woff2');
  }
\`;
`;

await Bun.write("src/worker/templates/fonts.ts", output);
console.log("fonts.ts generated");
```

- [ ] **Step 2: Run font generation**

Run: `bun run scripts/generate-fonts.ts`
Expected: creates `src/worker/templates/fonts.ts` (~270KB)

- [ ] **Step 3: Create shared CSS**

```ts
// src/worker/templates/shared-css.ts
import { fontFaceCSS } from "./fonts.ts";

export function sharedCSS(vars: { bg: string; textPrimary: string }): string {
  return `
    ${fontFaceCSS}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: ${vars.bg};
      color: ${vars.textPrimary};
      -webkit-font-smoothing: antialiased;
    }
    #__root {
      width: 1080px;
      padding: 48px;
    }
  `;
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-fonts.ts src/worker/templates/fonts.ts src/worker/templates/shared-css.ts
git commit -m "feat(image): add Inter fonts (base64) and shared CSS"
```

---

## Chunk 2: HTML Templates

### Task 6: Daily agenda template

**Files:**
- Create: `src/worker/templates/daily-agenda.ts`
- Test: `test/worker/templates/daily-agenda.test.ts`

**Reference:** Full HTML/CSS template in `docs/specs/05-image-generation.md`, Section 9 (lines 758–1151).

**Modifications from spec:**
- Import `sharedCSS` for font-face + reset (don't duplicate)
- Import `escapeHtml`, `formatTime`, `computeEventColumns` from `helpers.ts`
- Import `pluralizeEvents`, `getLabels` from `labels.ts`
- Add column-based CSS positioning for overlapping events: each event block gets `left: ${col * widthPct}%` and `width: ${widthPct - 2}%` where `widthPct = 100 / totalColumns`

- [ ] **Step 1: Write failing test**

```ts
// test/worker/templates/daily-agenda.test.ts
import { describe, expect, test } from "bun:test";
import { dailyAgendaTemplate } from "../../../src/worker/templates/daily-agenda.ts";
import { THEME_LIGHT } from "../../../src/worker/templates/themes.ts";
import type { DailyAgendaData } from "../../../src/worker/templates/types.ts";

function makeData(overrides: Partial<DailyAgendaData> = {}): DailyAgendaData {
  return {
    date: "2026-03-11",
    dayOfWeek: "Wednesday",
    dateFormatted: "March 11, 2026",
    eventCount: 0,
    allDayEvents: [],
    timedEvents: [],
    theme: THEME_LIGHT,
    locale: "en",
    ...overrides,
  };
}

describe("dailyAgendaTemplate", () => {
  test("renders valid HTML", () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<div id="__root">');
    expect(html).toContain("</html>");
  });

  test("renders date in header", () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain("March 11, 2026");
  });

  test("renders day of week and event count", () => {
    const html = dailyAgendaTemplate.render(makeData({ eventCount: 3 }));
    expect(html).toContain("Wednesday");
    expect(html).toContain("3 events");
  });

  test("Russian event count", () => {
    const html = dailyAgendaTemplate.render(makeData({ eventCount: 5, locale: "ru" }));
    expect(html).toContain("5 событий");
  });

  test("renders relative day badge", () => {
    const html = dailyAgendaTemplate.render(makeData({ relativeDay: "Today" }));
    expect(html).toContain("Today");
    expect(html).toContain("header__badge");
  });

  test("empty state when no events", () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain("No events");
  });

  test("Russian empty state", () => {
    const html = dailyAgendaTemplate.render(makeData({ locale: "ru" }));
    expect(html).toContain("Нет событий");
  });

  test("renders timed events with time and color", () => {
    const html = dailyAgendaTemplate.render(makeData({
      eventCount: 1,
      timedEvents: [{
        id: 1, title: "Standup", startMinutes: 540, endMinutes: 570,
        calendarColor: "#6366F1", isAllDay: false,
      }],
    }));
    expect(html).toContain("Standup");
    expect(html).toContain("09:00");
    expect(html).toContain("09:30");
    expect(html).toContain("#6366F1");
  });

  test("renders all-day events", () => {
    const html = dailyAgendaTemplate.render(makeData({
      eventCount: 1,
      allDayEvents: [{
        id: 2, title: "Company Holiday", startMinutes: 0, endMinutes: 1440,
        calendarColor: "#EC4899", isAllDay: true,
      }],
    }));
    expect(html).toContain("Company Holiday");
    expect(html).toContain("allday");
  });

  test("renders current time indicator", () => {
    const html = dailyAgendaTemplate.render(makeData({
      currentTimeMinutes: 615,
      eventCount: 1,
      timedEvents: [{
        id: 1, title: "Meeting", startMinutes: 540, endMinutes: 660,
        calendarColor: "#6366F1", isAllDay: false,
      }],
    }));
    expect(html).toContain("now-line");
  });

  test("renders holiday badge", () => {
    const html = dailyAgendaTemplate.render(makeData({ isHoliday: true, holidayName: "New Year" }));
    expect(html).toContain("New Year");
    expect(html).toContain("holiday-badge");
  });

  test("escapes HTML in titles", () => {
    const html = dailyAgendaTemplate.render(makeData({
      eventCount: 1,
      timedEvents: [{
        id: 1, title: '<script>alert("x")</script>', startMinutes: 540,
        endMinutes: 600, calendarColor: "#6366F1", isAllDay: false,
      }],
    }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders event location", () => {
    const html = dailyAgendaTemplate.render(makeData({
      eventCount: 1,
      timedEvents: [{
        id: 1, title: "Meeting", startMinutes: 540, endMinutes: 600,
        location: "Room 42", calendarColor: "#6366F1", isAllDay: false,
      }],
    }));
    expect(html).toContain("Room 42");
  });

  test("renders footer", () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain("HyperCalendar");
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `bun test test/worker/templates/daily-agenda.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement daily agenda template**

Port the template from `docs/specs/05-image-generation.md` Section 9 (lines 758–1151). The template is a full HTML document with inline CSS.

```ts
// src/worker/templates/daily-agenda.ts
import type { DailyAgendaData, AgendaEvent, TemplateRenderer } from "./types.ts";
import { sharedCSS } from "./shared-css.ts";
import { escapeHtml, formatTime, computeEventColumns } from "./helpers.ts";
import { pluralizeEvents, getLabels } from "./labels.ts";

export const dailyAgendaTemplate: TemplateRenderer<DailyAgendaData> = {
  render(data: DailyAgendaData): string {
    const { theme, locale } = data;
    const labels = getLabels(locale);
    const allTimed = data.timedEvents.filter((e) => !e.isAllDay);

    // Visible hour range: events ± 1h padding, default 08:00–18:00
    const minHour = allTimed.length > 0
      ? Math.max(0, Math.floor(Math.min(...allTimed.map((e) => e.startMinutes)) / 60) - 1)
      : 8;
    const maxHour = allTimed.length > 0
      ? Math.min(24, Math.ceil(Math.max(...allTimed.map((e) => e.endMinutes)) / 60) + 1)
      : 18;

    // Build HTML — structure below, full CSS from spec Section 9
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${sharedCSS({ bg: theme.bg, textPrimary: theme.textPrimary })}
  /* Template-specific CSS classes — port from spec: */
  /* .header { padding-bottom: 24px; border-bottom: 2px solid ${theme.border}; } */
  /* .header__date { font-size: 42px; font-weight: 700; letter-spacing: -0.5px; } */
  /* .header__meta { font-size: 20px; color: ${theme.textSecondary}; } */
  /* .header__badge { display: inline-block; padding: 6px 16px; border-radius: 20px; background: ${theme.accent}; color: #fff; } */
  /* .holiday-badge { background: #FEF3C7; color: #92400E; } */
  /* .allday { margin: 24px 0; } */
  /* .allday__item { padding: 16px; border-radius: 12px; background: ${theme.cardBg}; } */
  /* .timeline { position: relative; } */
  /* .timeline__hour-row { height: 60px; display: flex; border-top: 1px solid ${theme.border}; } */
  /* .timeline__hour-label { width: 80px; font-size: 16px; color: ${theme.textSecondary}; } */
  /* .timeline__events { position: relative; flex: 1; } */
  /* .event-block { position: absolute; border-radius: 10px; padding: 10px 14px; } */
  /* .now-line { position: absolute; left: 80px; right: 0; height: 3px; background: #EF4444; z-index: 10; } */
  /* .now-line::before { content: ''; width: 10px; height: 10px; border-radius: 50%; background: #EF4444; } */
  /* .empty-state { text-align: center; padding: 80px 0; color: ${theme.textSecondary}; } */
  /* .footer { margin-top: 32px; text-align: right; font-size: 14px; color: ${theme.textSecondary}; } */
  /* <!-- weather slot --> */
</style></head>
<body><div id="__root">
  ${renderHeader(data, labels)}
  ${data.isHoliday && data.holidayName ? renderHolidayBadge(data.holidayName) : ""}
  ${data.allDayEvents.length > 0 ? renderAllDaySection(data.allDayEvents, labels) : ""}
  ${hasEvents ? renderTimeline(allTimed, minHour, maxHour, data.currentTimeMinutes) : renderEmptyState(labels)}
  ${renderFooter()}
</div></body></html>`;
  },
};
```

**Key rendering functions to implement** (as local functions in the same file):
- `renderHeader(data, labels)` — date, day of week, relative day badge, event count with `pluralizeEvents()`
- `renderHolidayBadge(name)` — holiday chip with class `holiday-badge`
- `renderAllDaySection(events, labels)` — colored dots + titles, "All day" label
- `renderTimeline(events, minHour, maxHour, currentTimeMinutes?)` — hour rows + overlapping event blocks
- `renderEmptyState(labels)` — centered "No events" text
- `renderFooter()` — "HyperCalendar" branding

**Overlapping events** — use `computeEventColumns(allTimed)` for column layout:
```ts
const cols = computeEventColumns(allTimed);
// For each event at index i:
const widthPct = 100 / cols[i].totalColumns;
const leftPct = cols[i].column * widthPct;
// inline style: position: absolute; left: ${leftPct}%; width: calc(${widthPct}% - 8px);
// top/height calculated from startMinutes/endMinutes relative to minHour
```

**Current time indicator** — if `currentTimeMinutes` is set:
```ts
const nowTop = ((currentTimeMinutes - minHour * 60) / ((maxHour - minHour) * 60)) * totalHeight;
// <div class="now-line" style="top: ${nowTop}px"></div>
```

All user-facing strings must pass through `escapeHtml()`.
Full CSS from spec Section 9 — copy verbatim, replace hardcoded colors with `theme.*` variables.

- [ ] **Step 4: Run test — verify passes**

Run: `bun test test/worker/templates/daily-agenda.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/templates/daily-agenda.ts test/worker/templates/daily-agenda.test.ts
git commit -m "feat(image): add daily agenda HTML template"
```

---

### Task 7: Weekly overview template

**Files:**
- Create: `src/worker/templates/weekly-overview.ts`
- Test: `test/worker/templates/weekly-overview.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/worker/templates/weekly-overview.test.ts
import { describe, expect, test } from "bun:test";
import { weeklyOverviewTemplate } from "../../../src/worker/templates/weekly-overview.ts";
import { THEME_LIGHT } from "../../../src/worker/templates/themes.ts";
import type { WeeklyOverviewData } from "../../../src/worker/templates/types.ts";

function makeWeekData(overrides: Partial<WeeklyOverviewData> = {}): WeeklyOverviewData {
  return {
    weekLabel: "March 9–15, 2026",
    days: Array.from({ length: 7 }, (_, i) => ({
      dayNumber: 9 + i,
      dayName: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i],
      eventCount: 0,
      isWeekend: i >= 5,
      events: [],
    })),
    theme: THEME_LIGHT,
    locale: "en",
    ...overrides,
  };
}

describe("weeklyOverviewTemplate", () => {
  test("renders valid HTML with week label", () => {
    const html = weeklyOverviewTemplate.render(makeWeekData());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("March 9–15, 2026");
  });

  test("renders 7 day names", () => {
    const html = weeklyOverviewTemplate.render(makeWeekData());
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      expect(html).toContain(d);
    }
  });

  test("highlights today", () => {
    const html = weeklyOverviewTemplate.render(makeWeekData({ todayIndex: 2 }));
    expect(html).toContain("today-highlight");
  });

  test("renders event counts", () => {
    const data = makeWeekData();
    data.days[2].eventCount = 5;
    const html = weeklyOverviewTemplate.render(data);
    expect(html).toContain(">5<");
  });

  test("renders mini event color blocks", () => {
    const data = makeWeekData();
    data.days[0].events = [
      { startMinutes: 540, endMinutes: 600, color: "#6366F1", isAllDay: false },
    ];
    data.days[0].eventCount = 1;
    const html = weeklyOverviewTemplate.render(data);
    expect(html).toContain("#6366F1");
  });

  test("renders footer", () => {
    const html = weeklyOverviewTemplate.render(makeWeekData());
    expect(html).toContain("HyperCalendar");
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `bun test test/worker/templates/weekly-overview.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Key layout decisions (from spec Section 3.2):
- `display: grid; grid-template-columns: repeat(7, 1fr);`
- Fixed height 900px
- Each column: day name (top), day number, mini event bars (proportional), event count (bottom)
- Today: accent circle around day number (CSS class `today-highlight`)
- Weekend columns: muted background (`${theme.border}33`)
- Mini events: small colored rectangles, height proportional to duration within 08:00–22:00 range

- [ ] **Step 4: Run test — verify passes**

Run: `bun test test/worker/templates/weekly-overview.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/templates/weekly-overview.ts test/worker/templates/weekly-overview.test.ts
git commit -m "feat(image): add weekly overview HTML template"
```

---

### Task 8: Event card template

**Files:**
- Create: `src/worker/templates/event-card.ts`
- Test: `test/worker/templates/event-card.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/worker/templates/event-card.test.ts
import { describe, expect, test } from "bun:test";
import { eventCardTemplate } from "../../../src/worker/templates/event-card.ts";
import { THEME_LIGHT } from "../../../src/worker/templates/themes.ts";
import type { EventCardData } from "../../../src/worker/templates/types.ts";

function makeCardData(overrides: Partial<EventCardData> = {}): EventCardData {
  return {
    title: "Design Review",
    dateFormatted: "Tuesday, March 11, 2026",
    timeFormatted: "11:00 – 12:00",
    duration: "1h",
    calendarName: "Work Calendar",
    calendarColor: "#6366F1",
    isAllDay: false,
    theme: THEME_LIGHT,
    locale: "en",
    ...overrides,
  };
}

describe("eventCardTemplate", () => {
  test("renders valid HTML with title", () => {
    const html = eventCardTemplate.render(makeCardData());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Design Review");
  });

  test("renders date, time, duration", () => {
    const html = eventCardTemplate.render(makeCardData());
    expect(html).toContain("Tuesday, March 11, 2026");
    expect(html).toContain("11:00");
    expect(html).toContain("1h");
  });

  test("renders location when present", () => {
    const html = eventCardTemplate.render(makeCardData({ location: "Room 42" }));
    expect(html).toContain("Room 42");
  });

  test("omits location when absent", () => {
    const html = eventCardTemplate.render(makeCardData());
    expect(html).not.toContain("location");
  });

  test("renders description", () => {
    const html = eventCardTemplate.render(makeCardData({ description: "Review proposals" }));
    expect(html).toContain("Review proposals");
  });

  test("renders attendees + overflow", () => {
    const html = eventCardTemplate.render(makeCardData({
      attendees: ["Alex", "Maria", "Ivan"],
      attendeeOverflow: 3,
    }));
    expect(html).toContain("Alex");
    expect(html).toContain("+3");
  });

  test("renders conference link", () => {
    const html = eventCardTemplate.render(makeCardData({ conferenceLink: "meet.google.com/abc" }));
    expect(html).toContain("meet.google.com/abc");
  });

  test("renders calendar color as left border", () => {
    const html = eventCardTemplate.render(makeCardData());
    expect(html).toContain("#6366F1");
    expect(html).toContain("Work Calendar");
  });

  test("escapes HTML in all user content", () => {
    const html = eventCardTemplate.render(makeCardData({ title: "<b>XSS</b>" }));
    expect(html).not.toContain("<b>XSS</b>");
    expect(html).toContain("&lt;b&gt;");
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `bun test test/worker/templates/event-card.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

From spec Section 3.3:
- Thick left border (8px solid `calendarColor`)
- Card layout: title, date, time (duration), location, description (3 lines max via `-webkit-line-clamp: 3`), attendees, conference link
- Calendar name at bottom
- Footer: "HyperCalendar"

- [ ] **Step 4: Run test — verify passes**

Run: `bun test test/worker/templates/event-card.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker/templates/event-card.ts test/worker/templates/event-card.test.ts
git commit -m "feat(image): add event card HTML template"
```

---

### Task 9: Template registry

**Files:**
- Create: `src/worker/templates/index.ts`
- Test: `test/worker/templates/registry.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/worker/templates/registry.test.ts
import { describe, expect, test } from "bun:test";
import { getTemplate } from "../../../src/worker/templates/index.ts";

describe("getTemplate", () => {
  test("returns daily-agenda template", () => {
    const t = getTemplate("daily-agenda");
    expect(typeof t.render).toBe("function");
  });

  test("returns weekly-overview template", () => {
    const t = getTemplate("weekly-overview");
    expect(typeof t.render).toBe("function");
  });

  test("returns event-card template", () => {
    const t = getTemplate("event-card");
    expect(typeof t.render).toBe("function");
  });

  test("throws on unknown type", () => {
    expect(() => getTemplate("unknown" as any)).toThrow();
  });
});
```

- [ ] **Step 2: Implement**

```ts
// src/worker/templates/index.ts
import type { ImageType, TemplateRenderer } from "./types.ts";
import { dailyAgendaTemplate } from "./daily-agenda.ts";
import { weeklyOverviewTemplate } from "./weekly-overview.ts";
import { eventCardTemplate } from "./event-card.ts";

const templates: Record<ImageType, TemplateRenderer<unknown>> = {
  "daily-agenda": dailyAgendaTemplate,
  "weekly-overview": weeklyOverviewTemplate,
  "event-card": eventCardTemplate,
};

export function getTemplate<T>(type: ImageType): TemplateRenderer<T> {
  const template = templates[type];
  if (!template) throw new Error(`Unknown template: ${type}`);
  return template as TemplateRenderer<T>;
}
```

- [ ] **Step 3: Run test — verify passes**

Run: `bun test test/worker/templates/registry.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/worker/templates/index.ts test/worker/templates/registry.test.ts
git commit -m "feat(image): add template registry"
```

---

## Chunk 3: Rendering Engine

### Task 10: Playwright pool

**Files:**
- Create: `src/worker/playwright-pool.ts`
- Test: `test/worker/playwright-pool.test.ts`

- [ ] **Step 1: Install Playwright**

```bash
bun add playwright
bunx playwright install chromium
```

- [ ] **Step 2: Write integration test**

```ts
// test/worker/playwright-pool.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PlaywrightPool } from "../../src/worker/playwright-pool.ts";

describe("PlaywrightPool", () => {
  let pool: PlaywrightPool;

  beforeAll(async () => {
    // Low values for testing — production defaults: maxPages=4, maxUseCount=50, maxAgeMs=300_000
    pool = new PlaywrightPool({ maxPages: 2, maxUseCount: 5, maxAgeMs: 60_000 });
    await pool.initialize();
  });

  afterAll(async () => {
    await pool.shutdown();
  });

  test("acquire returns a functional page", async () => {
    const page = await pool.acquire();
    expect(page).toBeDefined();
    expect(typeof page.setContent).toBe("function");
    await pool.release(page);
  });

  test("page can render HTML and screenshot", async () => {
    const page = await pool.acquire();
    await page.setContent(
      '<html><body><div id="__root" style="width:200px;height:100px;background:#f00;">Test</div></body></html>',
    );
    const height = await page.evaluate(() =>
      document.getElementById("__root")?.scrollHeight ?? 100,
    );
    expect(height).toBeGreaterThan(0);
    const buf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 200, height } });
    expect(buf.byteLength).toBeGreaterThan(100); // valid PNG
    await pool.release(page);
  });

  test("respects maxPages limit (timeout on third acquire)", async () => {
    const p1 = await pool.acquire();
    const p2 = await pool.acquire();
    await expect(pool.acquire(300)).rejects.toThrow("timeout");
    await pool.release(p1);
    await pool.release(p2);
  });

  test("reuses released pages", async () => {
    const p1 = await pool.acquire();
    await pool.release(p1);
    const p2 = await pool.acquire();
    expect(p2).toBe(p1);
    await pool.release(p2);
  });
});
```

- [ ] **Step 3: Implement PlaywrightPool**

Follow spec Section 5 exactly. Key points:
- Export `PlaywrightPool` class (for testing) and `playwrightPool` singleton (for production)
- `acquire(timeoutMs?)` with configurable timeout (default 10_000)
- `deviceScaleFactor: 2` (retina, mandatory per spec)
- `release()` clears page content
- `isStale()` checks `maxUseCount` (default 50) and `maxAgeMs` (default 5min)
- `recycleStale()` closes stale contexts
- `waitForFreePage()` polls every 100ms until timeout
- `shutdown()` closes all contexts + browser
- Chromium launch args: `--no-sandbox`, `--disable-gpu`, `--single-process`

```ts
// src/worker/playwright-pool.ts
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

interface PoolOptions {
  maxPages?: number;      // default 4
  maxUseCount?: number;   // default 50 — recycle page after N renders to prevent memory leaks
  maxAgeMs?: number;      // default 300_000 (5 min)
}

// ... Full implementation per spec lines 442-567 ...
// See docs/specs/05-image-generation.md Section 5

// Browser launch config — mandatory flags:
// chromium.launch({
//   args: ["--no-sandbox", "--disable-gpu", "--single-process"],
// })

// Context config — mandatory retina:
// browser.newContext({
//   deviceScaleFactor: 2,
//   viewport: { width: 1080, height: 800 },
// })

export const playwrightPool = new PlaywrightPool();
```

- [ ] **Step 4: Run test — verify passes**

Run: `bun test test/worker/playwright-pool.test.ts --timeout 30000`
Expected: PASS (first run ~5s for Chromium startup)

- [ ] **Step 5: Commit**

```bash
git add src/worker/playwright-pool.ts test/worker/playwright-pool.test.ts
git commit -m "feat(image): add Playwright browser context pool"
```

---

### Task 11: BullMQ image render queue + worker

**Files:**
- Create: `src/worker/image-render.queue.ts`

**Important:** BullMQ stores job results in Redis as JSON. `Buffer` serializes poorly, so the worker returns `bufferBase64: string` and the caller decodes it.

- [ ] **Step 1: Implement queue + worker**

```ts
// src/worker/image-render.queue.ts
import { Queue, QueueEvents, Worker } from "bullmq";
import { parseRedisUrl } from "../utils/redis.ts";
import { imageLogger } from "../utils/logger.ts";
import { playwrightPool } from "./playwright-pool.ts";
import { getTemplate } from "./templates/index.ts";
import type { DailyAgendaData, EventCardData, ImageType, WeeklyOverviewData } from "./templates/types.ts";

// --- Job types ---

export type ImageRenderJob =
  | { type: "daily-agenda"; data: DailyAgendaData; userId: number }
  | { type: "weekly-overview"; data: WeeklyOverviewData; userId: number }
  | { type: "event-card"; data: EventCardData; userId: number };

export interface ImageRenderResult {
  bufferBase64: string;   // PNG as base64 (Buffer doesn't survive Redis JSON roundtrip)
  width: number;
  height: number;
  renderTimeMs: number;
}

// --- Queue name ---

const QUEUE_NAME = "image-render";

// --- Process function (exported for testing) ---

export async function processRenderJob(job: ImageRenderJob): Promise<ImageRenderResult> {
  const start = performance.now();

  const template = getTemplate(job.type);
  const html = template.render(job.data);

  const page = await playwrightPool.acquire();
  try {
    await page.setContent(html, { waitUntil: "load" });

    const height = await page.evaluate(() =>
      document.getElementById("__root")?.scrollHeight ?? 800,
    );

    await page.setViewportSize({ width: 1080, height });

    const buffer = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: 1080, height },
    });

    const renderTimeMs = Math.round(performance.now() - start);
    imageLogger.info({ type: job.type, userId: job.userId, renderTimeMs, height }, "Image rendered");

    return {
      bufferBase64: Buffer.from(buffer).toString("base64"),
      width: 1080,
      height,
      renderTimeMs,
    };
  } finally {
    await playwrightPool.release(page);
  }
}

// --- Queue + Worker factory ---

export function createImageRenderQueue(redisUrl: string) {
  const connection = parseRedisUrl(redisUrl);

  const queue = new Queue<ImageRenderJob>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "fixed", delay: 1000 },
      removeOnComplete: { age: 60, count: 100 },
      removeOnFail: { age: 3600 },
    },
  });

  const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

  const worker = new Worker<ImageRenderJob, ImageRenderResult>(
    QUEUE_NAME,
    async (bullJob) => processRenderJob(bullJob.data),
    {
      connection,
      concurrency: 4,
      limiter: { max: 20, duration: 60_000 },
    },
  );

  worker.on("failed", (bullJob, err) => {
    imageLogger.error({ jobId: bullJob?.id, error: err.message }, "Image render failed");
  });

  return { queue, worker, queueEvents };
}
```

- [ ] **Step 2: Add imageLogger to logger.ts**

Add to `src/utils/logger.ts`:
```ts
export const imageLogger = logger.child({ module: "image" });
```

- [ ] **Step 3: Commit**

```bash
git add src/worker/image-render.queue.ts src/utils/logger.ts
git commit -m "feat(image): add BullMQ image render queue and worker"
```

---

## Chunk 4: Bot Integration

### Task 12: Data mapper (EventOccurrence → template data)

**Files:**
- Create: `src/services/image/data-mapper.ts`
- Test: `test/services/image/data-mapper.test.ts`

Pure functions. No DB, no Redis — takes `EventOccurrence[]` and metadata, returns template data.

- [ ] **Step 1: Write failing test**

```ts
// test/services/image/data-mapper.test.ts
import { describe, expect, test } from "bun:test";
import {
  mapDailyAgendaData,
  mapEventCardData,
  mapWeeklyOverviewData,
} from "../../../src/services/image/data-mapper.ts";
import { THEME_LIGHT } from "../../../src/worker/templates/themes.ts";
import type { CalendarEvent, EventOccurrence } from "../../../src/database/types.ts";

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1, user_id: 123, title: "Test Event", description: null, category: null,
    start_at: "2026-03-11T09:00:00Z", end_at: "2026-03-11T10:00:00Z",
    all_day: 0, timezone: "Europe/Kyiv", location: null,
    recurrence_rule: null, recurrence_end_at: null,
    parent_event_id: null, original_start_at: null, is_cancelled: 0,
    reminder_overrides: null, google_event_id: null, google_calendar_id: null,
    google_etag: null, sync_status: "local_only" as const, sync_version: 0,
    last_synced_at: null,
    created_at: "2026-03-11T08:00:00Z", updated_at: "2026-03-11T08:00:00Z",
    ...overrides,
  } as CalendarEvent;
}

function makeOcc(overrides: Partial<CalendarEvent> = {}): EventOccurrence {
  const event = makeEvent(overrides);
  return { event, occurrence_start: event.start_at, occurrence_end: event.end_at, is_exception: false };
}

describe("mapDailyAgendaData", () => {
  test("maps timed event with timezone conversion", () => {
    // 09:00 UTC = 11:00 Europe/Kyiv (UTC+2 in March)
    const result = mapDailyAgendaData({
      occurrences: [makeOcc()],
      dateIso: "2026-03-11",
      timezone: "Europe/Kyiv",
      locale: "en",
      theme: THEME_LIGHT,
    });
    expect(result.eventCount).toBe(1);
    expect(result.timedEvents).toHaveLength(1);
    expect(result.timedEvents[0].title).toBe("Test Event");
    expect(result.timedEvents[0].startMinutes).toBe(11 * 60); // 11:00 Kyiv
    expect(result.timedEvents[0].endMinutes).toBe(12 * 60);
  });

  test("separates all-day from timed", () => {
    const result = mapDailyAgendaData({
      occurrences: [
        makeOcc({ all_day: 1, start_at: "2026-03-11T00:00:00Z", end_at: null }),
        makeOcc({ id: 2, start_at: "2026-03-11T14:00:00Z", end_at: "2026-03-11T15:00:00Z" }),
      ],
      dateIso: "2026-03-11",
      timezone: "Europe/Kyiv",
      locale: "en",
      theme: THEME_LIGHT,
    });
    expect(result.allDayEvents).toHaveLength(1);
    expect(result.timedEvents).toHaveLength(1);
    expect(result.eventCount).toBe(2);
  });

  test("English date formatting", () => {
    const result = mapDailyAgendaData({
      occurrences: [],
      dateIso: "2026-03-11",
      timezone: "Europe/Kyiv",
      locale: "en",
      theme: THEME_LIGHT,
    });
    expect(result.dateFormatted).toContain("March");
    expect(result.dateFormatted).toContain("11");
    expect(result.dayOfWeek).toBe("Wednesday");
  });

  test("Russian date formatting", () => {
    const result = mapDailyAgendaData({
      occurrences: [],
      dateIso: "2026-03-11",
      timezone: "Europe/Kyiv",
      locale: "ru",
      theme: THEME_LIGHT,
    });
    expect(result.dateFormatted).toContain("марта");
    expect(result.dayOfWeek).toBe("Среда");
  });

  test("assigns event colors from palette", () => {
    const occs = [0, 1, 2].map((i) =>
      makeOcc({ id: i + 1, start_at: `2026-03-11T${String(9 + i).padStart(2, "0")}:00:00Z`,
        end_at: `2026-03-11T${String(10 + i).padStart(2, "0")}:00:00Z` }),
    );
    const result = mapDailyAgendaData({
      occurrences: occs, dateIso: "2026-03-11",
      timezone: "Europe/Kyiv", locale: "en", theme: THEME_LIGHT,
    });
    for (const ev of result.timedEvents) {
      expect(THEME_LIGHT.eventColors).toContain(ev.calendarColor);
    }
  });

  test("empty occurrences", () => {
    const result = mapDailyAgendaData({
      occurrences: [], dateIso: "2026-03-11",
      timezone: "UTC", locale: "en", theme: THEME_LIGHT,
    });
    expect(result.eventCount).toBe(0);
    expect(result.timedEvents).toEqual([]);
    expect(result.allDayEvents).toEqual([]);
  });
});

describe("mapWeeklyOverviewData", () => {
  test("produces 7 days starting from Monday", () => {
    const result = mapWeeklyOverviewData({
      occurrencesByDay: new Map(),
      weekStartIso: "2026-03-09", // Monday
      timezone: "Europe/Kyiv",
      locale: "en",
      theme: THEME_LIGHT,
    });
    expect(result.days).toHaveLength(7);
    expect(result.days[0].dayName).toBe("Mon");
    expect(result.days[0].dayNumber).toBe(9);
    expect(result.days[5].isWeekend).toBe(true);
    expect(result.days[6].isWeekend).toBe(true);
  });
});

describe("mapEventCardData", () => {
  test("maps event to card with timezone conversion", () => {
    const result = mapEventCardData({
      occurrence: makeOcc({ location: "Room 42", description: "Review proposals" }),
      timezone: "Europe/Kyiv",
      locale: "en",
      theme: THEME_LIGHT,
    });
    expect(result.title).toBe("Test Event");
    expect(result.location).toBe("Room 42");
    expect(result.description).toBe("Review proposals");
    expect(result.timeFormatted).toContain("11:00");
    expect(result.duration).toBe("1h");
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `bun test test/services/image/data-mapper.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement data mapper**

```ts
// src/services/image/data-mapper.ts
import { TZDate } from "@date-fns/tz";
import { addDays, getDay } from "date-fns";
import type { EventOccurrence } from "../../database/types.ts";
import { formatDuration, formatTime } from "../../worker/templates/helpers.ts";
import { getLabels } from "../../worker/templates/labels.ts";
import type {
  AgendaEvent, DailyAgendaData, EventCardData, MiniEvent,
  Theme, WeeklyOverviewData,
} from "../../worker/templates/types.ts";

function toMinutes(isoUtc: string, timezone: string): number {
  const d = new TZDate(new Date(isoUtc), timezone);
  return d.getHours() * 60 + d.getMinutes();
}

function formatDateLocale(dateIso: string, locale: string): string {
  const labels = getLabels(locale);
  const d = new Date(dateIso + "T12:00:00Z");
  const month = labels.monthNames[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  return locale === "ru" ? `${day} ${month} ${year}` : `${month} ${day}, ${year}`;
}

function getDayOfWeek(dateIso: string, locale: string): string {
  const labels = getLabels(locale);
  const d = new Date(dateIso + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun
  const idx = dow === 0 ? 6 : dow - 1; // Monday-based
  return labels.weekDaysFull[idx];
}

function mapToAgendaEvent(occ: EventOccurrence, tz: string, colorIdx: number, colors: string[]): AgendaEvent {
  const ev = occ.event;
  return {
    id: ev.id,
    title: ev.title,
    startMinutes: toMinutes(occ.occurrence_start, tz),
    endMinutes: occ.occurrence_end ? toMinutes(occ.occurrence_end, tz) : toMinutes(occ.occurrence_start, tz) + 60,
    location: ev.location ?? undefined,
    calendarColor: colors[colorIdx % colors.length],
    isAllDay: ev.all_day === 1,
  };
}

export function mapDailyAgendaData(params: {
  occurrences: EventOccurrence[];
  dateIso: string;
  timezone: string;
  locale: "ru" | "en";
  theme: Theme;
  currentTimeMinutes?: number;
  isHoliday?: boolean;
  holidayName?: string;
}): DailyAgendaData {
  const { occurrences, dateIso, timezone, locale, theme } = params;
  const allDay = occurrences.filter((o) => o.event.all_day === 1);
  const timed = occurrences.filter((o) => o.event.all_day !== 1);

  return {
    date: dateIso,
    dayOfWeek: getDayOfWeek(dateIso, locale),
    dateFormatted: formatDateLocale(dateIso, locale),
    relativeDay: params.currentTimeMinutes !== undefined ? getLabels(locale).today : undefined,
    eventCount: occurrences.length,
    currentTimeMinutes: params.currentTimeMinutes,
    isHoliday: params.isHoliday,
    holidayName: params.holidayName,
    allDayEvents: allDay.map((o, i) => mapToAgendaEvent(o, timezone, i, theme.eventColors)),
    timedEvents: timed.map((o, i) => mapToAgendaEvent(o, timezone, allDay.length + i, theme.eventColors)),
    theme,
    locale,
  };
}

export function mapWeeklyOverviewData(params: {
  occurrencesByDay: Map<string, EventOccurrence[]>;
  weekStartIso: string;
  timezone: string;
  locale: "ru" | "en";
  theme: Theme;
  todayIso?: string;
}): WeeklyOverviewData {
  const { weekStartIso, timezone, locale, theme, occurrencesByDay } = params;
  const labels = getLabels(locale);
  const start = new Date(weekStartIso + "T12:00:00Z");

  const days = Array.from({ length: 7 }, (_, i) => {
    const dayDate = addDays(start, i);
    const iso = dayDate.toISOString().slice(0, 10);
    const occs = occurrencesByDay.get(iso) ?? [];
    return {
      dayNumber: dayDate.getUTCDate(),
      dayName: labels.weekDaysShort[i],
      eventCount: occs.length,
      isWeekend: i >= 5,
      events: occs.map((o): MiniEvent => ({
        startMinutes: o.event.all_day === 1 ? 0 : toMinutes(o.occurrence_start, timezone),
        endMinutes: o.event.all_day === 1 ? 1440 : (o.occurrence_end ? toMinutes(o.occurrence_end, timezone) : toMinutes(o.occurrence_start, timezone) + 60),
        color: theme.eventColors[occs.indexOf(o) % theme.eventColors.length],
        isAllDay: o.event.all_day === 1,
      })),
    };
  });

  const todayIndex = params.todayIso
    ? days.findIndex((_, i) => addDays(start, i).toISOString().slice(0, 10) === params.todayIso)
    : undefined;

  return {
    weekLabel: formatWeekLabel(start, addDays(start, 6), locale),
    days,
    todayIndex: todayIndex !== undefined && todayIndex >= 0 ? todayIndex : undefined,
    theme,
    locale,
  };
}

function formatWeekLabel(start: Date, end: Date, locale: string): string {
  const labels = getLabels(locale);
  const sm = labels.monthNames[start.getUTCMonth()];
  const sd = start.getUTCDate();
  const ed = end.getUTCDate();
  const y = start.getUTCFullYear();
  if (start.getUTCMonth() === end.getUTCMonth()) {
    return locale === "ru" ? `${sd}–${ed} ${sm} ${y}` : `${sm} ${sd}–${ed}, ${y}`;
  }
  const em = labels.monthNames[end.getUTCMonth()];
  return locale === "ru" ? `${sd} ${sm} – ${ed} ${em} ${y}` : `${sm} ${sd} – ${em} ${ed}, ${y}`;
}

export function mapEventCardData(params: {
  occurrence: EventOccurrence;
  timezone: string;
  locale: "ru" | "en";
  theme: Theme;
}): EventCardData {
  const { occurrence, timezone, locale, theme } = params;
  const ev = occurrence.event;
  const startMin = toMinutes(occurrence.occurrence_start, timezone);
  const endMin = occurrence.occurrence_end ? toMinutes(occurrence.occurrence_end, timezone) : startMin + 60;

  const d = new TZDate(new Date(occurrence.occurrence_start), timezone);
  const dateStr = formatDateLocale(d.toISOString().slice(0, 10), locale);
  const dayOfWeek = getDayOfWeek(d.toISOString().slice(0, 10), locale);

  return {
    title: ev.title,
    dateFormatted: `${dayOfWeek}, ${dateStr}`,
    timeFormatted: ev.all_day === 1 ? "" : `${formatTime(startMin)} – ${formatTime(endMin)}`,
    duration: ev.all_day === 1 ? "" : formatDuration(endMin - startMin),
    location: ev.location ?? undefined,
    description: ev.description?.slice(0, 200) ?? undefined,
    calendarName: "HyperCalendar",
    calendarColor: theme.eventColors[0],
    isAllDay: ev.all_day === 1,
    theme,
    locale,
  };
}
```

- [ ] **Step 4: Run test — verify passes**

Run: `bun test test/services/image/data-mapper.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/image/data-mapper.ts test/services/image/data-mapper.test.ts
git commit -m "feat(image): add data mapper (EventOccurrence → template data)"
```

---

### Task 13: RenderService

**Files:**
- Create: `src/services/image/render-service.ts`
- Test: `test/services/image/render-service.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// test/services/image/render-service.test.ts
import { describe, expect, mock, test } from "bun:test";
import { RenderService } from "../../../src/services/image/render-service.ts";
import { THEME_LIGHT } from "../../../src/worker/templates/themes.ts";
import type { ImageRenderJob } from "../../../src/worker/image-render.queue.ts";

describe("RenderService", () => {
  test("renderDirect enqueues job and decodes base64 result", async () => {
    const pngBase64 = Buffer.from("fake-png-data").toString("base64");
    const mockJob = {
      id: "j1",
      waitUntilFinished: mock(() => Promise.resolve({
        bufferBase64: pngBase64,
        width: 1080, height: 800, renderTimeMs: 500,
      })),
    };
    const mockAdd = mock(() => Promise.resolve(mockJob));
    const mockQueueEvents = {};

    const service = new RenderService(
      { add: mockAdd } as any,
      mockQueueEvents as any,
    );

    const job: ImageRenderJob = {
      type: "daily-agenda",
      data: {
        date: "2026-03-11", dayOfWeek: "Wed", dateFormatted: "March 11",
        eventCount: 0, allDayEvents: [], timedEvents: [],
        theme: THEME_LIGHT, locale: "en",
      },
      userId: 123,
    };

    const result = await service.renderDirect(job);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe("fake-png-data");
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `bun test test/services/image/render-service.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```ts
// src/services/image/render-service.ts
import type { Queue, QueueEvents } from "bullmq";
import type { ImageRenderJob, ImageRenderResult } from "../../worker/image-render.queue.ts";
import { imageLogger } from "../../utils/logger.ts";

const RENDER_TIMEOUT_MS = 15_000;

export class RenderService {
  constructor(
    private queue: Queue<ImageRenderJob>,
    private queueEvents: QueueEvents,
  ) {}

  async renderDirect(job: ImageRenderJob): Promise<Buffer> {
    imageLogger.info({ type: job.type, userId: job.userId }, "Enqueuing render job");

    const added = await this.queue.add("render", job, { priority: 1 });

    const result = (await added.waitUntilFinished(
      this.queueEvents,
      RENDER_TIMEOUT_MS,
    )) as ImageRenderResult;

    imageLogger.info(
      { type: job.type, userId: job.userId, renderTimeMs: result.renderTimeMs },
      "Render complete",
    );

    return Buffer.from(result.bufferBase64, "base64");
  }
}
```

- [ ] **Step 4: Run test — verify passes**

Run: `bun test test/services/image/render-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/image/render-service.ts test/services/image/render-service.test.ts
git commit -m "feat(image): add RenderService (enqueue + await)"
```

---

### Task 14: Add callback prefixes

**Files:**
- Modify: `src/config/constants.ts`

- [ ] **Step 1: Add image CB prefixes**

Add to the `CB` object:
```ts
IMG_DAILY: "imd",    // image daily: "imd:2026-03-11"
IMG_WEEKLY: "imw",   // image weekly: "imw:2026-03-09"
```

- [ ] **Step 2: Commit**

```bash
git add src/config/constants.ts
git commit -m "feat(image): add IMG_DAILY and IMG_WEEKLY callback prefixes"
```

---

### Task 15: Wire image queue into entry point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import and create image queue**

In the section where Redis-dependent services are initialized (after google sync setup, or in a new block when `config.REDIS_URL` is available):

```ts
import { createImageRenderQueue } from "./worker/image-render.queue.ts";
import { RenderService } from "./services/image/render-service.ts";
import { playwrightPool } from "./worker/playwright-pool.ts";

// ... inside the REDIS_URL block:
let renderService: RenderService | undefined;
if (config.REDIS_URL) {
  const { queue: imgQueue, worker: imgWorker, queueEvents: imgQueueEvents } = createImageRenderQueue(config.REDIS_URL);
  renderService = new RenderService(imgQueue, imgQueueEvents);

  // Add to graceful shutdown:
  // await imgWorker.close();
  // await imgQueue.close();
  // await imgQueueEvents.close();
  // await playwrightPool.shutdown();
}
```

Pass `renderService` through to `createBot()`.

- [ ] **Step 2: Update createBot to accept renderService**

In `src/bot/index.ts`:
1. Add `renderService?: RenderService` to `createBot` signature (as part of an optional deps object or 5th param)
2. Pass it to `createCallbackHandler(eventService, editValueScene, holidayService, ..., renderService)` — same closure pattern as other services
3. Pass it to command handlers that need the 📷 button: `handleToday(ctx, eventService, holidayService, renderService)`, `handleWeek(ctx, eventService, holidayService, renderService)`

The pattern matches existing service wiring: services are created externally, passed to `createBot`, captured in closures by handlers.

- [ ] **Step 3: Run existing tests**

Run: `bun test`
Expected: all existing tests PASS (no regressions)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/bot/index.ts
git commit -m "feat(image): wire image render queue into entry point"
```

---

### Task 16: Add image buttons to commands + callback handler

**Files:**
- Modify: `src/bot/commands/today.ts`
- Modify: `src/bot/commands/week.ts`
- Modify: `src/bot/handlers/callback.handler.ts`

- [ ] **Step 1: Add 📷 button to /today**

After the text response, add inline button when `renderService` is available:

```ts
// In today.ts — add to the keyboard that's already sent (or create one)
import { CB } from "../../config/constants.ts";

// Inside handleToday, when building the reply:
if (renderService) {
  keyboard.text("📷", `${CB.IMG_DAILY}:${dateIso}`);
}
```

`dateIso` is the ISO date string for today (already computed in the handler).

- [ ] **Step 2: Add 📷 button to /week**

Same pattern with `CB.IMG_WEEKLY` and the week start ISO date.

- [ ] **Step 3: Handle IMG_DAILY callback**

In `callback.handler.ts`, add case:

```ts
import { mapDailyAgendaData } from "../../services/image/data-mapper.ts";
import { getTheme } from "../../worker/templates/themes.ts";

// Inside the callback router:
if (action === CB.IMG_DAILY && renderService) {
  const dateIso = payloadParts[0];
  await ctx.answer(); // dismiss loading spinner

  const now = new Date();
  const occurrences = eventService.getEventsForDay(user.telegram_id, new Date(dateIso + "T12:00:00Z"), user.timezone);

  // Check holidays (if service available)
  const holidays = holidayService?.getHolidaysForDate(dateIso, user.country_code ?? undefined);

  // Compute current time in user's TZ (only if viewing today)
  const todayIso = new TZDate(now, user.timezone).toISOString().slice(0, 10);
  const isToday = dateIso === todayIso;
  const currentTimeMinutes = isToday
    ? new TZDate(now, user.timezone).getHours() * 60 + new TZDate(now, user.timezone).getMinutes()
    : undefined;

  const data = mapDailyAgendaData({
    occurrences, dateIso, timezone: user.timezone,
    locale: user.language as "ru" | "en",
    theme: getTheme(),
    currentTimeMinutes,
    isHoliday: holidays && holidays.length > 0,
    holidayName: holidays?.[0]?.name,
  });

  try {
    const buffer = await renderService.renderDirect({
      type: "daily-agenda", data, userId: user.telegram_id,
    });
    // GramIO pattern: create File from Buffer, same as export.ts
    const file = new File([buffer], "agenda.png", { type: "image/png" });
    await ctx.sendPhoto(file);
  } catch (err) {
    imageLogger.error({ error: (err as Error).message }, "Render failed");
    // Text fallback: re-send the text agenda (already computed above in /today handler)
    // Image is nice-to-have, bot must always work without it
    await ctx.send("⚠️ Image generation failed. Use text version above.");
  }
}

- [ ] **Step 4: Handle IMG_WEEKLY callback**

Same pattern using `mapWeeklyOverviewData` and `"weekly-overview"` template type.
Photo sending: `const file = new File([buffer], "week.png", { type: "image/png" }); await ctx.sendPhoto(file);`
Fallback on error: `await ctx.send("⚠️ Image generation failed. Use text version above.");`

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: PASS

- [ ] **Step 6: Lint**

Run: `bun run lint:fix`
Expected: zero warnings

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/today.ts src/bot/commands/week.ts src/bot/handlers/callback.handler.ts
git commit -m "feat(image): add image buttons to /today and /week commands"
```

---

### Task 17: Manual end-to-end verification

**Prerequisites:** Redis running, `.env` has `REDIS_URL`

- [ ] **Step 1: Start bot**

```bash
bun run src/index.ts
```

- [ ] **Step 2: Test /today image**

1. Send `/today` in Telegram
2. Verify text agenda with 📷 button
3. Tap 📷
4. Verify PNG image appears (daily agenda with correct date, events, theme)

- [ ] **Step 3: Test /week image**

1. Send `/week` in Telegram
2. Tap 📷
3. Verify weekly overview image

- [ ] **Step 4: Test error fallback**

Stop Redis, tap 📷 — verify error message appears, bot doesn't crash.

- [ ] **Step 5: Fix any issues found, commit**

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Worker process | In-process (same as bot) | Matches existing notification/sync queue pattern. Extract later if memory is an issue. |
| Buffer transport via BullMQ | base64 string | `Buffer` doesn't survive Redis JSON roundtrip. ~33% overhead, acceptable for 200-500KB PNGs. |
| Overlapping events | Column assignment algorithm | Spec recommends it (Open Question #1). ~30 lines, makes timeline look professional. |
| Font embedding | base64 woff2 in TS constant | Playwright renders from `setContent()`, can't load external resources. |
| Retina | `deviceScaleFactor: 2` | Mandatory per spec and common architecture (Section 6). |
| Caching | None | Per spec Section 7 and common architecture Section 6. Telegram caches on its CDN. |

## Deferred (not in this plan)

- **Morning notification images** — wire when notification system calls `RenderService`
- **User theme selection** — settings UI (default: light)
- **Weather slot** — empty placeholder for future weather integration
- **Avatar/profile photo** — deferred per spec Open Questions
- **Separate worker process** — extract if memory >1GB becomes a problem
