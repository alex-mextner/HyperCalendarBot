> Part 1 of 3 of [Image Generation Implementation Plan](../2026-03-13-image-generation.md) — next: [02-tasks-6-11.md](02-tasks-6-11.md)

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

