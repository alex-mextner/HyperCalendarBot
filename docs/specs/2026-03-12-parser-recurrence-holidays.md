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

**Implementation:** Replace single-char suffix regex `[hч]` / `[mм]` with alternation groups covering all word forms. Keep colon and plain-number formats as-is.

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
- Add `послезавтра` / `day after tomorrow` branch (analogous to `завтра` / `tomorrow`, with `addDays(ref, 2)`).
- Extend `months` record with full Russian forms and declensions.

### 1.3 Tests

Every new format gets a test case. Extend existing `test/utils/date.test.ts` with new patterns.

---

## Feature 2: Recurring Events UI

### 2.1 Creation — New Steps in add-event Scene

After the duration step, add two conditional steps:

**Step "Recurrence"** — inline keyboard:

```
[Не повторять / Don't repeat]
[Каждый день / Daily]  [Каждую неделю / Weekly]
[Каждый месяц / Monthly]  [Каждый год / Yearly]
[Другое... / Custom...]
```

If "Custom..." selected → text input parsed by `parseRecurrence()`.

**Step "Recurrence End"** — shown only if recurrence selected, inline keyboard:

```
[Бесконечно / No end]
[До даты / Until date]
[N повторений / N times]
```

- "Until date" → text input, parsed by `parseSimpleDate()`
- "N times" → text input, numeric → `COUNT` in RRULE

Result: RRULE string (e.g. `FREQ=WEEKLY;INTERVAL=2;COUNT=10`) passed to `createEvent()`.

### 2.2 Recurrence Text Parser

New function `parseRecurrence(input: string): RecurrenceParsed | null`

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
| `каждые 2 недели`, `every 2 weeks` | WEEKLY, interval 2 |
| `каждые 3 дня`, `every 3 days` | DAILY, interval 3 |
| `каждые 2 месяца`, `every 2 months` | MONTHLY, interval 2 |

### 2.3 Editing Recurring Events — Scope Selection

When user taps "Edit" or "Delete" on a recurring event occurrence, show scope keyboard (Apple Calendar style — two options only):

```
[Только это / This only]
[Все будущие / All future]
```

**Edit — "This only":**
Create exception record: child event with `parent_event_id` + `original_start_at`, modified fields applied to the child.

**Edit — "All future":**
1. Set `UNTIL` on original template's RRULE (date before current occurrence).
2. Create new template event with updated fields, starting from current occurrence date.
3. Existing exceptions before the split date stay with original template.
4. Existing exceptions on/after the split date get re-parented to new template.

**Delete — "This only":**
`cancelOccurrence()` — creates cancelled exception (already implemented in EventService).

**Delete — "All future":**
1. Set `UNTIL` on original template (date before current occurrence).
2. Delete all exceptions with `original_start_at` >= current occurrence date.

### 2.4 Skip Buttons in Scenes

Replace text-based "skip"/"пропустить" with inline keyboard buttons on optional steps:

- Duration step: inline button `[Пропустить / Skip]` + text input accepted
- Description step: inline button `[Пропустить / Skip]` + text input accepted
- Location step: inline button `[Пропустить / Skip]` + text input accepted
- Recurrence step: `[Не повторять / Don't repeat]` serves as skip

Scene must handle both callback query (button press) and text message on these steps.

### 2.5 Display

Event detail card: add recurrence line using existing `formatRecurrenceHuman()` from `formatters.ts`. Show end condition if present ("until Mar 30" / "10 times").

### 2.6 Remove "All occurrences" option

`recurringEditKeyboard` in `keyboards.ts` reduced to two buttons: "This only" and "All future". No "All occurrences" — past events don't change.

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

As defined in spec 08 section 3:
- Main menu with subscription list
- Add country: region → country picker (paginated)
- Manage: set primary, toggle notifications (stored but not delivered until Phase B), remove
- `/holidays list`: upcoming holidays across subscribed countries

### 3.5 Calendar Integration

- `formatDayAgenda()` queries holidays for the date, prepends to agenda text
- `formatWeekAgenda()` annotates holiday days
- `getFreeSlots()` calls `HolidayService.isDayOff()` to skip primary country holidays
- `isDayOff(userId, date)` checks: user override → primary country public/bank holiday → false

### 3.6 Interfaces

As defined in spec 08 section 8. `IHolidayService` with data, subscription, and scheduling methods.

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
