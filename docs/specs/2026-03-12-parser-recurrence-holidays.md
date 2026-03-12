# Multilingual Parser + Recurring Events UI + Holidays

Three features extending Phase A before moving to Phase B.

---

## Feature 1: Multilingual Parser Extensions

All parsers accept both Russian and English input simultaneously, regardless of user's language setting.

### 1.1 Duration Parser (`parseDuration`)

**Current:** `1h`, `1ч`, `30m`, `30м`, `1:30`, `90`

**Add full-word suffixes:**

| Pattern | Examples |
|---------|---------|
| EN hours | `hour`, `hours`, `hr` |
| EN minutes | `minute`, `minutes`, `min` |
| RU hours | `час`, `часа`, `часов` |
| RU minutes | `минута`, `минуты`, `минут`, `мин` |

Combined: `"1 час 30 минут"`, `"2 hours 15 min"`, `"12 часов"`, `"1hr 30min"`

**Special forms:**

| Pattern | Result |
|---------|--------|
| `полчаса`, `half an hour`, `half hour` | 30 minutes |
| `полтора часа` | 90 minutes |

**Implementation:** Replace single-char suffix regex `[hч]` / `[mм]` with alternation groups covering all word forms. Add special-case matching for `полчаса`/`полтора часа`/`half an hour` before the regex. Keep colon and plain-number formats as-is.

### 1.2 Date Parser (`parseSimpleDate`)

**Current:** abbreviated weekdays (пн–вс, mon–sun), full English weekdays (monday–sunday), today/сегодня, tomorrow/завтра, month names (3-char RU + 3-char/full EN).

**Add:**

| Category | Values |
|----------|--------|
| Full RU weekdays | понедельник, вторник, среда, четверг, пятница, суббота, воскресенье |
| "Day after tomorrow" | `послезавтра`, `day after tomorrow` |
| Full RU months | январь/января, февраль/февраля, март/марта, апрель/апреля, май/мая, июнь/июня, июль/июля, август/августа, сентябрь/сентября, октябрь/октября, ноябрь/ноября, декабрь/декабря |

**Implementation:**

- Extend `dayNames` record with full Russian forms.
- Add `послезавтра` / `day after tomorrow` branch (analogous to `завтра` / `tomorrow`, with `addDays(ref, 2)`). Time is optional — defaults to 00:00 if omitted, same as `tomorrow`.
- Extend `months` record with full Russian forms and declensions.

**Note:** `tomorrow` and `послезавтра` without time default to 00:00 (start of day). This is consistent — the user will be prompted to add time if needed by the calling context.

### 1.3 Tests

Every new format gets a test case. Extend existing `test/utils/date.test.ts` with new patterns.

---

## Feature 2: Recurring Events UI

### 2.1 Creation — New Steps in add-event Scene

After the duration step, add two conditional steps. Scene state (`AddEventState`) gains `recurrenceRule: string | null`.

**Step "Recurrence"** — inline keyboard:

```
[Не повторять / Don't repeat]
[Каждый день / Daily]  [Каждую неделю / Weekly]
[Каждый месяц / Monthly]  [Каждый год / Yearly]
[Другое... / Custom...]
```

Keyboard buttons generate RRULE freq directly (e.g. callback data `as:rec:DAILY`). No need to go through `parseRecurrence()` — that's only for "Custom..." text input.

If "Custom..." selected → text input parsed by `parseRecurrence()`.

**Step "Recurrence End"** — shown only if recurrence selected. If "Don't repeat" was chosen, skip this step entirely (call `scene.step.go(nextStepIndex)` or equivalent mechanism — see 2.7).

Inline keyboard:

```
[Бесконечно / No end]
[До даты / Until date]
[N повторений / N times]
```

- "No end" → no UNTIL/COUNT in RRULE
- "Until date" → text input, parsed by `parseSimpleDate()` → appended as `;UNTIL=YYYYMMDDTHHmmssZ`
- "N times" → text input, numeric → appended as `;COUNT=N`

