# Sub-Project 08: Holidays

## Overview

Users subscribe to public/bank holidays by country. Holidays integrate into the calendar view, morning agenda, AI agent context, and scheduling logic. One country is marked "primary" (current working location) — its holidays affect free-slot calculations and day-off logic.

---

## 1. Holiday Data Source Evaluation

### Option A: Nager.Date API (free, hosted)

- **URL:** `https://date.nager.at/api/v3/publicholidays/{year}/{countryCode}`
- **Countries:** 100+
- **Auth:** None required
- **Rate limits:** Unlimited (public API)
- **Cost:** Free
- **Response fields:** `date`, `localName`, `name`, `countryCode`, `fixed`, `global`, `counties`, `launchYear`, `types[]`
- **Holiday types:** Public, Bank, School, Authorities, Optional, Observance
- **Self-hosted:** Docker available (`nager/nager-date`), but requires sponsor license key

**Pros:**

- Zero cost, no API key, no rate limits
- Clean REST API, JSON response
- 100+ countries, covers all major ones
- Holiday types classification (Public, Bank, Observance, etc.)
- `localName` field gives native language name
- Well-maintained open-source project

**Cons:**

- External dependency — public API may go down or change
- No multi-language support beyond `localName` + `name` (English)
- Self-hosted Docker requires sponsor license
- Fewer countries than `date-holidays` (100 vs 199)
- No Islamic/Hebrew calendar-specific handling visible in API

### Option B: `date-holidays` npm package (offline)

- **URL:** <https://github.com/commenthol/date-holidays>
- **Countries:** 199
- **Auth:** N/A (local library)
- **Cost:** Free (CC BY-SA 3.0)
- **Package size:** ~10 MB unpacked, ~1.5 MB bundled
- **Holiday types:** public, bank, school, optional, observance

**Pros:**

- Offline — no network calls, no external dependency
- 199 countries — best coverage
- Islamic calendar support (1970–2080), Hebrew calendar (1970–2100), Chinese calendar
- Multi-language holiday names built in
- Timezone-aware holiday checks with start/end times
- Substitute day calculations
- Custom holiday definitions possible
- State/region level granularity (ISO 3166-2)

**Cons:**

- 10 MB package size (can be trimmed with `holidays2json --pick`)
- Data updates require npm package update
- Community-maintained, Wikipedia-sourced data (CC BY-SA 3.0)
- Bundle size concerns for serverless (not relevant for us — Bun process)

### Option C: Google Calendar API

- **URL:** Google Calendar API v3
- **Countries:** ~80+ (public holiday calendars)
- **Auth:** API key required (Google Cloud Console)
- **Cost:** Free tier available
- **Calendar ID format:** `en.usa#holiday@group.v.calendar.google.com`

**Pros:**

- Google-maintained data, generally accurate
- Free tier sufficient for our use case

**Cons:**

- Requires Google Cloud project setup and API key management
- Calendar IDs are non-obvious, not all countries available
- Response format is calendar events, not holiday-specific — needs parsing
- No holiday type classification (everything is just an "event")
- Rate limited (Google Calendar API quotas)
- Overkill dependency for just holiday data

### Option D: Calendarific API (freemium)

- **URL:** <https://calendarific.com/api-documentation>
- **Countries:** 230+
- **Auth:** API key required
- **Cost:** Free tier — 1,000 requests/month; paid plans available
- **Holiday types:** National, Local, Religious, Observance

**Pros:**

- Largest country coverage (230+)
- Religious and local holiday types
- Multi-language support

**Cons:**

- 1,000 requests/month free limit — tight for a growing user base
- Requires API key
- Paid plans needed at scale
- External dependency

### Recommendation: `date-holidays` (primary) + Nager.Date (fallback)

**Primary: `date-holidays` npm package.**

Rationale:

1. **Offline-first** — no network dependency for holiday resolution. Critical for a bot that checks holidays on every morning agenda, every scheduling request, every AI prompt.
2. **199 countries** — exceeds the 50+ requirement by 4x.
3. **Islamic/Hebrew calendar** — handles movable religious holidays that Nager.Date doesn't explicitly support.
4. **Multi-language names** — Russian and English holiday names out of the box.
5. **Timezone-aware** — important for a calendar product.
6. **10 MB is nothing** for a Bun server process. We're not shipping to browsers.
7. **No API key, no rate limits, no quota** — holidays are computed locally.

