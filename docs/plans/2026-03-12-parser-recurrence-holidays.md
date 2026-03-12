# Parser Extensions + Recurring Events UI + Holidays Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Phase A with multilingual parser support, recurring event creation/editing UI, and holiday subscriptions.

**Architecture:** Three features built in dependency order: (1) parser extensions add full-word RU/EN duration and date formats, (2) recurring events UI adds scene steps for recurrence creation, scope-based edit/delete with `editOccurrence`/`splitRecurrence`/`deleteFuture` service methods, (3) holidays add `date-holidays` integration with SQLite cache, subscription management, and agenda/free-slot integration.

**Tech Stack:** Bun, GramIO, @gramio/scenes, bun:sqlite, rrule, date-holidays, date-fns, @date-fns/tz

---

## Chunk 1: Multilingual Parser Extensions

### Task 1: Extend `parseDuration` with full-word suffixes

**Files:**
- Modify: `test/utils/date.test.ts`
- Modify: `src/utils/date.ts:194-220` (`parseDuration`)

- [ ] **Step 1: Write failing tests for full-word EN/RU duration formats**

Add to `test/utils/date.test.ts` inside the `parseDuration` describe block:

```typescript
// Full-word English suffixes
test('parses "1 hour"', () => expect(parseDuration('1 hour')).toBe(60));
test('parses "2 hours"', () => expect(parseDuration('2 hours')).toBe(120));
test('parses "1 hr"', () => expect(parseDuration('1 hr')).toBe(60));
test('parses "30 minutes"', () => expect(parseDuration('30 minutes')).toBe(30));
test('parses "45 minute"', () => expect(parseDuration('45 minute')).toBe(45));
test('parses "15 min"', () => expect(parseDuration('15 min')).toBe(15));
test('parses "2 hours 15 min"', () => expect(parseDuration('2 hours 15 min')).toBe(135));
test('parses "1hr 30min"', () => expect(parseDuration('1hr 30min')).toBe(90));

// Full-word Russian suffixes
test('parses "1 час"', () => expect(parseDuration('1 час')).toBe(60));
test('parses "2 часа"', () => expect(parseDuration('2 часа')).toBe(120));
test('parses "5 часов"', () => expect(parseDuration('5 часов')).toBe(300));
test('parses "30 минут"', () => expect(parseDuration('30 минут')).toBe(30));
test('parses "45 минуты"', () => expect(parseDuration('45 минуты')).toBe(45));
test('parses "15 мин"', () => expect(parseDuration('15 мин')).toBe(15));
test('parses "1 минута"', () => expect(parseDuration('1 минута')).toBe(1));
test('parses "1 час 30 минут"', () => expect(parseDuration('1 час 30 минут')).toBe(90));
test('parses "2 часа 15 мин"', () => expect(parseDuration('2 часа 15 мин')).toBe(135));
test('parses "12 часов"', () => expect(parseDuration('12 часов')).toBe(720));

// Special forms
test('parses "полчаса"', () => expect(parseDuration('полчаса')).toBe(30));
test('parses "полтора часа"', () => expect(parseDuration('полтора часа')).toBe(90));
test('parses "half an hour"', () => expect(parseDuration('half an hour')).toBe(30));
test('parses "half hour"', () => expect(parseDuration('half hour')).toBe(30));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/utils/date.test.ts`
Expected: ~22 new tests FAIL (return `null` instead of expected values)

- [ ] **Step 3: Implement extended parseDuration**

Replace the `parseDuration` function in `src/utils/date.ts`:

```typescript
export function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();

  // Special forms (check before regex)
  if (trimmed === 'полчаса' || trimmed === 'half an hour' || trimmed === 'half hour') return 30;
  if (trimmed === 'полтора часа') return 90;

  // Colon format: "1:30", "0:45", "10:30"
  const colonMatch = trimmed.match(/^(\d+):(\d{2})$/);
  if (colonMatch) {
    const total = Number(colonMatch[1]) * 60 + Number(colonMatch[2]);
    return total > 0 ? total : null;
  }

  // Suffix format with full-word support
  const hourPattern = '(?:hours?|hr|час(?:а|ов)?|[hч])';
  const minPattern = '(?:minutes?|min|минут[аыу]?|мин|[mм])';
  const suffixRegex = new RegExp(
    `^(?:(\\d+)\\s*${hourPattern})?\\s*(?:(\\d+)\\s*${minPattern})?$`,
  );
  const suffixMatch = trimmed.match(suffixRegex);
  if (suffixMatch && (suffixMatch[1] || suffixMatch[2])) {
    const hours = suffixMatch[1] ? Number(suffixMatch[1]) : 0;
    const mins = suffixMatch[2] ? Number(suffixMatch[2]) : 0;
    return hours * 60 + mins || null;
  }

  // Plain number: treat as minutes
  const plainMatch = trimmed.match(/^(\d+)$/);
  if (plainMatch) {
    const mins = Number(plainMatch[1]);
    return mins > 0 ? mins : null;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/utils/date.test.ts`
