> Part 2 of 2 of [Sub-Project #5: Image Generation](../05-image-generation.md) — previous: [01-overview-sections-1-6.md](01-overview-sections-1-6.md)

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