**Fallback plan:** If `date-holidays` data is stale or missing for a specific country, we can supplement with Nager.Date API calls (cached in SQLite). This is a rare edge case, not the primary path.

**Custom holiday build:** Use `holidays2json --pick` to generate data for only the countries we need, reducing bundle from 10 MB to ~1–2 MB. As user subscriptions grow, regenerate. Or just ship the full 10 MB — it's a server, not a phone.

---

## 2. SQLite Schema

```sql
-- Countries available for holiday subscription
-- Populated from date-holidays supported country list
CREATE TABLE holiday_countries (
  country_code TEXT PRIMARY KEY,        -- ISO 3166-1 alpha-2: "RU", "TR", "US"
  name_en TEXT NOT NULL,                -- "Russia", "Turkey", "United States"
  name_ru TEXT,                         -- "Россия", "Турция", "США"
  supported INTEGER NOT NULL DEFAULT 1, -- 1 = holidays available, 0 = disabled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User holiday subscriptions
CREATE TABLE holiday_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,             -- telegram_id
  country_code TEXT NOT NULL,           -- FK -> holiday_countries.country_code
  is_primary INTEGER NOT NULL DEFAULT 0, -- 1 = primary working country
  notify_eve INTEGER NOT NULL DEFAULT 0, -- 1 = send "tomorrow is X" notification
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, country_code),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
  FOREIGN KEY (country_code) REFERENCES holiday_countries(country_code)
);

-- Cached holiday data per country per year
-- Computed from date-holidays library, stored for fast lookup
CREATE TABLE holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  country_code TEXT NOT NULL,
  year INTEGER NOT NULL,
  date TEXT NOT NULL,                   -- ISO 8601: "2026-01-01"
  name_en TEXT NOT NULL,                -- "New Year's Day"
  name_ru TEXT,                         -- "Новый год"
  local_name TEXT,                      -- Native language name from date-holidays
  type TEXT NOT NULL,                   -- "public", "bank", "school", "optional", "observance"
  is_substitute INTEGER NOT NULL DEFAULT 0, -- 1 = substitute/transferred day
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(country_code, date, name_en)
);

-- User overrides: work on holidays or mark custom days off
CREATE TABLE holiday_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,           -- telegram_id
  date TEXT NOT NULL,                 -- "2026-05-09"
  is_working INTEGER NOT NULL,       -- 1 = working despite holiday, 0 = day off despite not holiday
  note TEXT,                          -- "Deadline, working from home"
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

-- Indexes for common queries
CREATE INDEX idx_holidays_date ON holidays(date);
CREATE INDEX idx_holidays_country_year ON holidays(country_code, year);
CREATE INDEX idx_holiday_subs_user ON holiday_subscriptions(user_id);
CREATE INDEX idx_holiday_overrides_user_date ON holiday_overrides(user_id, date);
```

### Schema Notes