Result: RRULE string (e.g. `FREQ=WEEKLY;INTERVAL=2;COUNT=10`) stored in scene state, passed to `createEvent()`.

**Updated scene step order:**
0. Title (text)

1. Date/Time (text)
2. Duration (text + skip button)
3. Recurrence (keyboard + custom text)
4. Recurrence End (keyboard + text, conditional — skipped if no recurrence)
5. Description (text + skip button)
6. Location (text + skip button) → `createEvent()`

### 2.2 Recurrence Text Parser

New function in `src/utils/date.ts`: `parseRecurrence(input: string): RecurrenceParsed | null`

```typescript
interface RecurrenceParsed {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
}
```

Patterns (all bilingual):

| Input | Result |
|-------|--------|
| `каждый день`, `every day`, `daily`, `ежедневно` | DAILY, interval 1 |
| `каждую неделю`, `every week`, `weekly`, `еженедельно` | WEEKLY, interval 1 |
| `каждый месяц`, `every month`, `monthly`, `ежемесячно` | MONTHLY, interval 1 |
| `каждый год`, `every year`, `yearly`, `ежегодно` | YEARLY, interval 1 |
| `каждые 2 недели`, `every 2 weeks`, `через неделю` | WEEKLY, interval 2 |
| `каждые 3 дня`, `every 3 days` | DAILY, interval 3 |
| `каждые 2 месяца`, `every 2 months` | MONTHLY, interval 2 |

### 2.3 Callback Data for Recurring Event Occurrences

**Problem:** Current `eventActionsKeyboard` encodes only `eventId`. For recurring events, the system also needs `occurrenceDate` to know which instance is being acted upon.

**Solution:** Encode occurrence date in callback data for recurring event occurrences.

Format: `{prefix}:{templateId}:{occurrenceISO}`

Examples:

- `ee:42:2026-03-15T10:00:00Z` — edit occurrence of event 42 on Mar 15
- `ed:42:2026-03-15T10:00:00Z` — delete occurrence of event 42 on Mar 15

For one-off events, format stays as-is: `ee:42`, `ed:42`.

The callback handler detects recurring vs one-off by checking whether the third segment exists. If it does → show scope keyboard. If not → proceed directly to edit/delete.

**Scope keyboard callback data:**

- `er:42:2026-03-15T10:00:00Z:this` — edit this occurrence only
- `er:42:2026-03-15T10:00:00Z:future` — edit all future
- `erd:42:2026-03-15T10:00:00Z:this` — delete this occurrence
- `erd:42:2026-03-15T10:00:00Z:future` — delete all future

**Callback data length:** Telegram allows max 64 bytes. `erd:42:2026-03-15T10:00:00Z:future` = 38 chars — fits.

### 2.4 Editing Recurring Events — Scope Selection

When user taps "Edit" or "Delete" on a recurring event occurrence, show scope keyboard (Apple Calendar style — two options only):

```
[Только это / This only]
[Все будущие / All future]
```

**Edit — "This only":**

1. Create exception record: child event with `parent_event_id = templateId`, `original_start_at = occurrenceDate`.
2. Copy all fields from template to exception.
3. Enter edit-value scene with the new exception's ID.
4. User edits the field → `updateEvent(exceptionId, ...)` updates the exception row.

**Edit — "All future":**

1. Append `UNTIL` to original template's RRULE (set to day before `occurrenceDate`).
2. Create new template event: copy all fields from original, set `start_at` = `occurrenceDate`, set `recurrence_rule` = original FREQ/INTERVAL (no UNTIL/COUNT, or adjusted COUNT).
3. Re-parent exceptions: any exception with `parent_event_id = originalId` AND `original_start_at >= occurrenceDate` → update `parent_event_id` to new template ID.
4. Enter edit-value scene with the new template's ID.

**Delete — "This only":**
`cancelOccurrence(templateId, occurrenceDate)` — creates cancelled exception (already implemented in EventService).

**Delete — "All future":**