Expected: ALL tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/date.ts test/utils/date.test.ts
git commit -m "feat: extend parseDuration with full-word EN/RU suffixes and special forms"
```

---

### Task 2: Extend `parseSimpleDate` with full RU weekdays, "послезавтра", and full RU months

**Files:**
- Modify: `test/utils/date.test.ts`
- Modify: `src/utils/date.ts:56-182` (`parseSimpleDate`)

- [ ] **Step 1: Write failing tests for new date patterns**

Add to `test/utils/date.test.ts` inside the `parseSimpleDate` describe block:

```typescript
// Full Russian weekdays
test('parses "понедельник 10:00"', () => {
  const ref = new Date('2026-03-11T12:00:00Z'); // Wednesday
  const result = parseSimpleDate('понедельник 10:00', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-03-16T10:00');
});

test('parses "пятница 18:00"', () => {
  const ref = new Date('2026-03-11T12:00:00Z'); // Wednesday
  const result = parseSimpleDate('пятница 18:00', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-03-13T18:00');
});

test('parses "среда 9:00"', () => {
  const ref = new Date('2026-03-11T12:00:00Z'); // Wednesday → next Wednesday
  const result = parseSimpleDate('среда 9:00', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-03-18T09:00');
});

// "Day after tomorrow"
test('parses "послезавтра 15:00"', () => {
  const ref = new Date('2026-03-11T12:00:00Z');
  const result = parseSimpleDate('послезавтра 15:00', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-03-13T15:00');
});

test('parses "day after tomorrow 10:00"', () => {
  const ref = new Date('2026-03-11T12:00:00Z');
  const result = parseSimpleDate('day after tomorrow 10:00', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-03-13T10:00');
});

test('parses "послезавтра" without time (defaults to 00:00)', () => {
  const ref = new Date('2026-03-11T12:00:00Z');
  const result = parseSimpleDate('послезавтра', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-03-13T00:00');
});

test('parses "day after tomorrow" without time (defaults to 00:00)', () => {
  const ref = new Date('2026-03-11T12:00:00Z');
  const result = parseSimpleDate('day after tomorrow', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-03-13T00:00');
});

// Full Russian months
test('parses "15 января 19:30"', () => {
  const ref = new Date('2026-03-11T12:00:00Z');
  const result = parseSimpleDate('15 января 19:30', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-01-15T19:30');
});

test('parses "1 февраля 10:00"', () => {
  const ref = new Date('2026-03-11T12:00:00Z');
  const result = parseSimpleDate('1 февраля 10:00', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-02-01T10:00');
});

test('parses "25 декабря"', () => {
  const ref = new Date('2026-03-11T12:00:00Z');
  const result = parseSimpleDate('25 декабря', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-12-25T00:00');
});

test('parses "март 20 14:00" (nominative month name)', () => {
  const ref = new Date('2026-03-11T12:00:00Z');
  const result = parseSimpleDate('март 20 14:00', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-03-20T14:00');
});

// "tomorrow" without time
test('parses "tomorrow" without time (defaults to 00:00)', () => {
  const ref = new Date('2026-03-11T12:00:00Z');
  const result = parseSimpleDate('tomorrow', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-03-12T00:00');
});

test('parses "завтра" without time (defaults to 00:00)', () => {
  const ref = new Date('2026-03-11T12:00:00Z');
  const result = parseSimpleDate('завтра', 'UTC', ref);
  expect(result).not.toBeNull();
  expect(result!.toISOString()).toContain('2026-03-12T00:00');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/utils/date.test.ts`
Expected: New tests FAIL

- [ ] **Step 3: Implement extended parseSimpleDate**

In `src/utils/date.ts`, modify `parseSimpleDate`:

1. Add `послезавтра` / `day after tomorrow` branch right after the `tomorrowMatch` block (line ~83):

```typescript
  // "послезавтра" / "day after tomorrow" — with optional time
  const dayAfterMatch = trimmed.match(
    /^(послезавтра|day after tomorrow)(?:\s+(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?)?$/,
  );
  if (dayAfterMatch) {
    const [, , h, m] = dayAfterMatch;
    const d = startOfDay(addDays(ref, 2));
    const result = addMinutes(d, Number(h ?? 0) * 60 + Number(m ?? 0));
    return new Date(result.toISOString());
  }
```

2. Make `tomorrowMatch` also accept time-less input by changing its regex:

```typescript
  const tomorrowMatch = trimmed.match(
    /^(tomorrow|завтра)(?:\s+(?:(?:at|в)\s+)?(\d{1,2})(?::(\d{2}))?)?$/,
  );
  if (tomorrowMatch) {
    const [, , h, m] = tomorrowMatch;
    const d = startOfDay(addDays(ref, 1));
    const result = addMinutes(d, Number(h ?? 0) * 60 + Number(m ?? 0));
    return new Date(result.toISOString());
  }
```

3. Add full Russian weekday names to `dayNames` (after `вс: 0`):

```typescript
    понедельник: 1,
    вторник: 2,
    среда: 3,
    четверг: 4,
    пятница: 5,
    суббота: 6,
    воскресенье: 0,
```

4. Add full Russian month names (nominative + genitive) to the `months` record inside `monthDateMatch`:

```typescript
      // Full Russian — nominative
      январь: 0, февраль: 1, март: 2, апрель: 3, май: 4, июнь: 5,
      июль: 6, август: 7, сентябрь: 8, октябрь: 9, ноябрь: 10, декабрь: 11,
      // Full Russian — genitive
      января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5,
      июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/utils/date.test.ts`
Expected: ALL tests PASS

- [ ] **Step 5: Lint and commit**

```bash
bun run lint:fix
git add src/utils/date.ts test/utils/date.test.ts
git commit -m "feat: extend parseSimpleDate with full RU weekdays, day-after-tomorrow, full RU months"
```

---

## Chunk 2: Recurrence Parser & Formatter

### Task 3: Create `parseRecurrence` function

**Files:**
- Create: `test/utils/recurrence.test.ts`
- Modify: `src/utils/date.ts` (add `parseRecurrence` + `RecurrenceParsed` interface)

- [ ] **Step 1: Write failing tests for parseRecurrence**

Create `test/utils/recurrence.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { parseRecurrence } from '../../src/utils/date.ts';

describe('parseRecurrence', () => {
  // Daily
  test('parses "daily"', () => {
    expect(parseRecurrence('daily')).toEqual({ freq: 'DAILY', interval: 1 });
  });
  test('parses "every day"', () => {
    expect(parseRecurrence('every day')).toEqual({ freq: 'DAILY', interval: 1 });
  });
  test('parses "каждый день"', () => {
    expect(parseRecurrence('каждый день')).toEqual({ freq: 'DAILY', interval: 1 });
  });
  test('parses "ежедневно"', () => {
    expect(parseRecurrence('ежедневно')).toEqual({ freq: 'DAILY', interval: 1 });
  });

  // Weekly
  test('parses "weekly"', () => {
    expect(parseRecurrence('weekly')).toEqual({ freq: 'WEEKLY', interval: 1 });
  });
  test('parses "every week"', () => {
    expect(parseRecurrence('every week')).toEqual({ freq: 'WEEKLY', interval: 1 });
  });
  test('parses "каждую неделю"', () => {
    expect(parseRecurrence('каждую неделю')).toEqual({ freq: 'WEEKLY', interval: 1 });
  });
  test('parses "еженедельно"', () => {
    expect(parseRecurrence('еженедельно')).toEqual({ freq: 'WEEKLY', interval: 1 });
  });

  // Monthly
  test('parses "monthly"', () => {
    expect(parseRecurrence('monthly')).toEqual({ freq: 'MONTHLY', interval: 1 });
  });
  test('parses "every month"', () => {
    expect(parseRecurrence('every month')).toEqual({ freq: 'MONTHLY', interval: 1 });
  });
  test('parses "каждый месяц"', () => {
    expect(parseRecurrence('каждый месяц')).toEqual({ freq: 'MONTHLY', interval: 1 });
  });
  test('parses "ежемесячно"', () => {
    expect(parseRecurrence('ежемесячно')).toEqual({ freq: 'MONTHLY', interval: 1 });
  });

  // Yearly
  test('parses "yearly"', () => {
    expect(parseRecurrence('yearly')).toEqual({ freq: 'YEARLY', interval: 1 });
  });
  test('parses "every year"', () => {
    expect(parseRecurrence('every year')).toEqual({ freq: 'YEARLY', interval: 1 });
  });
  test('parses "каждый год"', () => {
    expect(parseRecurrence('каждый год')).toEqual({ freq: 'YEARLY', interval: 1 });
  });
  test('parses "ежегодно"', () => {
    expect(parseRecurrence('ежегодно')).toEqual({ freq: 'YEARLY', interval: 1 });
  });

  // With interval
  test('parses "every 2 weeks"', () => {
    expect(parseRecurrence('every 2 weeks')).toEqual({ freq: 'WEEKLY', interval: 2 });
  });
  test('parses "каждые 2 недели"', () => {
    expect(parseRecurrence('каждые 2 недели')).toEqual({ freq: 'WEEKLY', interval: 2 });
  });
  test('parses "через неделю"', () => {
    expect(parseRecurrence('через неделю')).toEqual({ freq: 'WEEKLY', interval: 2 });
  });
  test('parses "every 3 days"', () => {
    expect(parseRecurrence('every 3 days')).toEqual({ freq: 'DAILY', interval: 3 });
  });
  test('parses "каждые 3 дня"', () => {
    expect(parseRecurrence('каждые 3 дня')).toEqual({ freq: 'DAILY', interval: 3 });
  });
  test('parses "every 2 months"', () => {
    expect(parseRecurrence('every 2 months')).toEqual({ freq: 'MONTHLY', interval: 2 });
  });
  test('parses "каждые 2 месяца"', () => {
    expect(parseRecurrence('каждые 2 месяца')).toEqual({ freq: 'MONTHLY', interval: 2 });
  });

  // Invalid
  test('returns null for empty', () => {
    expect(parseRecurrence('')).toBeNull();
  });
  test('returns null for gibberish', () => {
    expect(parseRecurrence('asdfgh')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/utils/recurrence.test.ts`
Expected: FAIL — `parseRecurrence` does not exist

- [ ] **Step 3: Implement parseRecurrence**

Add to `src/utils/date.ts`:

```typescript
export interface RecurrenceParsed {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
}

export function parseRecurrence(input: string): RecurrenceParsed | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // Simple keywords
  const simple: Record<string, RecurrenceParsed> = {
    'daily': { freq: 'DAILY', interval: 1 },
    'every day': { freq: 'DAILY', interval: 1 },
    'каждый день': { freq: 'DAILY', interval: 1 },
    'ежедневно': { freq: 'DAILY', interval: 1 },
    'weekly': { freq: 'WEEKLY', interval: 1 },
    'every week': { freq: 'WEEKLY', interval: 1 },
    'каждую неделю': { freq: 'WEEKLY', interval: 1 },
    'еженедельно': { freq: 'WEEKLY', interval: 1 },
    'monthly': { freq: 'MONTHLY', interval: 1 },
    'every month': { freq: 'MONTHLY', interval: 1 },
    'каждый месяц': { freq: 'MONTHLY', interval: 1 },
    'ежемесячно': { freq: 'MONTHLY', interval: 1 },
    'yearly': { freq: 'YEARLY', interval: 1 },
    'every year': { freq: 'YEARLY', interval: 1 },
    'каждый год': { freq: 'YEARLY', interval: 1 },
    'ежегодно': { freq: 'YEARLY', interval: 1 },
    'через неделю': { freq: 'WEEKLY', interval: 2 },
  };

  if (simple[trimmed]) return simple[trimmed];

  // "every N <unit>" pattern
  const everyN = trimmed.match(/^every\s+(\d+)\s+(days?|weeks?|months?|years?)$/);
  if (everyN) {
    const n = Number(everyN[1]);
    const unit = everyN[2]!;
    if (unit.startsWith('day')) return { freq: 'DAILY', interval: n };
    if (unit.startsWith('week')) return { freq: 'WEEKLY', interval: n };
    if (unit.startsWith('month')) return { freq: 'MONTHLY', interval: n };
    if (unit.startsWith('year')) return { freq: 'YEARLY', interval: n };
  }

  // "каждые N <unit>" pattern
  const kazhdyeN = trimmed.match(
    /^кажд(?:ый|ую|ые|ое)\s+(\d+)\s+(дн(?:я|ей|и)|день|недел[юиь]|месяц(?:а|ев)?|год[аов]?)$/,
  );
  if (kazhdyeN) {
    const n = Number(kazhdyeN[1]);
    const unit = kazhdyeN[2]!;
    if (unit.startsWith('дн') || unit === 'день') return { freq: 'DAILY', interval: n };
    if (unit.startsWith('недел')) return { freq: 'WEEKLY', interval: n };
    if (unit.startsWith('месяц')) return { freq: 'MONTHLY', interval: n };
    if (unit.startsWith('год')) return { freq: 'YEARLY', interval: n };
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/utils/recurrence.test.ts`
Expected: ALL tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/date.ts test/utils/recurrence.test.ts
git commit -m "feat: add parseRecurrence for bilingual recurring event text input"
```

---

### Task 4: Extend `formatRecurrenceHuman` with INTERVAL, UNTIL, and COUNT

**Files:**
- Modify: `test/services/event/formatters.test.ts`
- Modify: `src/services/event/formatters.ts:110-116` (`formatRecurrenceHuman`)

- [ ] **Step 1: Write failing tests**

Add to `test/services/event/formatters.test.ts`:

```typescript
import { formatRecurrenceHuman } from '../../../src/services/event/formatters.ts';
```

Then add a new describe block:

```typescript
describe('formatRecurrenceHuman', () => {
  test('FREQ=DAILY → "Daily"', () => {
    expect(formatRecurrenceHuman('FREQ=DAILY', 'en')).toBe('Daily');
  });
  test('FREQ=WEEKLY → "Еженедельно"', () => {
    expect(formatRecurrenceHuman('FREQ=WEEKLY', 'ru')).toBe('Еженедельно');
  });
  test('FREQ=WEEKLY;INTERVAL=2 → "Every 2 weeks"', () => {
    expect(formatRecurrenceHuman('FREQ=WEEKLY;INTERVAL=2', 'en')).toBe('Every 2 weeks');
  });
  test('FREQ=DAILY;INTERVAL=3 → "Каждые 3 дня"', () => {
    expect(formatRecurrenceHuman('FREQ=DAILY;INTERVAL=3', 'ru')).toBe('Каждые 3 дня');
  });
  test('FREQ=WEEKLY;COUNT=10 → "Weekly, 10 times"', () => {
    expect(formatRecurrenceHuman('FREQ=WEEKLY;COUNT=10', 'en')).toBe('Weekly, 10 times');
  });
  test('FREQ=DAILY;UNTIL=20260330T000000Z → "Daily until Mar 30"', () => {
    expect(formatRecurrenceHuman('FREQ=DAILY;UNTIL=20260330T000000Z', 'en')).toBe('Daily until Mar 30');
  });
  test('FREQ=MONTHLY;COUNT=5 → "Ежемесячно, 5 раз"', () => {
    expect(formatRecurrenceHuman('FREQ=MONTHLY;COUNT=5', 'ru')).toBe('Ежемесячно, 5 раз');
  });
  test('FREQ=DAILY;UNTIL=20260330T000000Z in RU → "Ежедневно до 30 мар"', () => {
    expect(formatRecurrenceHuman('FREQ=DAILY;UNTIL=20260330T000000Z', 'ru')).toBe('Ежедневно до 30 мар');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/services/event/formatters.test.ts`
Expected: Tests fail — current `formatRecurrenceHuman` is not exported and doesn't handle INTERVAL/COUNT/UNTIL

- [ ] **Step 3: Implement extended formatRecurrenceHuman**

In `src/services/event/formatters.ts`, export the function and rewrite it:

```typescript
export function formatRecurrenceHuman(rrule: string, lang: string): string {
  const parts = new Map(
    rrule.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k!, v!] as [string, string];
    }),
  );

  const freq = parts.get('FREQ');
  const interval = Number(parts.get('INTERVAL') ?? 1);
  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');

  let base: string;

  if (interval > 1) {
    const unitMap: Record<string, Record<string, string>> = {
      DAILY: { en: 'days', ru: ruPlural(interval, 'день', 'дня', 'дней') },
      WEEKLY: { en: 'weeks', ru: ruPlural(interval, 'неделю', 'недели', 'недель') },
      MONTHLY: { en: 'months', ru: ruPlural(interval, 'месяц', 'месяца', 'месяцев') },
      YEARLY: { en: 'years', ru: ruPlural(interval, 'год', 'года', 'лет') },
    };
    const unit = unitMap[freq!]?.[lang] ?? freq;
    base = lang === 'ru' ? `Каждые ${interval} ${unit}` : `Every ${interval} ${unit}`;
  } else {
    const freqMap: Record<string, Record<string, string>> = {
      DAILY: { en: 'Daily', ru: 'Ежедневно' },
      WEEKLY: { en: 'Weekly', ru: 'Еженедельно' },
      MONTHLY: { en: 'Monthly', ru: 'Ежемесячно' },
      YEARLY: { en: 'Yearly', ru: 'Ежегодно' },
    };
    base = freqMap[freq!]?.[lang] ?? rrule;
  }

  if (count) {
    base += lang === 'ru' ? `, ${count} раз` : `, ${count} times`;
  }

  if (until) {
    const untilDate = parseUntilDate(until);
    if (untilDate) {
      const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthsRu = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
      const day = untilDate.getUTCDate();
      const mon = lang === 'ru' ? monthsRu[untilDate.getUTCMonth()]! : monthsEn[untilDate.getUTCMonth()]!;
      base += lang === 'ru' ? ` до ${day} ${mon}` : ` until ${mon} ${day}`;
    }
  }

  return base;
}

function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 19) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function parseUntilDate(until: string): Date | null {
  // Format: 20260330T000000Z or 20260330
  const match = until.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/services/event/formatters.test.ts`
Expected: ALL tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/event/formatters.ts test/services/event/formatters.test.ts
git commit -m "feat: extend formatRecurrenceHuman with INTERVAL, COUNT, and UNTIL display"
```

---

## Chunk 3: Repository & Service Methods for Recurring Edit/Delete

### Task 5: Add new EventRepository methods

**Files:**
- Modify: `test/database/repositories/event.repository.test.ts`
- Modify: `src/database/repositories/event.repository.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/database/repositories/event.repository.test.ts`.

**Important:** The existing test file uses `events` (not `eventRepo`) as the `EventRepository` variable, and `db` for the `Database` instance. Add `import type { CalendarEvent } from '../../../src/database/types.ts'` to the imports.

```typescript
describe('recurring event helpers', () => {
  test('getExceptionsFrom returns exceptions on or after date', () => {
    const template = events.create({
      user_id: USER_ID,
      title: 'Weekly',
      start_at: '2026-03-01T10:00:00Z',
      timezone: 'UTC',
      recurrence_rule: 'FREQ=WEEKLY',
    });
    // Create exceptions at different dates
    events.createException(template.id, {
      user_id: USER_ID, title: 'Moved', start_at: '2026-03-08T11:00:00Z',
      timezone: 'UTC', original_start_at: '2026-03-08T10:00:00Z',
    });
    events.createException(template.id, {
      user_id: USER_ID, title: 'Moved2', start_at: '2026-03-15T11:00:00Z',
      timezone: 'UTC', original_start_at: '2026-03-15T10:00:00Z',
    });

    const from = events.getExceptionsFrom(template.id, '2026-03-15T00:00:00Z');
    expect(from.length).toBe(1);
    expect(from[0]!.title).toBe('Moved2');
  });

  test('reparentExceptions moves exceptions to new template', () => {
    const old = events.create({
      user_id: USER_ID, title: 'Old', start_at: '2026-03-01T10:00:00Z',
      timezone: 'UTC', recurrence_rule: 'FREQ=WEEKLY',
    });
    const exc = events.createException(old.id, {
      user_id: USER_ID, title: 'Exc', start_at: '2026-03-15T11:00:00Z',
      timezone: 'UTC', original_start_at: '2026-03-15T10:00:00Z',
    });
    const newTemplate = events.create({
      user_id: USER_ID, title: 'New', start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC', recurrence_rule: 'FREQ=WEEKLY',
    });

    events.reparentExceptions(old.id, newTemplate.id, '2026-03-15T00:00:00Z');

    const moved = db.prepare('SELECT * FROM events WHERE id = ?').get(exc.id) as CalendarEvent;
    expect(moved.parent_event_id).toBe(newTemplate.id);
  });

  test('deleteExceptionsFrom removes exceptions on or after date', () => {
    const template = events.create({
      user_id: USER_ID, title: 'Weekly', start_at: '2026-03-01T10:00:00Z',
      timezone: 'UTC', recurrence_rule: 'FREQ=WEEKLY',
    });
    events.createException(template.id, {
      user_id: USER_ID, title: 'E1', start_at: '2026-03-08T10:00:00Z',
      timezone: 'UTC', original_start_at: '2026-03-08T10:00:00Z', is_cancelled: true,
    });
    events.createException(template.id, {
      user_id: USER_ID, title: 'E2', start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC', original_start_at: '2026-03-15T10:00:00Z', is_cancelled: true,
    });

    events.deleteExceptionsFrom(template.id, '2026-03-15T00:00:00Z');

    const remaining = events.getExceptions(template.id);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.title).toBe('E1');
  });

  test('setRecurrenceUntil appends UNTIL to rrule', () => {
    const template = events.create({
      user_id: USER_ID, title: 'Weekly', start_at: '2026-03-01T10:00:00Z',
      timezone: 'UTC', recurrence_rule: 'FREQ=WEEKLY',
    });

    events.setRecurrenceUntil(template.id, '2026-03-14T00:00:00Z');

    const updated = events.findById(template.id, USER_ID);
    expect(updated!.recurrence_rule).toBe('FREQ=WEEKLY;UNTIL=20260314T000000Z');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/database/repositories/event.repository.test.ts`
Expected: FAIL — methods don't exist

- [ ] **Step 3: Implement new repository methods**

Add to `src/database/repositories/event.repository.ts`:

```typescript
  getExceptionsFrom(parentEventId: number, fromDate: string): CalendarEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE parent_event_id = ? AND original_start_at >= ?')
      .all(parentEventId, fromDate) as CalendarEvent[];
  }

  reparentExceptions(oldTemplateId: number, newTemplateId: number, fromDate: string): void {
    this.db
      .prepare('UPDATE events SET parent_event_id = ? WHERE parent_event_id = ? AND original_start_at >= ?')
      .run(newTemplateId, oldTemplateId, fromDate);
  }

  deleteExceptionsFrom(parentEventId: number, fromDate: string): void {
    this.db
      .prepare('DELETE FROM events WHERE parent_event_id = ? AND original_start_at >= ?')
      .run(parentEventId, fromDate);
  }

  setRecurrenceUntil(eventId: number, untilDate: string): void {
    const untilStr = untilDate.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const event = this.db.prepare('SELECT recurrence_rule FROM events WHERE id = ?').get(eventId) as {
      recurrence_rule: string;
    } | null;
    if (!event?.recurrence_rule) return;

    // Remove existing UNTIL if present
    const baseRule = event.recurrence_rule
      .split(';')
      .filter((p) => !p.startsWith('UNTIL='))
      .join(';');
    const newRule = `${baseRule};UNTIL=${untilStr}`;

    this.db
      .prepare("UPDATE events SET recurrence_rule = ?, updated_at = datetime('now') WHERE id = ?")
      .run(newRule, eventId);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/database/repositories/event.repository.test.ts`
Expected: ALL tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/event.repository.ts test/database/repositories/event.repository.test.ts
git commit -m "feat: add recurring event repository methods (getExceptionsFrom, reparent, delete, setUntil)"
```

---

### Task 6: Add new EventService methods (`editOccurrence`, `splitRecurrence`, `deleteFuture`)

**Files:**
- Modify: `test/services/event/event-service.test.ts`
- Modify: `src/services/event/event-service.ts`

- [ ] **Step 1: Write failing tests**

Add to `test/services/event/event-service.test.ts`:

```typescript
describe('recurring event operations', () => {
  test('editOccurrence creates exception from template', () => {
    const template = service.createEvent({
      user_id: USER_ID,
      title: 'Weekly Standup',
      start_at: '2026-03-01T10:00:00Z',
      end_at: '2026-03-01T11:00:00Z',
      timezone: TZ,
      recurrence_rule: 'FREQ=WEEKLY',
    });

    const exception = service.editOccurrence(template.id, '2026-03-08T10:00:00Z', USER_ID);
    expect(exception).not.toBeNull();
    expect(exception!.parent_event_id).toBe(template.id);
    expect(exception!.original_start_at).toBe('2026-03-08T10:00:00Z');
    expect(exception!.title).toBe('Weekly Standup');
  });

  test('splitRecurrence splits template into two series', () => {
    const template = service.createEvent({
      user_id: USER_ID,
      title: 'Weekly',
      start_at: '2026-03-01T10:00:00Z',
      timezone: TZ,
      recurrence_rule: 'FREQ=WEEKLY',
    });

    const newTemplate = service.splitRecurrence(template.id, '2026-03-15T10:00:00Z', USER_ID);
    expect(newTemplate).not.toBeNull();
    expect(newTemplate!.start_at).toBe('2026-03-15T10:00:00Z');
    expect(newTemplate!.recurrence_rule).toBe('FREQ=WEEKLY');

    // Original template now has UNTIL
    const original = service.getEvent(template.id, USER_ID);
    expect(original!.recurrence_rule).toContain('UNTIL=');
  });

  test('deleteFuture adds UNTIL and removes future exceptions', () => {
    const template = service.createEvent({
      user_id: USER_ID,
      title: 'Daily',
      start_at: '2026-03-01T10:00:00Z',
      timezone: TZ,
      recurrence_rule: 'FREQ=DAILY',
    });

    // Create a cancelled exception in the future
    service.cancelOccurrence(template.id, USER_ID, '2026-03-20T10:00:00Z');

    service.deleteFuture(template.id, '2026-03-15T10:00:00Z', USER_ID);

    const updated = service.getEvent(template.id, USER_ID);
    expect(updated!.recurrence_rule).toContain('UNTIL=');

    // Future exceptions should be deleted
    const exceptions = db.prepare('SELECT * FROM events WHERE parent_event_id = ?').all(template.id);
    expect(exceptions.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/services/event/event-service.test.ts`
Expected: FAIL — methods don't exist

- [ ] **Step 3: Implement new service methods**

Add to `src/services/event/event-service.ts`:

```typescript
  editOccurrence(templateId: number, occurrenceDate: string, userId: number): CalendarEvent | null {
    const template = this.eventRepo.findById(templateId, userId);
    if (!template || !template.recurrence_rule) return null;

    return this.eventRepo.createException(templateId, {
      user_id: userId,
      title: template.title,
      description: template.description ?? undefined,
      category: template.category ?? undefined,
      start_at: occurrenceDate,
      end_at: template.end_at
        ? new Date(
            new Date(occurrenceDate).getTime() +
              (new Date(template.end_at).getTime() - new Date(template.start_at).getTime()),
          ).toISOString()
        : undefined,
      timezone: template.timezone,
      location: template.location ?? undefined,
      original_start_at: occurrenceDate,
    });
  }

  splitRecurrence(templateId: number, occurrenceDate: string, userId: number): CalendarEvent | null {
    const template = this.eventRepo.findById(templateId, userId);
    if (!template || !template.recurrence_rule) return null;

    // 1. Set UNTIL on original template to day before occurrenceDate
    const dayBefore = new Date(new Date(occurrenceDate).getTime() - 86400000).toISOString();
    this.eventRepo.setRecurrenceUntil(templateId, dayBefore);

    // 2. Extract base FREQ/INTERVAL from original rule (without UNTIL/COUNT)
    const baseRule = template.recurrence_rule
      .split(';')
      .filter((p) => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='))
      .join(';');

    // 3. Create new template starting at occurrenceDate
    const durationMs = template.end_at
      ? new Date(template.end_at).getTime() - new Date(template.start_at).getTime()
      : 0;

    const newTemplate = this.eventRepo.create({
      user_id: userId,
      title: template.title,
      description: template.description ?? undefined,
      category: template.category ?? undefined,
      start_at: occurrenceDate,
      end_at: durationMs
        ? new Date(new Date(occurrenceDate).getTime() + durationMs).toISOString()
        : undefined,
      timezone: template.timezone,
      location: template.location ?? undefined,
      recurrence_rule: baseRule,
    });

    // 4. Re-parent exceptions
    this.eventRepo.reparentExceptions(templateId, newTemplate.id, occurrenceDate);

    return newTemplate;
  }

  deleteFuture(templateId: number, occurrenceDate: string, userId: number): void {
    const template = this.eventRepo.findById(templateId, userId);
    if (!template || !template.recurrence_rule) return;

    // 1. Set UNTIL on template to day before occurrenceDate
    const dayBefore = new Date(new Date(occurrenceDate).getTime() - 86400000).toISOString();
    this.eventRepo.setRecurrenceUntil(templateId, dayBefore);

    // 2. Delete all exceptions >= occurrenceDate
    this.eventRepo.deleteExceptionsFrom(templateId, occurrenceDate);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/services/event/event-service.test.ts`
Expected: ALL tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/event/event-service.ts test/services/event/event-service.test.ts
git commit -m "feat: add editOccurrence, splitRecurrence, deleteFuture to EventService"
```

---

## Chunk 4: Add-Event Scene, Keyboards, Callbacks, and i18n

### Task 7: Add new CB constants and i18n messages

**Files:**
- Modify: `src/config/constants.ts`

- [ ] **Step 1: Add new CB constants**

Add to the `CB` object in `src/config/constants.ts`:

```typescript
  RECURRENCE_DELETE: 'erd',
  ADD_RECURRENCE: 'ar',
  ADD_REC_END: 'are',
  ADD_SKIP: 'ask',
```

- [ ] **Step 2: Add i18n messages**

Add to `MSG.en`:

```typescript
    recurrence_prompt: 'Repeat this event?',
    recurrence_end_prompt: 'When should it stop repeating?',
    recurrence_custom_prompt: 'Describe the recurrence (e.g., "every 2 weeks", "daily"):',
    holidays_menu: 'Your holiday subscriptions:',
    holidays_add: 'Choose a region:',
    holidays_added: (country: string) => `Added holidays for ${country}`,
    holidays_removed: (country: string) => `Removed ${country} holidays`,
    holidays_set_primary: (country: string) => `${country} set as primary`,
    holidays_no_subs: 'No holiday subscriptions. Use the button below to add.',
    holidays_upcoming: 'Upcoming holidays:',
    holidays_none_upcoming: 'No upcoming holidays.',
    holidays_day_off: 'Day off',
```

Add to `MSG.ru`:

```typescript
    recurrence_prompt: 'Повторять событие?',
    recurrence_end_prompt: 'Когда прекратить повторение?',
    recurrence_custom_prompt: 'Опишите повторение (напр. "каждые 2 недели", "ежедневно"):',
    holidays_menu: 'Ваши подписки на праздники:',
    holidays_add: 'Выберите регион:',
    holidays_added: (country: string) => `Добавлены праздники: ${country}`,
    holidays_removed: (country: string) => `Удалены праздники: ${country}`,
    holidays_set_primary: (country: string) => `${country} — основная страна`,
    holidays_no_subs: 'Нет подписок на праздники. Нажмите кнопку ниже.',
    holidays_upcoming: 'Ближайшие праздники:',
    holidays_none_upcoming: 'Нет ближайших праздников.',
    holidays_day_off: 'Выходной',
```

- [ ] **Step 3: Commit**

```bash
git add src/config/constants.ts
git commit -m "feat: add CB constants and i18n messages for recurrence and holidays"
```

---

### Task 8: Update keyboards for recurring events

**Files:**
- Modify: `src/bot/keyboards.ts`

- [ ] **Step 1: Add new keyboard functions and update recurringEditKeyboard**

Add to `src/bot/keyboards.ts`:

```typescript
// Recurrence selection for add-event scene
export function recurrenceKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Не повторять' : "Don't repeat", `${CB.ADD_RECURRENCE}:none`)
    .row()
    .text(lang === 'ru' ? 'Каждый день' : 'Daily', `${CB.ADD_RECURRENCE}:DAILY`)
    .text(lang === 'ru' ? 'Каждую неделю' : 'Weekly', `${CB.ADD_RECURRENCE}:WEEKLY`)
    .row()
    .text(lang === 'ru' ? 'Каждый месяц' : 'Monthly', `${CB.ADD_RECURRENCE}:MONTHLY`)
    .text(lang === 'ru' ? 'Каждый год' : 'Yearly', `${CB.ADD_RECURRENCE}:YEARLY`)
    .row()
    .text(lang === 'ru' ? 'Другое...' : 'Custom...', `${CB.ADD_RECURRENCE}:custom`);
}

// Recurrence end for add-event scene
export function recurrenceEndKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Бесконечно' : 'No end', `${CB.ADD_REC_END}:forever`)
    .row()
    .text(lang === 'ru' ? 'До даты' : 'Until date', `${CB.ADD_REC_END}:until`)
    .text(lang === 'ru' ? 'N повторений' : 'N times', `${CB.ADD_REC_END}:count`);
}

// Skip button for optional scene steps
export function skipKeyboard(lang: 'en' | 'ru', stepIndex: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Пропустить' : 'Skip', `${CB.ADD_SKIP}:${stepIndex}`);
}

// Scope keyboard for recurring event edit/delete actions
export function recurrenceScopeKeyboard(
  prefix: string,
  eventId: number,
  occurrenceDate: string,
  lang: 'en' | 'ru',
): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Только это' : 'This only', `${prefix}:${eventId}:${occurrenceDate}:this`)
    .row()
    .text(lang === 'ru' ? 'Все будущие' : 'All future', `${prefix}:${eventId}:${occurrenceDate}:future`);
}
```

Update `recurringEditKeyboard` — reduce to 2 buttons (remove "all occurrences"):

```typescript
export function recurringEditKeyboard(eventId: number, occurrenceDate: string, lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? 'Только это' : 'This only', `${CB.EVENT_RECURRENCE}:${eventId}:${occurrenceDate}:this`)
    .row()
    .text(lang === 'ru' ? 'Все будущие' : 'All future', `${CB.EVENT_RECURRENCE}:${eventId}:${occurrenceDate}:future`);
}
```

Also add the new imports for CB constants (`ADD_RECURRENCE`, `ADD_REC_END`, `ADD_SKIP`).

**Important:** `recurringEditKeyboard` signature changes from `(eventId, lang)` to `(eventId, occurrenceDate, lang)`. This is a breaking change — do NOT commit keyboards.ts alone. Commit it together with the callback handler and edit/delete command updates in Task 10 to avoid a broken intermediate state.

- [ ] **Step 2: Do NOT commit yet — proceed to Task 9 and Task 10 first, then commit all together**

---

### Task 9: Rewrite add-event scene with recurrence steps and skip buttons

**Files:**
- Modify: `src/bot/scenes/add-event.scene.ts`

This is the largest single task. The scene goes from 5 steps to 7 steps, and steps 2-6 support both `message` and `callback_query` for skip/keyboard actions.

- [ ] **Step 1: Rewrite AddEventState interface**

```typescript
interface AddEventState {
  title?: string;
  startAt?: string;
  endAt?: string;
  recurrenceRule?: string | null;
  recEndMode?: 'until' | 'count'; // tracks which sub-prompt was sent in recurrence-end step
  description?: string;
  location?: string;
}
```

- [ ] **Step 2: Rewrite scene steps**

Full scene structure — 7 steps:

**Step 0 (message): Title** — unchanged from current.

**Step 1 (message): Date/Time** — unchanged from current.

**Step 2 (['message', 'callback_query']): Duration** — on firstTime, send prompt with skip keyboard. Handle callback `ask:2` for skip, or text for `parseDuration`.

**Step 3 (['message', 'callback_query']): Recurrence** — on firstTime, send recurrence keyboard. Handle:
- Callback `ar:none` → set recurrenceRule to null, skip step 4 via `scene.step.go(5, true)`
- Callback `ar:DAILY|WEEKLY|MONTHLY|YEARLY` → build RRULE string `FREQ=<freq>`, advance normally
- Callback `ar:custom` → send custom prompt, stay on step (don't advance)
- Message text → `parseRecurrence()`, build RRULE

**Step 4 (['message', 'callback_query']): Recurrence End** (conditional) — on firstTime, send recurrence-end keyboard. Handle:
- Callback `are:forever` → no change to RRULE, advance
- Callback `are:until` → set `recEndMode: 'until'` in state (without advancing: `{ step: undefined }`), send "send date" prompt
- Callback `are:count` → set `recEndMode: 'count'` in state (without advancing: `{ step: undefined }`), send "how many?" prompt
- Message text when `recEndMode === 'until'` → `parseSimpleDate()`, format as `YYYYMMDDTHHmmssZ`, append `;UNTIL=` to RRULE, advance
- Message text when `recEndMode === 'count'` → parse number, append `;COUNT=N` to RRULE, advance

**Step 5 (['message', 'callback_query']): Description** — on firstTime, send prompt with skip keyboard. Handle skip callback or text.

**Step 6 (['message', 'callback_query']): Location → create event** — on firstTime, send prompt with skip keyboard. Handle skip callback or text. On completion, pass `recurrence_rule` from state to `createEvent()`.

- [ ] **Step 3: Implementation code**

The full implementation is in the existing `src/bot/scenes/add-event.scene.ts`. Rewrite the entire `createAddEventScene` function. Key patterns:

For steps that accept both message and callback_query:
```typescript
.step(['message', 'callback_query'], async (context) => {
  // Detect callback_query
  if (context.is('callback_query')) {
    const data = (context as unknown as { data: string }).data;
    // Handle callback...
    const cbCtx = context as unknown as {
      answer: (opts?: Record<string, unknown>) => Promise<unknown>;
    };
    await cbCtx.answer();
    await context.scene.update({ /* state */ });
    return;
  }
  // Handle message text
  const text = (context as unknown as { text?: string }).text;
  // ...
})
```

For skipping recurrence-end (step 4) when no recurrence:
```typescript
// In step 3 handler, when user picks "Don't repeat":
await context.scene.update({ recurrenceRule: null }, { step: undefined });
await context.scene.step.go(5, true); // Jump to description step
return;
```

For creating event in final step:
```typescript
const event = eventService.createEvent({
  user_id: user.telegram_id,
  title,
  start_at: startAt,
  end_at: endAt,
  timezone: user.timezone,
  description,
  location,
  recurrence_rule: recurrenceRule ?? undefined,
});
```

- [ ] **Step 4: Lint and test manually**

Run: `bun run lint:fix`
Verify the scene compiles: `bun run build` or `bun check` if available.

- [ ] **Step 5: Commit**

```bash
git add src/bot/scenes/add-event.scene.ts
git commit -m "feat: add recurrence steps and skip buttons to add-event scene"
```

---

### Task 10: Update callback handler for recurring event edit/delete with occurrence date

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/bot/commands/edit.ts`
- Modify: `src/bot/commands/delete.ts`

- [ ] **Step 1: Update callback handler routing**

In `src/bot/handlers/callback.handler.ts`, the `CB.EVENT_RECURRENCE` handler needs to handle the new format `er:{eventId}:{occurrenceDate}:{scope}`:

```typescript
// Recurring event edit scope
if (action === CB.EVENT_RECURRENCE) {
  // Format: er:{eventId}:{occurrenceDate}:{scope}
  const [eidStr, ...rest] = payload.split(':');
  const eventId = Number(eidStr);
  const scope = rest.pop(); // 'this' or 'future'
  const occurrenceDate = rest.join(':'); // ISO date may contain ':'
  const lang = (user.language ?? 'en') as 'en' | 'ru';

  if (scope === 'this') {
    const exception = eventService.editOccurrence(eventId, occurrenceDate, user.telegram_id);
    if (!exception) return ctx.answer({ text: 'Error' });
    await ctx.answer();
    return ctx.editText(
      formatEventDetail(exception, user.timezone, lang),
      { parse_mode: 'HTML', reply_markup: editFieldKeyboard(exception.id, lang) },
    );
  }

  if (scope === 'future') {
    const newTemplate = eventService.splitRecurrence(eventId, occurrenceDate, user.telegram_id);
    if (!newTemplate) return ctx.answer({ text: 'Error' });
    await ctx.answer();
    return ctx.editText(
      formatEventDetail(newTemplate, user.timezone, lang),
      { parse_mode: 'HTML', reply_markup: editFieldKeyboard(newTemplate.id, lang) },
    );
  }

  await ctx.answer();
  return;
}
```

Add handler for `CB.RECURRENCE_DELETE`:

```typescript
// Recurring event delete scope
if (action === CB.RECURRENCE_DELETE) {
  // Format: erd:{eventId}:{occurrenceDate}:{scope}
  const [eidStr, ...rest] = payload.split(':');
  const eventId = Number(eidStr);
  const scope = rest.pop();
  const occurrenceDate = rest.join(':');
  const lang = (user.language ?? 'en') as 'en' | 'ru';

  if (scope === 'this') {
    const event = eventService.getEvent(eventId, user.telegram_id);
    eventService.cancelOccurrence(eventId, user.telegram_id, occurrenceDate);
    await ctx.answer();
    return ctx.editText(t(lang).event_deleted(event?.title ?? '?'));
  }

  if (scope === 'future') {
    const event = eventService.getEvent(eventId, user.telegram_id);
    eventService.deleteFuture(eventId, occurrenceDate, user.telegram_id);
    await ctx.answer();
    return ctx.editText(t(lang).event_deleted(event?.title ?? '?'));
  }

  await ctx.answer();
  return;
}
```

**Scene vs global callback routing:** `CB.ADD_SKIP`, `CB.ADD_RECURRENCE`, `CB.ADD_REC_END` callbacks are handled by the scene step handlers, not by `callback.handler.ts`. The `@gramio/scenes` plugin is registered with `.extend(scenesPlugin)` before `.on('callback_query', ...)` in `bot/index.ts`, so scene step handlers get priority. When a user is in a scene, the scene's `.step(['message', 'callback_query'], ...)` intercepts the callback. The global callback handler only sees callbacks when no scene is active. No routing changes needed for scene callbacks.

However, add a guard in `callback.handler.ts` to silently ignore unknown prefixes that start with `ar`, `are`, `ask` — these can leak through if the scene exits mid-step. In the existing `cmdLogger.warn` for unknown actions, this is already non-blocking, so no code change needed — the warning log is acceptable.

Also update `CB.EVENT_DELETE` handler to parse occurrence date (same pattern as `CB.EVENT_EDIT`):

```typescript
if (action === CB.EVENT_DELETE) {
  if (payload === 'cancel') {
    await ctx.answer();
    return ctx.editText('OK');
  }
  const colonIdx = payload.indexOf(':');
  if (colonIdx === -1) {
    return handleDeleteCallback(ctx, eventService, user, Number(payload));
  }
  const eventId = Number(payload.slice(0, colonIdx));
  const occurrenceDate = payload.slice(colonIdx + 1);
  return handleDeleteCallback(ctx, eventService, user, eventId, occurrenceDate);
}
```

- [ ] **Step 2: Update edit.ts for occurrence-aware callbacks**

In `src/bot/commands/edit.ts`, `handleEditCallback` now receives occurrence info. When a recurring event is tapped for edit:

Update `handleEditCallback` to pass occurrence date to `recurringEditKeyboard`:

```typescript
export async function handleEditCallback(
  ctx: BotCallbackContext,
  eventService: EventService,
  user: User,
  eventId: number,
  occurrenceDate?: string,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const event = eventService.getEvent(eventId, user.telegram_id);
  if (!event) {
    await ctx.answer({ text: 'Event not found' });
    return;
  }

  await ctx.answer();

  if (event.recurrence_rule && occurrenceDate) {
    await ctx.editText(formatEventDetail(event, user.timezone, lang), {
      parse_mode: 'HTML',
      reply_markup: recurringEditKeyboard(eventId, occurrenceDate, lang),
    });
    return;
  }

  await ctx.editText(formatEventDetail(event, user.timezone, lang), {
    parse_mode: 'HTML',
    reply_markup: editFieldKeyboard(eventId, lang),
  });
}
```

Update the `CB.EVENT_EDIT` handler in `callback.handler.ts` to detect and pass occurrence date:

```typescript
if (action === CB.EVENT_EDIT) {
  if (payload === 'cancel') {
    await ctx.answer();
    return ctx.editText('OK');
  }
  // payload might be "42" (one-off) or "42:2026-03-15T10:00:00Z" (recurring)
  const colonIdx = payload.indexOf(':');
  if (colonIdx === -1) {
    return handleEditCallback(ctx, eventService, user, Number(payload));
  }
  const eventId = Number(payload.slice(0, colonIdx));
  const occurrenceDate = payload.slice(colonIdx + 1);
  return handleEditCallback(ctx, eventService, user, eventId, occurrenceDate);
}
```

- [ ] **Step 3: Update delete.ts for recurring delete with scope keyboard**

Update `handleDeleteCallback` in `src/bot/commands/delete.ts` to show scope keyboard for recurring events:

```typescript
export async function handleDeleteCallback(
  ctx: BotCallbackContext,
  eventService: EventService,
  user: User,
  eventId: number,
  occurrenceDate?: string,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  // ... existing cancel check ...

  const event = eventService.getEvent(eventId, user.telegram_id);
  if (!event) {
    await ctx.answer({ text: 'Event not found' });
    return;
  }

  await ctx.answer();

  if (event.recurrence_rule && occurrenceDate) {
    // Show scope keyboard for recurring events
    await ctx.editText(t(lang).confirm_delete(event.title), {
      reply_markup: recurrenceScopeKeyboard(CB.RECURRENCE_DELETE, eventId, occurrenceDate, lang),
    });
    return;
  }

  await ctx.editText(t(lang).confirm_delete(event.title), {
    reply_markup: deleteConfirmKeyboard(eventId, lang),
  });
}
```

Update `CB.EVENT_DELETE` handler similarly to `CB.EVENT_EDIT` to parse occurrence date from payload.

- [ ] **Step 4: Update eventActionsKeyboard for recurring event occurrences**

In `src/bot/keyboards.ts`, add occurrence-aware variant:

```typescript
export function eventActionsKeyboardOcc(
  eventId: number,
  occurrenceDate: string,
  lang: 'en' | 'ru',
): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? '✏️ Редактировать' : '✏️ Edit', `${CB.EVENT_EDIT}:${eventId}:${occurrenceDate}`)
    .text(lang === 'ru' ? '🗑 Удалить' : '🗑 Delete', `${CB.EVENT_DELETE}:${eventId}:${occurrenceDate}`);
}
```

Use this keyboard when displaying recurring event occurrences (e.g. in event detail view).

- [ ] **Step 5: Lint and commit**

```bash
bun run lint:fix
git add src/bot/handlers/callback.handler.ts src/bot/commands/edit.ts src/bot/commands/delete.ts src/bot/keyboards.ts
git commit -m "feat: wire recurring event edit/delete with scope selection"
```

---

## Chunk 5: Holidays — Data Layer

### Task 11: Add migration 004 for holiday tables

**Files:**
- Modify: `src/database/migrations.ts`

- [ ] **Step 1: Add migration**

Add to `migrations` array in `src/database/migrations.ts`:

```typescript
  {
    name: '004_create_holiday_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE holiday_countries (
          code TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          region TEXT NOT NULL
        );

        CREATE TABLE holidays (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          country_code TEXT NOT NULL,
          date TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'public',
          year INTEGER NOT NULL,
          FOREIGN KEY (country_code) REFERENCES holiday_countries(code) ON DELETE CASCADE
        );
        CREATE INDEX idx_holidays_country_date ON holidays(country_code, date);
        CREATE INDEX idx_holidays_date ON holidays(date);
        CREATE UNIQUE INDEX idx_holidays_unique ON holidays(country_code, date, name);

        CREATE TABLE holiday_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          country_code TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0,
          notify INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
          FOREIGN KEY (country_code) REFERENCES holiday_countries(code) ON DELETE CASCADE,
          UNIQUE(user_id, country_code)
        );
        CREATE INDEX idx_holiday_subs_user ON holiday_subscriptions(user_id);

        CREATE TABLE holiday_overrides (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          date TEXT NOT NULL,
          is_day_off INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE,
          UNIQUE(user_id, date)
        );
        CREATE INDEX idx_holiday_overrides_user_date ON holiday_overrides(user_id, date);
      `);
    },
  },
```

- [ ] **Step 2: Run migration test**

Run: `bun test test/database/schema.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/database/migrations.ts
git commit -m "feat: add migration 004 for holiday tables"
```

---

### Task 12: Create HolidayRepository

**Files:**
- Create: `src/database/repositories/holiday.repository.ts`
- Create: `test/database/repositories/holiday.repository.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/database/repositories/holiday.repository.test.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('HolidayRepository', () => {
  let db: Database;
  let repo: HolidayRepository;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    repo = new HolidayRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
  });

  test('upsertCountry inserts and returns country', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    const country = repo.getCountry('TR');
    expect(country).not.toBeNull();
    expect(country!.name).toBe('Turkey');
  });

  test('insertHolidays stores holidays', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    repo.insertHolidays([
      { country_code: 'TR', date: '2026-01-01', name: "New Year's Day", type: 'public', year: 2026 },
      { country_code: 'TR', date: '2026-04-23', name: "Children's Day", type: 'public', year: 2026 },
    ]);
    const holidays = repo.getHolidaysForRange('TR', '2026-01-01', '2026-12-31');
    expect(holidays.length).toBe(2);
  });

  test('subscribe and getSubscriptions', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    repo.subscribe(USER_ID, 'TR', true);
    const subs = repo.getSubscriptions(USER_ID);
    expect(subs.length).toBe(1);
    expect(subs[0]!.is_primary).toBe(1);
  });

  test('unsubscribe removes subscription', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    repo.subscribe(USER_ID, 'TR', false);
    repo.unsubscribe(USER_ID, 'TR');
    const subs = repo.getSubscriptions(USER_ID);
    expect(subs.length).toBe(0);
  });

  test('setPrimary updates primary flag', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    repo.upsertCountry('UA', 'Ukraine', 'Europe');
    repo.subscribe(USER_ID, 'TR', true);
    repo.subscribe(USER_ID, 'UA', false);
    repo.setPrimary(USER_ID, 'UA');
    const subs = repo.getSubscriptions(USER_ID);
    const uaSub = subs.find((s) => s.country_code === 'UA');
    const trSub = subs.find((s) => s.country_code === 'TR');
    expect(uaSub!.is_primary).toBe(1);
    expect(trSub!.is_primary).toBe(0);
  });

  test('setOverride and getOverride', () => {
    repo.setOverride(USER_ID, '2026-03-15', true);
    const override = repo.getOverride(USER_ID, '2026-03-15');
    expect(override).not.toBeNull();
    expect(override!.is_day_off).toBe(1);
  });

  test('getHolidaysForUserDate returns holidays across subscriptions', () => {
    repo.upsertCountry('TR', 'Turkey', 'Europe');
    repo.insertHolidays([
      { country_code: 'TR', date: '2026-01-01', name: "New Year", type: 'public', year: 2026 },
    ]);
    repo.subscribe(USER_ID, 'TR', true);
    const holidays = repo.getHolidaysForUserDate(USER_ID, '2026-01-01');
    expect(holidays.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/database/repositories/holiday.repository.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement HolidayRepository**

Create `src/database/repositories/holiday.repository.ts`:

```typescript
import type { Database } from 'bun:sqlite';

export interface HolidayCountryRow {
  code: string;
  name: string;
  region: string;
}

export interface HolidayRow {
  id: number;
  country_code: string;
  date: string;
  name: string;
  type: string;
  year: number;
}

export interface HolidaySubscriptionRow {
  id: number;
  user_id: number;
  country_code: string;
  is_primary: number;
  notify: number;
  created_at: string;
}

export interface HolidayOverrideRow {
  id: number;
  user_id: number;
  date: string;
  is_day_off: number;
  created_at: string;
}

export interface InsertHolidayData {
  country_code: string;
  date: string;
  name: string;
  type: string;
  year: number;
}

export class HolidayRepository {
  constructor(private db: Database) {}

  upsertCountry(code: string, name: string, region: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO holiday_countries (code, name, region) VALUES (?, ?, ?)')
      .run(code, name, region);
  }

  getCountry(code: string): HolidayCountryRow | null {
    return this.db.prepare('SELECT * FROM holiday_countries WHERE code = ?').get(code) as HolidayCountryRow | null;
  }

  getCountriesByRegion(region: string): HolidayCountryRow[] {
    return this.db
      .prepare('SELECT * FROM holiday_countries WHERE region = ? ORDER BY name')
      .all(region) as HolidayCountryRow[];
  }

  getAllRegions(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT region FROM holiday_countries ORDER BY region')
      .all() as { region: string }[];
    return rows.map((r) => r.region);
  }

  insertHolidays(holidays: InsertHolidayData[]): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO holidays (country_code, date, name, type, year) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this.db.transaction(() => {
      for (const h of holidays) {
        stmt.run(h.country_code, h.date, h.name, h.type, h.year);
      }
    });
    tx();
  }

  deleteHolidaysByYear(countryCode: string, year: number): void {
    this.db.prepare('DELETE FROM holidays WHERE country_code = ? AND year = ?').run(countryCode, year);
  }

  getHolidaysForRange(countryCode: string, fromDate: string, toDate: string): HolidayRow[] {
    return this.db
      .prepare('SELECT * FROM holidays WHERE country_code = ? AND date >= ? AND date <= ? ORDER BY date')
      .all(countryCode, fromDate, toDate) as HolidayRow[];
  }

  getHolidaysForUserDate(userId: number, date: string): (HolidayRow & { country_name: string })[] {
    return this.db
      .prepare(`
        SELECT h.*, hc.name as country_name
        FROM holidays h
        JOIN holiday_subscriptions hs ON hs.country_code = h.country_code AND hs.user_id = ?
        JOIN holiday_countries hc ON hc.code = h.country_code
        WHERE h.date = ?
        ORDER BY hs.is_primary DESC, h.country_code
      `)
      .all(userId, date) as (HolidayRow & { country_name: string })[];
  }

  subscribe(userId: number, countryCode: string, isPrimary: boolean): void {
    if (isPrimary) {
      // Clear other primaries
      this.db.prepare('UPDATE holiday_subscriptions SET is_primary = 0 WHERE user_id = ?').run(userId);
    }
    this.db
      .prepare(`
        INSERT INTO holiday_subscriptions (user_id, country_code, is_primary) VALUES (?, ?, ?)
        ON CONFLICT(user_id, country_code) DO UPDATE SET is_primary = excluded.is_primary
      `)
      .run(userId, countryCode, isPrimary ? 1 : 0);
  }

  unsubscribe(userId: number, countryCode: string): void {
    this.db
      .prepare('DELETE FROM holiday_subscriptions WHERE user_id = ? AND country_code = ?')
      .run(userId, countryCode);
  }

  getSubscriptions(userId: number): HolidaySubscriptionRow[] {
    return this.db
      .prepare('SELECT * FROM holiday_subscriptions WHERE user_id = ? ORDER BY is_primary DESC')
      .all(userId) as HolidaySubscriptionRow[];
  }

  setPrimary(userId: number, countryCode: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE holiday_subscriptions SET is_primary = 0 WHERE user_id = ?').run(userId);
      this.db
        .prepare('UPDATE holiday_subscriptions SET is_primary = 1 WHERE user_id = ? AND country_code = ?')
        .run(userId, countryCode);
    });
    tx();
  }

  toggleNotify(userId: number, countryCode: string): void {
    this.db
      .prepare(
        'UPDATE holiday_subscriptions SET notify = 1 - notify WHERE user_id = ? AND country_code = ?',
      )
      .run(userId, countryCode);
  }

  setOverride(userId: number, date: string, isDayOff: boolean): void {
    this.db
      .prepare('INSERT OR REPLACE INTO holiday_overrides (user_id, date, is_day_off) VALUES (?, ?, ?)')
      .run(userId, date, isDayOff ? 1 : 0);
  }

  getOverride(userId: number, date: string): HolidayOverrideRow | null {
    return this.db
      .prepare('SELECT * FROM holiday_overrides WHERE user_id = ? AND date = ?')
      .get(userId, date) as HolidayOverrideRow | null;
  }

  removeOverride(userId: number, date: string): void {
    this.db.prepare('DELETE FROM holiday_overrides WHERE user_id = ? AND date = ?').run(userId, date);
  }

  getPrimaryCountry(userId: number): string | null {
    const row = this.db
      .prepare('SELECT country_code FROM holiday_subscriptions WHERE user_id = ? AND is_primary = 1')
      .get(userId) as { country_code: string } | null;
    return row?.country_code ?? null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/database/repositories/holiday.repository.test.ts`
Expected: ALL tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/holiday.repository.ts test/database/repositories/holiday.repository.test.ts
git commit -m "feat: add HolidayRepository with CRUD for countries, holidays, subscriptions, overrides"
```

---

### Task 13: Create HolidayService

**Files:**
- Create: `src/services/holiday/holiday-service.ts`
- Create: `test/services/holiday/holiday-service.test.ts`

- [ ] **Step 1: Install date-holidays**

```bash
bun add date-holidays
```

- [ ] **Step 2: Write failing tests**

Create `test/services/holiday/holiday-service.test.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('HolidayService', () => {
  let db: Database;
  let service: HolidayService;
  let repo: HolidayRepository;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    repo = new HolidayRepository(db);
    new UserRepository(db).create({ telegram_id: USER_ID });
    service = new HolidayService(repo);
  });

  test('refreshCountryHolidays populates cache', () => {
    service.refreshCountryHolidays('UA', 2026);
    const holidays = repo.getHolidaysForRange('UA', '2026-01-01', '2026-12-31');
    expect(holidays.length).toBeGreaterThan(0);
  });

  test('subscribeUser subscribes and caches holidays', () => {
    service.subscribeUser(USER_ID, 'UA', true);
    const subs = repo.getSubscriptions(USER_ID);
    expect(subs.length).toBe(1);
    expect(subs[0]!.is_primary).toBe(1);
  });

  test('getHolidaysForDate returns holidays for subscribed user', () => {
    service.subscribeUser(USER_ID, 'UA', true);
    // UA has New Year's on Jan 1
    const holidays = service.getHolidaysForDate(USER_ID, '2026-01-01');
    expect(holidays.length).toBeGreaterThan(0);
  });

  test('isDayOff returns true for primary country holiday', () => {
    service.subscribeUser(USER_ID, 'UA', true);
    const result = service.isDayOff(USER_ID, '2026-01-01'); // New Year
    expect(result).toBe(true);
  });

  test('isDayOff respects user override', () => {
    service.subscribeUser(USER_ID, 'UA', true);
    repo.setOverride(USER_ID, '2026-01-01', false); // Mark as working day
    const result = service.isDayOff(USER_ID, '2026-01-01');
    expect(result).toBe(false);
  });

  test('isDayOff returns false with no subscriptions', () => {
    const result = service.isDayOff(USER_ID, '2026-01-01');
    expect(result).toBe(false);
  });

  test('getUpcomingHolidays returns future holidays', () => {
    service.subscribeUser(USER_ID, 'UA', true);
    const upcoming = service.getUpcomingHolidays(USER_ID, 10);
    expect(upcoming.length).toBeGreaterThan(0);
  });

  test('getAvailableRegions returns regions', () => {
    const regions = service.getAvailableRegions();
    expect(regions.length).toBeGreaterThan(0);
  });

  test('getCountriesForRegion returns countries', () => {
    const countries = service.getCountriesForRegion('Europe');
    expect(countries.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/services/holiday/holiday-service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement HolidayService**

Create `src/services/holiday/holiday-service.ts`:

```typescript
import Holidays from 'date-holidays';
import type { HolidayRepository, HolidayRow } from '../../database/repositories/holiday.repository.ts';

// Continent map for date-holidays countries
const CONTINENT_MAP: Record<string, string> = {
  // This will be populated from date-holidays library data
};

export interface HolidayEntry {
  date: string;
  name: string;
  type: string;
  countryCode: string;
  countryName: string;
}

export class HolidayService {
  private hd: Holidays;

  constructor(private repo: HolidayRepository) {
    this.hd = new Holidays();
  }

  refreshCountryHolidays(countryCode: string, year: number): void {
    this.hd.init(countryCode);
    const holidays = this.hd.getHolidays(year);

    // Upsert country
    const countryData = this.hd.getCountries();
    const countryName = countryData[countryCode] ?? countryCode;
    const region = this.guessRegion(countryCode);
    this.repo.upsertCountry(countryCode, countryName, region);

    // Delete old and insert new
    this.repo.deleteHolidaysByYear(countryCode, year);
    this.repo.insertHolidays(
      holidays
        .filter((h) => h.type === 'public' || h.type === 'bank')
        .map((h) => ({
          country_code: countryCode,
          date: h.date.slice(0, 10), // YYYY-MM-DD
          name: h.name,
          type: h.type,
          year,
        })),
    );
  }

  refreshOnStartup(): void {
    const currentYear = new Date().getFullYear();
    // Refresh all subscribed countries
    const allCountries = new Set<string>();
    // We can't easily get all subscribed countries without user context,
    // so this is called per-country when subscribing
    // For startup, iterate known countries in DB
    const regions = this.repo.getAllRegions();
    if (regions.length === 0) return; // No countries cached yet

    // Get all country codes from holiday_countries
    for (const region of regions) {
      const countries = this.repo.getCountriesByRegion(region);
      for (const c of countries) {
        allCountries.add(c.code);
      }
    }

    for (const code of allCountries) {
      this.refreshCountryHolidays(code, currentYear);
      this.refreshCountryHolidays(code, currentYear + 1);
    }
  }

  subscribeUser(userId: number, countryCode: string, isPrimary: boolean): void {
    const currentYear = new Date().getFullYear();
    this.refreshCountryHolidays(countryCode, currentYear);
    this.refreshCountryHolidays(countryCode, currentYear + 1);
    this.repo.subscribe(userId, countryCode, isPrimary);
  }

  unsubscribeUser(userId: number, countryCode: string): void {
    this.repo.unsubscribe(userId, countryCode);
  }

  getHolidaysForDate(userId: number, date: string): HolidayEntry[] {
    const dateStr = date.slice(0, 10);
    const rows = this.repo.getHolidaysForUserDate(userId, dateStr);
    return rows.map((r) => ({
      date: r.date,
      name: r.name,
      type: r.type,
      countryCode: r.country_code,
      countryName: r.country_name,
    }));
  }

  isDayOff(userId: number, date: string): boolean {
    const dateStr = date.slice(0, 10);

    // 1. Check user override first
    const override = this.repo.getOverride(userId, dateStr);
    if (override) return override.is_day_off === 1;

    // 2. Check primary country holidays (public + bank only)
    const primaryCountry = this.repo.getPrimaryCountry(userId);
    if (!primaryCountry) return false;

    const holidays = this.repo.getHolidaysForRange(primaryCountry, dateStr, dateStr);
    return holidays.some((h) => h.type === 'public' || h.type === 'bank');
  }

  getUpcomingHolidays(userId: number, limit = 10): HolidayEntry[] {
    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const subs = this.repo.getSubscriptions(userId);

    const all: HolidayEntry[] = [];
    for (const sub of subs) {
      const country = this.repo.getCountry(sub.country_code);
      const holidays = this.repo.getHolidaysForRange(sub.country_code, today, endDate);
      for (const h of holidays) {
        all.push({
          date: h.date,
          name: h.name,
          type: h.type,
          countryCode: h.country_code,
          countryName: country?.name ?? h.country_code,
        });
      }
    }

    return all.sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit);
  }

  getAvailableRegions(): string[] {
    // Get regions from date-holidays library
    const countries = this.hd.getCountries();
    const regionSet = new Set<string>();
    for (const code of Object.keys(countries)) {
      regionSet.add(this.guessRegion(code));
    }
    return [...regionSet].sort();
  }

  getCountriesForRegion(region: string): { code: string; name: string }[] {
    const allCountries = this.hd.getCountries();
    const result: { code: string; name: string }[] = [];
    for (const [code, name] of Object.entries(allCountries)) {
      if (this.guessRegion(code) === region) {
        result.push({ code, name: name as string });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  private guessRegion(countryCode: string): string {
    // Simple continent assignment based on country code ranges
    // Using a hardcoded map for common countries
    const regionMap: Record<string, string> = {
      // Europe
      AL: 'Europe', AT: 'Europe', BE: 'Europe', BG: 'Europe', BY: 'Europe',
      CH: 'Europe', CZ: 'Europe', DE: 'Europe', DK: 'Europe', EE: 'Europe',
      ES: 'Europe', FI: 'Europe', FR: 'Europe', GB: 'Europe', GR: 'Europe',
      HR: 'Europe', HU: 'Europe', IE: 'Europe', IS: 'Europe', IT: 'Europe',
      LT: 'Europe', LU: 'Europe', LV: 'Europe', MD: 'Europe', ME: 'Europe',
      MK: 'Europe', NL: 'Europe', NO: 'Europe', PL: 'Europe', PT: 'Europe',
      RO: 'Europe', RS: 'Europe', RU: 'Europe', SE: 'Europe', SI: 'Europe',
      SK: 'Europe', TR: 'Europe', UA: 'Europe', XK: 'Europe',
      // Asia
      AE: 'Asia', AM: 'Asia', AZ: 'Asia', BD: 'Asia', BN: 'Asia',
      CN: 'Asia', GE: 'Asia', HK: 'Asia', ID: 'Asia', IL: 'Asia',
      IN: 'Asia', IQ: 'Asia', IR: 'Asia', JP: 'Asia', KG: 'Asia',
      KH: 'Asia', KR: 'Asia', KZ: 'Asia', LA: 'Asia', LK: 'Asia',
      MM: 'Asia', MN: 'Asia', MY: 'Asia', NP: 'Asia', PH: 'Asia',
      PK: 'Asia', QA: 'Asia', SA: 'Asia', SG: 'Asia', TH: 'Asia',
      TJ: 'Asia', TM: 'Asia', TW: 'Asia', UZ: 'Asia', VN: 'Asia',
      // Americas
      AR: 'Americas', BO: 'Americas', BR: 'Americas', CA: 'Americas',
      CL: 'Americas', CO: 'Americas', CR: 'Americas', CU: 'Americas',
      DO: 'Americas', EC: 'Americas', GT: 'Americas', HN: 'Americas',
      HT: 'Americas', JM: 'Americas', MX: 'Americas', NI: 'Americas',
      PA: 'Americas', PE: 'Americas', PY: 'Americas', SV: 'Americas',
      US: 'Americas', UY: 'Americas', VE: 'Americas',
      // Africa
      AO: 'Africa', BF: 'Africa', BJ: 'Africa', BW: 'Africa',
      CD: 'Africa', CF: 'Africa', CG: 'Africa', CI: 'Africa',
      CM: 'Africa', DJ: 'Africa', DZ: 'Africa', EG: 'Africa',
      ET: 'Africa', GA: 'Africa', GH: 'Africa', GN: 'Africa',
      KE: 'Africa', LY: 'Africa', MA: 'Africa', MG: 'Africa',
      ML: 'Africa', MR: 'Africa', MU: 'Africa', MW: 'Africa',
      MZ: 'Africa', NA: 'Africa', NE: 'Africa', NG: 'Africa',
      RW: 'Africa', SD: 'Africa', SN: 'Africa', SO: 'Africa',
      SS: 'Africa', TD: 'Africa', TG: 'Africa', TN: 'Africa',
      TZ: 'Africa', UG: 'Africa', ZA: 'Africa', ZM: 'Africa',
      ZW: 'Africa',
      // Oceania
      AU: 'Oceania', FJ: 'Oceania', NZ: 'Oceania', PG: 'Oceania',
    };
    return regionMap[countryCode] ?? 'Other';
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/services/holiday/holiday-service.test.ts`
Expected: ALL tests PASS

- [ ] **Step 6: Wire HolidayRepository into DatabaseService**

Modify `src/database/index.ts` to instantiate and expose `HolidayRepository`:

```typescript
import { HolidayRepository } from './repositories/holiday.repository.ts';
// ...
holidays: new HolidayRepository(db),
```

- [ ] **Step 7: Commit**

```bash
git add src/services/holiday/holiday-service.ts test/services/holiday/holiday-service.test.ts src/database/index.ts
git commit -m "feat: add HolidayService with date-holidays integration and caching"
```

---

## Chunk 6: Holidays — Bot Layer

### Task 14: Add holiday i18n keys, keyboards, and `/holidays` command

**Files:**
- Modify: `src/config/constants.ts` (add `CB.HOLIDAYS`, holiday i18n keys)
- Create: `src/bot/commands/holidays.ts`
- Modify: `src/bot/keyboards.ts` (add holiday keyboards)
- Modify: `src/services/holiday/holiday-service.ts` (add `getCountryName`, `getSubscription`, `getSubscriptions`, `toggleNotify`, `setPrimary`)
- Modify: `src/database/repositories/holiday.repository.ts` (add `getSubscription`)
- Modify: `src/bot/handlers/callback.handler.ts` (add `hl` prefix routing)
- Modify: `src/bot/index.ts` (wire HolidayService, register command)

- [ ] **Step 1: Add CB prefix and i18n keys to constants.ts**

In `src/config/constants.ts`, add to `CB`:

```typescript
  HOLIDAYS: 'hl',
```

Add to `MSG.en`:

```typescript
    holidays_menu: '🌍 <b>Holiday Subscriptions</b>',
    holidays_no_subs: 'No countries added yet. Tap "+ Add" to subscribe.',
    holidays_added: (country: string) => `✅ Subscribed to ${country}`,
    holidays_removed: (country: string) => `Removed ${country}`,
    holidays_set_primary: (country: string) => `${country} set as primary`,
    holidays_pick_region: 'Choose a region:',
    holidays_pick_country: 'Choose a country:',
    holidays_upcoming: '📅 <b>Upcoming Holidays</b>',
    holidays_none_upcoming: 'No upcoming holidays for your subscriptions.',
    holidays_day_off: '🎉 Day off! No free slots to show.',
    holidays_manage_prompt: 'Choose a subscription to manage:',
    holidays_notify_on: (country: string) => `${country}: notifications ON`,
    holidays_notify_off: (country: string) => `${country}: notifications OFF`,
```

Add to `MSG.ru`:

```typescript
    holidays_menu: '🌍 <b>Праздники</b>',
    holidays_no_subs: 'Нет подписок. Нажмите "+ Добавить" чтобы подписаться.',
    holidays_added: (country: string) => `✅ Подписка на ${country}`,
    holidays_removed: (country: string) => `Удалено: ${country}`,
    holidays_set_primary: (country: string) => `${country} — основная страна`,
    holidays_pick_region: 'Выберите регион:',
    holidays_pick_country: 'Выберите страну:',
    holidays_upcoming: '📅 <b>Ближайшие праздники</b>',
    holidays_none_upcoming: 'Нет ближайших праздников по вашим подпискам.',
    holidays_day_off: '🎉 Выходной! Свободных слотов нет.',
    holidays_manage_prompt: 'Выберите подписку для управления:',
    holidays_notify_on: (country: string) => `${country}: уведомления ВКЛ`,
    holidays_notify_off: (country: string) => `${country}: уведомления ВЫКЛ`,
```

- [ ] **Step 2: Add holiday keyboards to keyboards.ts**

Add to `src/bot/keyboards.ts`:

```typescript
export function holidaysMenuKeyboard(lang: 'en' | 'ru'): InlineKeyboard {
  return new InlineKeyboard()
    .text(lang === 'ru' ? '+ Добавить' : '+ Add', `${CB.HOLIDAYS}:add`)
    .text(lang === 'ru' ? 'Управление' : 'Manage', `${CB.HOLIDAYS}:manage`)
    .row()
    .text(lang === 'ru' ? 'Ближайшие' : 'Upcoming', `${CB.HOLIDAYS}:list`);
}

export function holidayRegionKeyboard(regions: string[], lang: 'en' | 'ru'): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const region of regions) {
    kb.text(region, `${CB.HOLIDAYS}:add:${region}`).row();
  }
  kb.text(lang === 'ru' ? '← Назад' : '← Back', `${CB.HOLIDAYS}:menu`);
  return kb;
}

const COUNTRIES_PER_PAGE = 8;

export function holidayCountryKeyboard(
  countries: { code: string; name: string }[],
  region: string,
  page: number,
  lang: 'en' | 'ru',
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const start = page * COUNTRIES_PER_PAGE;
  const slice = countries.slice(start, start + COUNTRIES_PER_PAGE);

  for (const c of slice) {
    kb.text(c.name, `${CB.HOLIDAYS}:sub:${c.code}`).row();
  }

  // Pagination
  const totalPages = Math.ceil(countries.length / COUNTRIES_PER_PAGE);
  if (totalPages > 1) {
    if (page > 0) {
      kb.text('◀️', `${CB.HOLIDAYS}:add:${region}:${page - 1}`);
    }
    kb.text(`${page + 1}/${totalPages}`, `${CB.HOLIDAYS}:noop`);
    if (page < totalPages - 1) {
      kb.text('▶️', `${CB.HOLIDAYS}:add:${region}:${page + 1}`);
    }
    kb.row();
  }

  kb.text(lang === 'ru' ? '← Регионы' : '← Regions', `${CB.HOLIDAYS}:add`);
  return kb;
}

export function holidayManageListKeyboard(
  subs: { country_code: string; countryName: string; is_primary: number }[],
  lang: 'en' | 'ru',
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const sub of subs) {
    const primary = sub.is_primary ? ' ⭐' : '';
    kb.text(`${sub.countryName}${primary}`, `${CB.HOLIDAYS}:manage:${sub.country_code}`).row();
  }
  kb.text(lang === 'ru' ? '← Назад' : '← Back', `${CB.HOLIDAYS}:menu`);
  return kb;
}

export function holidayManageCountryKeyboard(
  countryCode: string,
  isPrimary: boolean,
  isNotifyOn: boolean,
  lang: 'en' | 'ru',
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!isPrimary) {
    kb.text(lang === 'ru' ? '⭐ Основная' : '⭐ Set Primary', `${CB.HOLIDAYS}:primary:${countryCode}`).row();
  }
  const notifyLabel = isNotifyOn
    ? (lang === 'ru' ? '🔔 Уведомления: ВКЛ' : '🔔 Notifications: ON')
    : (lang === 'ru' ? '🔕 Уведомления: ВЫКЛ' : '🔕 Notifications: OFF');
  kb.text(notifyLabel, `${CB.HOLIDAYS}:notify:${countryCode}`).row();
  kb.text(lang === 'ru' ? '🗑 Удалить' : '🗑 Remove', `${CB.HOLIDAYS}:remove:${countryCode}`).row();
  kb.text(lang === 'ru' ? '← Назад' : '← Back', `${CB.HOLIDAYS}:manage`);
  return kb;
}
```

- [ ] **Step 3: Create holidays command**

Create `src/bot/commands/holidays.ts`:

```typescript
// src/bot/commands/holidays.ts

import { CB, t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import {
  holidayCountryKeyboard,
  holidayManageCountryKeyboard,
  holidayManageListKeyboard,
  holidayRegionKeyboard,
  holidaysMenuKeyboard,
} from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export async function handleHolidays(ctx: BotCommandContext, holidayService: HolidayService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const args = (ctx.args as string)?.trim();

  if (args === 'list') {
    const text = buildUpcomingText(holidayService, user, lang);
    await ctx.send(text ?? (t(lang).holidays_none_upcoming as string), { parse_mode: 'HTML' });
    return;
  }

  return sendMainMenu(ctx, holidayService, user, lang);
}

function buildMenuText(holidayService: HolidayService, user: User, lang: 'en' | 'ru'): string {
  const subs = holidayService.getSubscriptions(user.telegram_id);
  let text = t(lang).holidays_menu as string;

  if (subs.length === 0) {
    text += `\n\n${t(lang).holidays_no_subs}`;
  } else {
    text += '\n';
    for (const s of subs) {
      const country = holidayService.getCountryName(s.country_code);
      const primary = s.is_primary ? ' ⭐' : '';
      text += `\n• ${country}${primary}`;
    }
  }
  return text;
}

async function sendMainMenu(
  ctx: BotCommandContext,
  holidayService: HolidayService,
  user: User,
  lang: 'en' | 'ru',
): Promise<void> {
  await ctx.send(buildMenuText(holidayService, user, lang), {
    parse_mode: 'HTML',
    reply_markup: holidaysMenuKeyboard(lang),
  });
}

async function editMainMenu(
  ctx: BotCallbackContext,
  holidayService: HolidayService,
  user: User,
  lang: 'en' | 'ru',
): Promise<void> {
  await ctx.editText(buildMenuText(holidayService, user, lang), {
    parse_mode: 'HTML',
    reply_markup: holidaysMenuKeyboard(lang),
  });
}

function buildUpcomingText(holidayService: HolidayService, user: User, lang: 'en' | 'ru'): string | null {
  const holidays = holidayService.getUpcomingHolidays(user.telegram_id, 10);
  if (holidays.length === 0) return null;
  const lines = holidays.map(
    (h) => `  ${h.date}  ${escapeHtml(h.name)} <i>(${escapeHtml(h.countryName)})</i>`,
  );
  return `${t(lang).holidays_upcoming}\n\n${lines.join('\n')}`;
}

export async function handleHolidayCallback(
  ctx: BotCallbackContext,
  holidayService: HolidayService,
  user: User,
  payload: string,
): Promise<void> {
  const lang = (user.language ?? 'en') as 'en' | 'ru';
  const parts = payload.split(':');
  const action = parts[0]!;

  // hl:menu
  if (action === 'menu') {
    await ctx.answer();
    return editMainMenu(ctx, holidayService, user, lang);
  }

  // hl:noop (pagination label)
  if (action === 'noop') {
    await ctx.answer();
    return;
  }

  // hl:add — show region picker
  // hl:add:{region} — show country picker
  // hl:add:{region}:{page} — paginated country picker
  if (action === 'add') {
    await ctx.answer();
    const region = parts[1];
    if (!region) {
      const regions = holidayService.getAvailableRegions();
      return ctx.editText(t(lang).holidays_pick_region, {
        parse_mode: 'HTML',
        reply_markup: holidayRegionKeyboard(regions, lang),
      });
    }
    const page = parts[2] ? Number(parts[2]) : 0;
    const countries = holidayService.getCountriesForRegion(region);
    return ctx.editText(t(lang).holidays_pick_country, {
      parse_mode: 'HTML',
      reply_markup: holidayCountryKeyboard(countries, region, page, lang),
    });
  }

  // hl:sub:{countryCode} — subscribe
  if (action === 'sub') {
    const countryCode = parts[1]!;
    const subs = holidayService.getSubscriptions(user.telegram_id);
    const isPrimary = subs.length === 0; // First subscription becomes primary
    holidayService.subscribeUser(user.telegram_id, countryCode, isPrimary);
    const countryName = holidayService.getCountryName(countryCode);
    await ctx.answer({ text: t(lang).holidays_added(countryName) });
    // Return to main menu
    return editMainMenu(ctx, holidayService, user, lang);
  }

  // hl:manage — show subscription list
  // hl:manage:{countryCode} — show management for country
  if (action === 'manage') {
    await ctx.answer();
    const countryCode = parts[1];
    if (!countryCode) {
      const subs = holidayService.getSubscriptions(user.telegram_id);
      if (subs.length === 0) {
        return ctx.editText(t(lang).holidays_no_subs, { parse_mode: 'HTML' });
      }
      const subsWithNames = subs.map((s) => ({
        country_code: s.country_code,
        countryName: holidayService.getCountryName(s.country_code),
        is_primary: s.is_primary,
      }));
      return ctx.editText(t(lang).holidays_manage_prompt, {
        parse_mode: 'HTML',
        reply_markup: holidayManageListKeyboard(subsWithNames, lang),
      });
    }
    const subscription = holidayService.getSubscription(user.telegram_id, countryCode);
    if (!subscription) {
      return ctx.editText(t(lang).holidays_no_subs, { parse_mode: 'HTML' });
    }
    const countryName = holidayService.getCountryName(countryCode);
    return ctx.editText(`${countryName}`, {
      reply_markup: holidayManageCountryKeyboard(
        countryCode, subscription.is_primary === 1, !!subscription.notify, lang,
      ),
    });
  }

  // hl:primary:{countryCode}
  if (action === 'primary') {
    const countryCode = parts[1]!;
    holidayService.setPrimary(user.telegram_id, countryCode);
    const countryName = holidayService.getCountryName(countryCode);
    await ctx.answer({ text: t(lang).holidays_set_primary(countryName) });
    // Return to manage list
    const subs = holidayService.getSubscriptions(user.telegram_id);
    const subsWithNames = subs.map((s) => ({
      country_code: s.country_code,
      countryName: holidayService.getCountryName(s.country_code),
      is_primary: s.is_primary,
    }));
    return ctx.editText(t(lang).holidays_manage_prompt, {
      parse_mode: 'HTML',
      reply_markup: holidayManageListKeyboard(subsWithNames, lang),
    });
  }

  // hl:remove:{countryCode}
  if (action === 'remove') {
    const countryCode = parts[1]!;
    const countryName = holidayService.getCountryName(countryCode);
    holidayService.unsubscribeUser(user.telegram_id, countryCode);
    await ctx.answer({ text: t(lang).holidays_removed(countryName) });
    return editMainMenu(ctx, holidayService, user, lang);
  }

  // hl:notify:{countryCode} — toggle notifications
  if (action === 'notify') {
    const countryCode = parts[1]!;
    holidayService.toggleNotify(user.telegram_id, countryCode);
    const countryName = holidayService.getCountryName(countryCode);
    const subscription = holidayService.getSubscription(user.telegram_id, countryCode);
    if (!subscription) return;
    const notifyMsg = subscription.notify
      ? t(lang).holidays_notify_on(countryName)
      : t(lang).holidays_notify_off(countryName);
    await ctx.answer({ text: notifyMsg });
    return ctx.editText(`${countryName}`, {
      reply_markup: holidayManageCountryKeyboard(
        countryCode, subscription.is_primary === 1, !!subscription.notify, lang,
      ),
    });
  }

  // hl:list — upcoming holidays
  if (action === 'list') {
    await ctx.answer();
    const text = buildUpcomingText(holidayService, user, lang);
    return ctx.editText(text ?? (t(lang).holidays_none_upcoming as string), { parse_mode: 'HTML' });
  }
}
```

**Required HolidayService additions**: `getCountryName`, `getSubscription`, `getSubscriptions`, `setPrimary`, and `toggleNotify` are not yet in the plan. Add to `HolidayService` in Task 13:

```typescript
getCountryName(code: string): string {
  const country = this.repo.getCountry(code);
  return country?.name ?? code;
}

getSubscription(userId: number, countryCode: string): HolidaySubscriptionRow | null {
  return this.repo.getSubscription(userId, countryCode);
}

getSubscriptions(userId: number): HolidaySubscriptionRow[] {
  return this.repo.getSubscriptions(userId);
}

setPrimary(userId: number, countryCode: string): void {
  this.repo.setPrimary(userId, countryCode);
}

toggleNotify(userId: number, countryCode: string): void {
  this.repo.toggleNotify(userId, countryCode);
}
```

**Required HolidayRepository addition** — `getSubscription()` (note: `getSubscriptions` plural already exists in Task 12):

```typescript
getSubscription(userId: number, countryCode: string): HolidaySubscriptionRow | null {
  return this.db
    .prepare('SELECT * FROM holiday_subscriptions WHERE user_id = ? AND country_code = ?')
    .get(userId, countryCode) as HolidaySubscriptionRow | null;
}
```

- [ ] **Step 4: Add callback routing in callback.handler.ts**

Add import at top of `src/bot/handlers/callback.handler.ts`:

```typescript
import { handleHolidayCallback } from '../commands/holidays.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
```

Change `createCallbackHandler` signature to accept `HolidayService`:

```typescript
export function createCallbackHandler(
  eventService: EventService,
  editValueScene: AnyScene,
  holidayService: HolidayService,
) {
```

Add routing before the `cmdLogger.warn` fallback:

```typescript
      // Holidays
      if (action === CB.HOLIDAYS) {
        return handleHolidayCallback(ctx, holidayService, user, payload);
      }
```

- [ ] **Step 5: Wire HolidayService in bot/index.ts**

Add imports to `src/bot/index.ts`:

```typescript
import { HolidayService } from '../services/holiday/holiday-service.ts';
import { handleHolidays } from './commands/holidays.ts';
```

Inside `createBot()`, after `eventService` creation:

```typescript
const holidayService = new HolidayService(db.holidays);
holidayService.refreshOnStartup();
```

Add command registration (after `.command('export', ...)`):

```typescript
    .command('holidays', (ctx) => handleHolidays(ctx as unknown as BotCommandContext, holidayService))
```

Update callback handler call to pass `holidayService`:

```typescript
    .on('callback_query', (ctx) =>
      createCallbackHandler(eventService, scenesSetup.scenes.editValueScene, holidayService)(
        ctx as unknown as BotCallbackContext,
      ),
    )
```

Update return value to include `holidayService`:

```typescript
  return { bot, eventService, holidayService, db };
```

- [ ] **Step 6: Run lint**

Run: `bun run lint`
Expected: Zero warnings

- [ ] **Step 7: Commit**

```bash
git add src/config/constants.ts src/bot/keyboards.ts src/bot/commands/holidays.ts src/services/holiday/holiday-service.ts src/database/repositories/holiday.repository.ts src/bot/handlers/callback.handler.ts src/bot/index.ts
git commit -m "feat: add /holidays command with region/country picker and subscription management"
```

---

### Task 15: Integrate holidays into agenda and /free

**Files:**
- Modify: `src/services/event/formatters.ts` (`formatDayAgenda`, `formatWeekAgenda`)
- Modify: `src/bot/commands/today.ts`
- Modify: `src/bot/commands/tomorrow.ts`
- Modify: `src/bot/commands/week.ts`
- Modify: `src/bot/commands/free.ts`

- [ ] **Step 1: Add optional holidays param to formatDayAgenda**

In `src/services/event/formatters.ts`, add import and modify `formatDayAgenda`:

```typescript
import type { HolidayEntry } from '../holiday/holiday-service.ts';
```

Replace the `formatDayAgenda` function signature and body:

```typescript
export function formatDayAgenda(
  occurrences: EventOccurrence[],
  dateIso: string,
  timezone: string,
  lang: string,
  holidays?: HolidayEntry[],
): string {
  const header = `📅 ${formatDateHeader(dateIso, timezone, lang)}`;

  const holidayLines = (holidays ?? []).map((h) => `  🎉 ${escapeHtml(h.name)}`);

  if (occurrences.length === 0 && holidayLines.length === 0) {
    const noEvents = lang === 'ru' ? 'Нет событий. /add для создания.' : 'No events. Use /add to create one.';
    return `${header}\n\n${noEvents}`;
  }

  const eventLines = occurrences.map((occ) => {
    const time = formatTimeRange(occ.occurrence_start, occ.occurrence_end, timezone);
    const title = escapeHtml(occ.event.title);
    const recur = occ.event.recurrence_rule ? ' 🔁' : '';
    return `  ${time}  ${title}${recur}`;
  });

  const allLines = [...holidayLines, ...eventLines];
  return `${header}\n\n${allLines.join('\n')}`;
}
```

- [ ] **Step 2: Add optional holidays to formatWeekAgenda**

Replace `formatWeekAgenda` signature and update the per-day loop:

```typescript
export function formatWeekAgenda(
  occurrences: EventOccurrence[],
  startDateIso: string,
  endDateIso: string,
  timezone: string,
  lang: string,
  holidaysByDate?: Map<string, HolidayEntry[]>,
): string {
  const byDay = new Map<string, EventOccurrence[]>();
  for (const occ of occurrences) {
    const dayKey = occ.occurrence_start.slice(0, 10);
    const arr = byDay.get(dayKey) ?? [];
    arr.push(occ);
    byDay.set(dayKey, arr);
  }

  const start = new Date(startDateIso);
  const lines: string[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const dayKey = d.toISOString().slice(0, 10);
    const dayLabel = formatDateShort(d.toISOString(), timezone, lang);
    const dayEvents = byDay.get(dayKey) ?? [];
    const dayHolidays = holidaysByDate?.get(dayKey) ?? [];

    if (dayHolidays.length > 0) {
      for (const h of dayHolidays) {
        lines.push(`${dayLabel}  🎉 ${escapeHtml(h.name)}`);
      }
    }

    if (dayEvents.length === 0 && dayHolidays.length === 0) {
      const noEvents = lang === 'ru' ? '— нет событий' : '— no events';
      lines.push(`${dayLabel}  ${noEvents}`);
    } else if (dayEvents.length > 0) {
      lines.push(
        `${dayLabel}  ▪ ${dayEvents.length} ${dayEvents.length === 1 ? (lang === 'ru' ? 'событие' : 'event') : lang === 'ru' ? 'событий' : 'events'}`,
      );
      for (const occ of dayEvents) {
        const time = formatTime(occ.occurrence_start, timezone);
        lines.push(`  ${time} ${escapeHtml(occ.event.title)}`);
      }
    }
    lines.push('');
  }

  const headerStart = formatDateShort(startDateIso, timezone, lang);
  const headerEnd = formatDateShort(endDateIso, timezone, lang);
  return `📅 ${lang === 'ru' ? 'Неделя' : 'Week'} ${headerStart}–${headerEnd}\n\n${lines.join('\n').trim()}`;
}
```

- [ ] **Step 3: Update today/tomorrow commands**

Modify `src/bot/commands/today.ts` to accept optional `HolidayService`:

```typescript
import type { HolidayService } from '../../services/holiday/holiday-service.ts';

export async function handleToday(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const now = new Date();
  const occurrences = eventService.getEventsForDay(user.telegram_id, now, user.timezone);
  const holidays = holidayService?.getHolidaysForDate(user.telegram_id, now.toISOString().slice(0, 10)) ?? [];
  const text = formatDayAgenda(occurrences, now.toISOString(), user.timezone, user.language, holidays);
  await ctx.send(text, { parse_mode: 'HTML' });
}
```

For `src/bot/commands/tomorrow.ts`:

```typescript
import type { HolidayService } from '../../services/holiday/holiday-service.ts';

export async function handleTomorrow(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const tomorrow = addDays(new Date(), 1);
  const occurrences = eventService.getEventsForDay(user.telegram_id, tomorrow, user.timezone);
  const holidays = holidayService?.getHolidaysForDate(user.telegram_id, tomorrow.toISOString().slice(0, 10)) ?? [];
  const text = formatDayAgenda(occurrences, tomorrow.toISOString(), user.timezone, user.language, holidays);
  await ctx.send(text, { parse_mode: 'HTML' });
}
```

- [ ] **Step 4: Update week command**

Modify `src/bot/commands/week.ts`:

```typescript
import type { HolidayEntry, HolidayService } from '../../services/holiday/holiday-service.ts';

export async function handleWeek(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const now = new Date();
  const { start, end } = getWeekRangeUtc(now, user.timezone);
  const occurrences = eventService.getEventsInRange(user.telegram_id, start, end);

  // Build per-day holiday map
  let holidaysByDate: Map<string, HolidayEntry[]> | undefined;
  if (holidayService) {
    holidaysByDate = new Map();
    const startD = new Date(start);
    for (let i = 0; i < 7; i++) {
      const d = new Date(startD.getTime() + i * 86400000);
      const dayKey = d.toISOString().slice(0, 10);
      const holidays = holidayService.getHolidaysForDate(user.telegram_id, dayKey);
      if (holidays.length > 0) {
        holidaysByDate.set(dayKey, holidays);
      }
    }
  }

  const text = formatWeekAgenda(occurrences, start, end, user.timezone, user.language, holidaysByDate);
  await ctx.send(text, { parse_mode: 'HTML' });
}
```

- [ ] **Step 5: Update /free command**

Modify `src/bot/commands/free.ts` to accept optional `HolidayService`:

```typescript
import type { HolidayService } from '../../services/holiday/holiday-service.ts';

export async function handleFree(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const args = (ctx.args as string)?.trim();

  let date = new Date();
  if (args) {
    const parsed = parseSimpleDate(`${args} 00:00`, user.timezone);
    if (parsed) date = parsed;
  }

  // Check if day is a holiday for primary country
  if (holidayService?.isDayOff(user.telegram_id, date.toISOString().slice(0, 10))) {
    const dateLabel = formatDateHeader(date.toISOString(), user.timezone, lang);
    await ctx.send(`${dateLabel}\n\n${t(lang).holidays_day_off}`);
    return;
  }

  const slots = eventService.getFreeSlots(user.telegram_id, date, user.timezone);
  // ... rest of existing code unchanged
```

- [ ] **Step 6: Update command registrations in bot/index.ts**

Update command handlers in `src/bot/index.ts` to pass `holidayService`:

```typescript
    .command('today', (ctx) => handleToday(ctx as unknown as BotCommandContext, eventService, holidayService))
    .command('tomorrow', (ctx) => handleTomorrow(ctx as unknown as BotCommandContext, eventService, holidayService))
    .command('week', (ctx) => handleWeek(ctx as unknown as BotCommandContext, eventService, holidayService))
    .command('free', (ctx) => handleFree(ctx as unknown as BotCommandContext, eventService, holidayService))
```

- [ ] **Step 7: Run tests and lint**

Run: `bun test && bun run lint`
Expected: ALL tests PASS, zero lint warnings

**Note:** Existing tests for `formatDayAgenda`/`formatWeekAgenda` still pass because the `holidays` param is optional. No test changes needed.

- [ ] **Step 8: Commit**

```bash
git add src/services/event/formatters.ts src/bot/commands/today.ts src/bot/commands/tomorrow.ts src/bot/commands/week.ts src/bot/commands/free.ts src/bot/index.ts
git commit -m "feat: integrate holidays into day/week agenda and /free command"
```

---

### Task 16: Update help text and final verification

**Files:**
- Modify: `src/bot/commands/help.ts` (add /holidays to help text)

- [ ] **Step 1: Update help text**

In `src/bot/commands/help.ts`, add to `HELP_EN` before `🔧 <b>Other</b>`:

```
🌍 <b>Holidays</b>
  /holidays — manage holiday subscriptions
  /holidays list — upcoming holidays
```

Add to `HELP_RU` before `🔧 <b>Другое</b>`:

```
🌍 <b>Праздники</b>
  /holidays — управление праздниками
  /holidays list — ближайшие праздники
```

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: ALL tests PASS

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: Zero warnings

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/help.ts
git commit -m "feat: add /holidays to help text"
```