- **No separate `holiday_types` table.** Types are a fixed enum from `date-holidays`: `public | bank | school | optional | observance`. A TEXT column is simpler than a join.
- **`holidays` table is a cache.** Regenerated annually from `date-holidays`. If the library updates mid-year, we can re-compute.
- **`name_ru`** — populated using `date-holidays` multi-language support. Falls back to `name_en` if Russian translation unavailable.
- **`is_primary`** — exactly one subscription per user should have `is_primary = 1`. Enforced in application logic (not DB constraint, since it's a cross-row rule).

---

## 3. `/holidays` Command Flow

### 3.1 Entry Point

```
/holidays
```

Displays an inline keyboard menu:

```
Holiday Subscriptions

Your subscriptions:
  [home] Russia (primary)
  Turkey

[+ Add Country]  [Manage]
```

### 3.2 Add Country Flow

1. User taps **[+ Add Country]**
2. Bot sends inline keyboard with region groups:

   ```
   Select region:
   [Europe] [Asia] [Americas]
   [Africa] [Oceania] [Middle East]
   ```

3. User selects region -> list of countries in that region (paginated, 8 per page)
4. User taps country -> subscription created
5. Bot confirms: `"Added Turkey. Upcoming holidays: Republic Day (Oct 29), ..."` — show next 2-3 holidays
6. If this is the user's first subscription, it's automatically set as primary

### 3.3 Manage Subscriptions

1. User taps **[Manage]**
2. Bot shows list of subscribed countries with per-country actions:

   ```
   Russia [home]
   [Set Primary: on] [Notifications: OFF] [Remove]

   Turkey
   [Set Primary] [Notifications: ON] [Remove]
   ```

3. **Set Primary** — marks this country as primary working location. Only one primary at a time.
4. **Notifications** — toggle evening "tomorrow is a holiday" notification.
5. **Remove** — unsubscribe. Confirm before removing primary.

### 3.4 View Upcoming Holidays

```
/holidays list
```

Shows upcoming holidays across all subscribed countries for the next 30 days:

```
Upcoming holidays:

Mar 21 — Nowruz (Turkey)
Apr 23 — National Sovereignty Day (Turkey) [home]
May 1 — Labour Day (Russia, Turkey) [home]
May 9 — Victory Day (Russia) [home]

[home] = affects your schedule (primary country)
```

### 3.5 Callback Data Format

```
holidays:menu              — main menu
holidays:add               — region selection
holidays:add:{region}      — country list
holidays:add:{CC}:confirm  — add subscription
holidays:manage            — manage list
holidays:manage:{CC}       — per-country actions
holidays:primary:{CC}      — set primary
holidays:notify:{CC}       — toggle notification
holidays:remove:{CC}       — remove (with confirmation)
holidays:list              — upcoming holidays
holidays:page:{n}          — pagination
```

---

## 4. Calendar Integration Points

### 4.1 Daily/Weekly Agenda Text

When generating agenda text (sub-project 05), query holidays for the date range:

```typescript
function getHolidaysForDateRange(
  userId: number,
  startDate: string,
  endDate: string
): HolidayEntry[]
```

Holidays appear in agenda as:

```
Monday, March 21
  * Nowruz (Turkey)
  09:00 — Team standup
  14:00 — Client call
```

For primary country holidays, add emphasis:

```
Friday, May 1
  * Labour Day — Day Off [primary]
  (no events scheduled)
```

### 4.2 Agenda Image Rendering (sub-project 05)

- Holiday dates get a subtle background color or badge in the calendar grid
- Primary country holidays: distinct "day off" indicator (e.g., pale red background)
- Non-primary holidays: small dot or icon marker
- Holiday name rendered below the date number if space allows

### 4.3 AI Agent Context

When building prompt context for the AI agent, include:

```
Today's holidays:
- Labour Day (Russia) — public holiday, day off
- Labour Day (Turkey) — public holiday

Upcoming holidays this week:
- May 9: Victory Day (Russia) — day off
```

This lets the AI agent:

- Greet the user on holidays: "Today is Victory Day. Want me to keep your schedule clear?"
- Suggest rescheduling around holidays
- Mention holidays when asked "what's happening this week?"

### 4.4 Morning Agenda Notification

If today is a holiday in any subscribed country:

```
Good morning! Today is Labour Day (Russia).
Your schedule for today: ...
```

If today is a primary-country holiday and user has events:

```
Good morning! Today is a holiday (Labour Day, Russia) but you have 2 events scheduled.
```

---

## 5. Data Refresh Strategy

### 5.1 Initial Population

On first bot startup or DB migration:

1. Load `date-holidays` library
2. For each supported country, compute holidays for current year and next year
3. Insert into `holidays` table
4. Populate `holiday_countries` table with all supported countries

### 5.2 Annual Refresh

**BullMQ repeatable job:** `holiday:refresh`

- Schedule: January 1st, 03:00 UTC (or first bot startup after Jan 1)
- Action: Compute holidays for the new year (current year + 1) for all countries that have at least one subscriber
- This is a worker task — runs in the worker process, not the bot process

```typescript
// Register repeatable job (once at startup)
await holidayQueue.add('refresh', {}, {
  repeat: { pattern: '0 3 1 1 *' }, // Jan 1st at 03:00 UTC
});

// Worker job payload
interface HolidayRefreshJob {
  type: 'holiday:refresh';
  year: number;
  countryCodes: string[]; // only countries with active subscribers
}
```

### 5.3 On-Demand Refresh

- When a user subscribes to a new country, check if holidays for current year + next year exist in cache
- If not, compute and cache immediately (synchronous — `date-holidays` is fast, <50ms per country)
- No worker needed for single-country refresh

### 5.4 Handling Late-Announced Holidays

Some countries (especially for Islamic holidays) announce exact dates close to the holiday. `date-holidays` handles this via its Islamic calendar support (computed algorithmically, not from announcements). The dates may differ by +/-1 day from government announcements.

Mitigation:

- Document this limitation for users
- Allow manual override via AI agent: "Mark March 30 as a holiday for me"
- `holiday_overrides` table supports user-defined days off (see section 6.3)

### 5.5 Library Updates

When `date-holidays` npm package is updated with new/corrected data:

- After `bun install`, run a migration/refresh script
- Or: expose a `/admin refresh-holidays` command for manual trigger

---

## 6. Scheduling Impact Logic

### 6.1 Core Rule

```
Primary country public/bank holidays = days off (by default)
```

Only `public` and `bank` type holidays from the primary country affect scheduling. `observance`, `optional`, `school` do not block time.

### 6.2 Free Slot Calculation

When AI agent or scheduling logic searches for free slots:

```typescript
function isWorkingDay(userId: number, date: string): boolean {
  // 1. Check user overrides first (explicit override wins)
  // 2. Check if weekend (user's configured work week)
  // 3. Check if primary-country public/bank holiday
  // Returns false if it's a day off
}

function findFreeSlots(
  userId: number,
  startDate: string,
  endDate: string,
  durationMinutes: number
): TimeSlot[] {
  // Skip non-working days (weekends + primary holidays)
  // Unless user has existing events on that day (implicit override)
  // Return available slots on working days only
}
```

### 6.3 User Override

Users can override holiday behavior:

- **Implicit:** If a user has events on a holiday, the system treats it as a working day for that specific date
- **Explicit:** AI agent command: "I'm working on May 9th" -> stores override in `holiday_overrides` table

### 6.4 AI Agent Behavior

When the AI agent is asked to schedule something on a holiday:

```
User: "Schedule a meeting on May 9th at 10am"
Agent: "May 9th is Victory Day (day off). Want me to schedule it anyway,
        or would you prefer May 8th or May 11th?"
```

When finding free time and a holiday is in the range:

```
User: "Find me a free slot this week for a 1-hour meeting"
Agent: (skips May 9 — Victory Day)
       "How about Thursday May 8th at 14:00 or Monday May 11th at 10:00?"
```

---

## 7. Holiday Notification System

### 7.1 Evening "Tomorrow is a Holiday" Notification

**Trigger:** Runs as part of the notification system's per-minute tick (sub-project 04). The tick checks each user's configured evening time (e.g., 20:00 local) and fires the holiday check when the time matches. No separate cron job — this piggybacks on the existing BullMQ repeatable job that ticks every 60 seconds.

**Logic:**

```typescript
async function checkTomorrowHolidays(userId: number): Promise<void> {
  const tomorrow = getTomorrow(userTimezone);
  const subscriptions = getSubscriptionsWithNotify(userId); // notify_eve = 1

  const holidays = getHolidaysForDate(
    tomorrow,
    subscriptions.map(s => s.countryCode)
  );

  if (holidays.length > 0) {
    const message = formatHolidayNotification(holidays, userLang);
    await sendTelegramMessage(userId, message);
  }
}
```

**Message format:**

```
Tomorrow is a holiday:
  Victory Day (Russia)

You have 0 events scheduled for tomorrow.
```

Or if events exist on a primary-country holiday:

```
Tomorrow is Victory Day (Russia) — a day off.
You still have 2 events scheduled. Want to reschedule them?
[Keep as is] [Reschedule]
```

### 7.2 Integration with Morning Agenda

The morning agenda job checks holidays as part of its flow. No separate notification — just enriched agenda text (see section 4.4).

---

## 8. Key Interfaces

```typescript
interface HolidayEntry {
  date: string;            // "2026-05-09"
  nameEn: string;          // "Victory Day"
  nameRu: string | null;   // "День Победы"
  localName: string | null; // Native name from date-holidays
  countryCode: string;     // "RU"
  type: HolidayType;       // "public" | "bank" | "school" | "optional" | "observance"
  isSubstitute: boolean;
}

type HolidayType = 'public' | 'bank' | 'school' | 'optional' | 'observance';

interface HolidaySubscription {
  userId: number;
  countryCode: string;
  isPrimary: boolean;
  notifyEve: boolean;
}

interface HolidayOverride {
  userId: number;
  date: string;
  isWorking: boolean;
  note: string | null;
}

// HolidayService public API
interface IHolidayService {
  // Data
  getHolidaysForDate(date: string, countryCodes: string[]): HolidayEntry[];
  getHolidaysForRange(start: string, end: string, countryCodes: string[]): HolidayEntry[];
  getUpcomingHolidays(countryCodes: string[], limit: number): HolidayEntry[];
  refreshHolidays(countryCodes: string[], year: number): Promise<void>;

  // Subscriptions
  subscribe(userId: number, countryCode: string): Promise<void>;
  unsubscribe(userId: number, countryCode: string): Promise<void>;
  setPrimary(userId: number, countryCode: string): Promise<void>;
  getSubscriptions(userId: number): HolidaySubscription[];
  getPrimaryCountry(userId: number): string | null;

  // Scheduling
  isHoliday(date: string, countryCode: string): boolean;
  isDayOff(userId: number, date: string): boolean; // considers primary + overrides
  setOverride(userId: number, date: string, isWorking: boolean, note?: string): Promise<void>;
}
```

---

## 9. Implementation Plan

### Phase 1: Core Data Layer

1. Install `date-holidays` (`bun add date-holidays`)
2. Create `holiday_countries`, `holidays`, `holiday_subscriptions`, `holiday_overrides` tables
3. Write `HolidayService` — wrapper around `date-holidays` with SQLite caching
4. Populate holiday data for current year + next year on startup
5. Annual refresh BullMQ job

### Phase 2: `/holidays` Command

1. Main menu with inline keyboard
2. Add country flow (region -> country -> confirm)
3. Manage subscriptions (primary, notifications, remove)
4. `/holidays list` — upcoming holidays view

### Phase 3: Calendar Integration

1. Agenda text enrichment (daily/weekly)
2. AI agent context injection
3. Morning agenda holiday mentions

### Phase 4: Scheduling Impact

1. `isWorkingDay()` with holiday check
2. Free slot calculation respects primary holidays
3. AI agent holiday-aware scheduling suggestions
4. Override logic (implicit via existing events, explicit via command)

### Phase 5: Notifications

1. Evening "tomorrow is a holiday" check (integrated into sub-project 04 per-minute tick)
2. Per-subscription notification toggle
3. Reschedule prompt for events on holidays

---

## 10. Cost Considerations

| Item | Cost |
|------|------|
| `date-holidays` npm package | Free (CC BY-SA 3.0) |
| Nager.Date API (fallback) | Free, no API key |
| SQLite storage | Negligible (~100KB per country per year) |
| BullMQ refresh jobs | Negligible compute |
| **Total** | **$0/month** |

No paid APIs. No external service dependencies at runtime. Holiday computation happens locally via `date-holidays`. SQLite acts as a performance cache, not a data source.

---

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `date-holidays` data inaccuracy | Wrong holiday dates shown | Cross-check with Nager.Date API for major countries; accept +/-1 day for Islamic holidays |
| `date-holidays` package abandoned | No updates for new holidays | Fork the repo; data is YAML, easy to maintain. Or switch to Nager.Date API as primary |
| Package size (10 MB) | Slower install | Use `holidays2json --pick` for custom build. Or accept it — server process, not a browser |
| Islamic holidays +/-1 day | Confusing for users | Document limitation; allow manual overrides via `holiday_overrides` |
| User subscribes to many countries | Noisy agenda | Show max 3 holidays in morning agenda, full list in `/holidays list` |
| Country holiday laws change mid-year | Stale cache | `refreshHolidays()` method + admin command for manual refresh |