1. Append `UNTIL` to original template's RRULE (set to day before `occurrenceDate`).
2. Delete all exceptions with `parent_event_id = templateId` AND `original_start_at >= occurrenceDate`.

### 2.5 New EventService Methods

```typescript
// Edit a single occurrence — creates exception with modified fields
editOccurrence(templateId: number, occurrenceDate: string, userId: number): Promise<CalendarEvent>
// Returns the newly created exception event (for entering edit-value scene)

// Split template at occurrenceDate, returns new template
splitRecurrence(templateId: number, occurrenceDate: string, userId: number): Promise<CalendarEvent>
// 1. Adds UNTIL to original template
// 2. Creates new template starting at occurrenceDate
// 3. Re-parents exceptions
// Returns new template (for entering edit-value scene)

// Delete all future occurrences
deleteFuture(templateId: number, occurrenceDate: string): Promise<void>
// 1. Adds UNTIL to original template
// 2. Deletes exceptions >= occurrenceDate
```

### 2.6 New EventRepository Methods

```typescript
// Get exceptions for a template on or after a date
getExceptionsFrom(templateId: number, fromDate: string): CalendarEventRow[]

// Re-parent exceptions to a new template
reparentExceptions(oldTemplateId: number, newTemplateId: number, fromDate: string): void

// Delete exceptions on or after a date
deleteExceptionsFrom(templateId: number, fromDate: string): void

// Append UNTIL to an event's recurrence_rule
setRecurrenceUntil(eventId: number, untilDate: string): void
```

### 2.7 Conditional Step Skipping in @gramio/scenes

When the user selects "Don't repeat" on the recurrence step, the recurrence-end step must be skipped.

**Approach:** At the end of the recurrence step handler, if no recurrence was selected, programmatically advance to the description step (step 5) instead of the default next step (step 4). Use `scene.step.go(5)` or equivalent API. If `@gramio/scenes` doesn't support `go(n)`, use a flag in scene state (`skipRecurrenceEnd: boolean`) and have step 4 immediately advance when the flag is set.

### 2.8 Skip Buttons in Scenes

Replace text-based "skip"/"пропустить" with inline keyboard buttons on optional steps:

- Duration step: inline button `[Пропустить / Skip]` + text input accepted
- Description step: inline button `[Пропустить / Skip]` + text input accepted
- Location step: inline button `[Пропустить / Skip]` + text input accepted
- Recurrence step: `[Не повторять / Don't repeat]` serves as skip

Each optional step sends an inline keyboard along with the prompt message. The step handler must handle both:

- `callback_query` with skip callback data → set field to null, advance
- `message` with text → parse and set field, advance

**Skip callback data format:** `as:skip:{stepIndex}` — e.g. `as:skip:2` for duration step.

### 2.9 Display

Event detail card: show recurrence line using `formatRecurrenceHuman()` from `formatters.ts`. Extend `formatRecurrenceHuman()` to also parse and display UNTIL and COUNT from the RRULE string:

- `FREQ=WEEKLY` → "Every week"
- `FREQ=WEEKLY;COUNT=10` → "Every week, 10 times"
- `FREQ=DAILY;UNTIL=20260330T000000Z` → "Every day until Mar 30"
- `FREQ=WEEKLY;INTERVAL=2` → "Every 2 weeks"

### 2.10 Updated `recurringEditKeyboard`

Reduced to two buttons. Callback data includes templateId and occurrenceDate:

```
[Только это / This only]
[Все будущие / All future]
```

### 2.11 New CB Constants

```typescript
export const CB = {
  // ... existing ...
  RECURRENCE_DELETE: 'erd',  // delete scope for recurring
  ADD_RECURRENCE: 'ar',      // recurrence selection in add scene
  ADD_REC_END: 'are',        // recurrence end selection in add scene
  ADD_SKIP: 'ask',           // skip button in add scene
} as const;
```

---

## Feature 3: Holidays (Spec 08, Phase A Scope)

### 3.1 What's Included

