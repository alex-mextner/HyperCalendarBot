> Part 1 of 4 of [Parser Extensions + Recurring Events UI + Holidays Implementation Plan](../2026-03-12-parser-recurrence-holidays.md) — next: [02-tasks-5-10.md](02-tasks-5-10.md)

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