- `date-holidays` npm package (offline, 199 countries)
- 4 SQLite tables: `holiday_countries`, `holidays`, `holiday_subscriptions`, `holiday_overrides`
- Migration 004
- `HolidayRepository` — CRUD for all 4 tables
- `HolidayService` — compute holidays via `date-holidays`, cache in SQLite, manage subscriptions
- `/holidays` command — add country (region → country picker), manage subscriptions, list upcoming
- Agenda integration: `/today`, `/week` show holidays in text
- `/free` integration: primary country public/bank holidays = days off (skip in free slot calculation)
- User overrides: mark holiday as working day, or mark regular day as day off
- Holiday cache refresh: on startup (current + next year), on-demand when user subscribes to new country

### 3.2 What's Excluded (Phase B+ Dependencies)

- Evening "tomorrow is a holiday" notifications (needs notification system, spec 04)
- AI agent context injection (needs AI agent, spec 02)
- Agenda image holiday badges (needs image generation, spec 05)
- BullMQ annual refresh job (no BullMQ yet — manual refresh or on-startup refresh)

### 3.3 Schema

4 tables as defined in spec 08 section 2: `holiday_countries`, `holidays`, `holiday_subscriptions`, `holiday_overrides`. No changes from spec.

### 3.4 `/holidays` Command

Pure callback-driven flow (no scene needed — all interactions via inline keyboard):

- Main menu with subscription list
- Add country: region → country picker (paginated, 8 per page)
- Manage: set primary, toggle notifications (stored but not delivered until Phase B), remove
- `/holidays list`: upcoming holidays across subscribed countries

**CB constants:** Use `hl` prefix. Examples: `hl:menu`, `hl:add`, `hl:add:Europe`, `hl:sub:TR`, `hl:manage`, `hl:manage:TR`, `hl:primary:TR`, `hl:notify:TR`, `hl:remove:TR`, `hl:list`, `hl:page:2`.

**Region → country mapping:** Derive from `date-holidays` library's country list. Group by continent using a hardcoded continent map (similar to `TZ_REGIONS` in constants.ts). Countries sorted alphabetically within region.

### 3.5 Calendar Integration

- `formatDayAgenda()` accepts optional `holidays: HolidayEntry[]` param, prepends holiday lines to agenda text
- `formatWeekAgenda()` accepts optional holidays, annotates holiday days
- `/free` command handler checks `HolidayService.isDayOff(userId, date)` **before** calling `getFreeSlots()`. If day off → skip the day entirely, don't call `getFreeSlots` for it. This keeps `EventService` and `HolidayService` decoupled.
- `isDayOff(userId, date)` checks: user override first (explicit wins) → primary country public/bank holiday → false

**Service wiring:** `HolidayService` is a standalone service injected into command handlers alongside `EventService`. No direct dependency between EventService and HolidayService — the command handler orchestrates.

### 3.6 Interfaces

As defined in spec 08 section 8. `IHolidayService` with data, subscription, and scheduling methods.

### 3.7 New i18n Message Keys

Add to `MSG.en` / `MSG.ru`:

- `holidays_menu`, `holidays_add`, `holidays_added`, `holidays_removed`
- `holidays_set_primary`, `holidays_no_subs`, `holidays_upcoming`
- `holidays_none_upcoming`, `holidays_day_off`
- Recurrence prompts: `recurrence_prompt`, `recurrence_end_prompt`, `recurrence_custom_prompt`
- Skip button labels (reuse existing skip/пропустить pattern)

---

## Implementation Order

1. **Multilingual parser** — smallest scope, no dependencies, unblocks better UX for everything after
2. **Recurring events UI** — depends on working parsers for recurrence end date input
3. **Holidays** — independent but benefits from the improved parsers for override date input

---

## Testing

All three features follow TDD:

- Parser extensions: unit tests for every new format
- Recurring events: unit tests for `parseRecurrence()`, integration tests for create/edit/delete flows
- Holidays: unit tests for `HolidayService`, integration tests for `/holidays` command flow
