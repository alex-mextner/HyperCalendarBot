# Timezone Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `get_timezone_info` and `convert_to_timezone` AI tools so the agent never guesses UTC offsets, plus a mandatory system prompt rule forbidding offset guessing.

**Architecture:** Two pure sync handler functions in `meta.ts`, wired into `tool-executor.ts` and `tools.ts`. Suggestions on invalid IANA use `city-timezones` `cityMapping` (already a dep). System prompt gets a new TIMEZONE RULE block.

**Tech Stack:** `Intl.DateTimeFormat` (built-in, TZ database always current), `city-timezones` (already installed), `bun:test`

---

### Task 1: Shared timezone helpers in meta.ts

**Files:**
- Modify: `src/services/ai/tool-handlers/meta.ts`
- Test: `test/services/ai/tool-handlers/meta.test.ts`

Three private helpers needed by both tool handlers:

**`getOffsetMinutes(timezone, dt)`** — returns the UTC offset in minutes at a given `Date` for a valid IANA timezone using `Intl.DateTimeFormat`.

**`getTimezoneSuggestions(input)`** — when IANA is invalid, returns top-30 suggestions:
- Extract region prefix: `input.split('/')[0]` (e.g. `"America"` from `"America/Blah"`)
- If prefix present: filter `cityTimezones.cityMapping` where `c.timezone?.startsWith(prefix + '/')`
- If no `/` in input: use all of `cityTimezones.cityMapping`
- Deduplicate by timezone: for each unique timezone keep the entry with the highest `pop`
- Sort descending by `pop`, take 30
- Format each as `"America/New_York (New York)"` (timezone + city name)

**`validateAndGetOffset(timezone, dt)`** — wraps `new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'shortOffset' })`, returns `{ offsetStr: "+01:00", offsetMinutes: 60 }` or throws.

- [ ] **Step 1: Write failing tests for `getTimezoneSuggestions` (export it temporarily for testing)**

Add to `test/services/ai/tool-handlers/meta.test.ts`:

```ts
import { getTimezoneSuggestions } from '../../../../src/services/ai/tool-handlers/meta.ts';

describe('getTimezoneSuggestions', () => {
  test('returns up to 30 suggestions for valid region prefix', () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(30);
    expect(suggestions.every(s => s.startsWith('America/'))).toBe(true);
  });

  test('returns globally sorted suggestions when no slash', () => {
    const suggestions = getTimezoneSuggestions('Moscow');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(30);
  });

  test('deduplicates by timezone', () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    const tzNames = suggestions.map(s => s.split(' ')[0]);
    const unique = new Set(tzNames);
    expect(unique.size).toBe(tzNames.length);
  });

  test('format includes timezone and city name', () => {
    const suggestions = getTimezoneSuggestions('America/Blah');
    expect(suggestions[0]).toMatch(/^[\w/]+ \(.+\)$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/services/ai/tool-handlers/meta.test.ts --grep getTimezoneSuggestions
```
Expected: FAIL — `getTimezoneSuggestions` not exported.

- [ ] **Step 3: Implement helpers in meta.ts**

Add near the top of `src/services/ai/tool-handlers/meta.ts` (after existing imports):

```ts
import cityTimezones from 'city-timezones';
```

Add before `handleGetHolidays`:

```ts
function getOffsetMinutes(timezone: string, dt: Date): number {
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'shortOffset' });
  const parts = formatter.formatToParts(dt);
  const raw = (parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0').replace(/^GMT/, '');
  const match = raw.match(/^([+-])(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return (match[1] === '+' ? 1 : -1) * (Number.parseInt(match[2]!, 10) * 60 + Number.parseInt(match[3]!, 10));
}

export function getTimezoneSuggestions(input: string): string[] {
  const prefix = input.includes('/') ? input.split('/')[0] : null;
  const cities = prefix
    ? cityTimezones.cityMapping.filter((c) => c.timezone?.startsWith(`${prefix}/`))
    : cityTimezones.cityMapping;

  const best = new Map<string, { city: string; pop: number }>();
  for (const c of cities) {
    if (!c.timezone) continue;
    const existing = best.get(c.timezone);
    if (!existing || (c.pop ?? 0) > existing.pop) {
      best.set(c.timezone, { city: c.city, pop: c.pop ?? 0 });
    }
  }

  return [...best.entries()]
    .sort(([, a], [, b]) => b.pop - a.pop)
    .slice(0, 30)
    .map(([tz, { city }]) => `${tz} (${city})`);
}

function validateAndGetOffset(timezone: string, dt: Date): { offsetStr: string; offsetMinutes: number } {
  // throws if timezone is invalid
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'shortOffset' });
  const parts = formatter.formatToParts(dt);
  const raw = (parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0').replace(/^GMT/, '');
  const match = raw.match(/^([+-])(\d{1,2}):(\d{2})$/);
  const offsetStr = match ? `${match[1]}${match[2]!.padStart(2, '0')}:${match[3]}` : '+00:00';
  const offsetMinutes = match
    ? (match[1] === '+' ? 1 : -1) * (Number.parseInt(match[2]!, 10) * 60 + Number.parseInt(match[3]!, 10))
    : 0;
  return { offsetStr, offsetMinutes };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test test/services/ai/tool-handlers/meta.test.ts --grep getTimezoneSuggestions
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tool-handlers/meta.ts test/services/ai/tool-handlers/meta.test.ts
git commit -m "feat(timezone): add timezone helper functions"
```

---

### Task 2: handleGetTimezoneInfo

**Files:**
- Modify: `src/services/ai/tool-handlers/meta.ts`
- Test: `test/services/ai/tool-handlers/meta.test.ts`

- [ ] **Step 1: Write failing tests**

`timezone` accepts a single string or an array. When array, the response includes a comparison summary.

```ts
import { handleGetTimezoneInfo } from '../../../../src/services/ai/tool-handlers/meta.ts';

describe('handleGetTimezoneInfo', () => {
  // --- single timezone ---
  test('returns correct info for valid IANA timezone', () => {
    const result = handleGetTimezoneInfo({ timezone: 'Europe/London' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezone).toBe('Europe/London');
    expect(data.utc_offset).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(typeof data.dst_active).toBe('boolean');
    expect(data.local_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('accepts at parameter and returns offset at that time', () => {
    // New York in January is UTC-5 (EST, no DST)
    const result = handleGetTimezoneInfo({ timezone: 'America/New_York', at: '2026-01-15T12:00:00Z' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.utc_offset).toBe('-05:00');
    expect(data.dst_active).toBe(false);
  });

  test('detects DST active in summer', () => {
    // New York in July is UTC-4 (EDT, DST active)
    const result = handleGetTimezoneInfo({ timezone: 'America/New_York', at: '2026-07-15T12:00:00Z' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.utc_offset).toBe('-04:00');
    expect(data.dst_active).toBe(true);
  });

  test('returns error and suggestions for invalid timezone', () => {
    const result = handleGetTimezoneInfo({ timezone: 'America/Blah' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid timezone');
    expect(result.error).toContain('America/');
  });

  test('returns format error when no slash', () => {
    const result = handleGetTimezoneInfo({ timezone: 'Moscow' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('IANA');
  });

  test('returns error for invalid at datetime', () => {
    const result = handleGetTimezoneInfo({ timezone: 'Europe/London', at: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  // --- array of timezones ---
  test('compares two timezones and shows which is ahead', () => {
    const result = handleGetTimezoneInfo({
      timezone: ['Europe/Moscow', 'America/New_York'],
      at: '2026-01-15T12:00:00Z', // winter: Moscow +03:00, NY -05:00
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezones).toHaveLength(2);
    expect(data.difference_minutes).toBe(480);
    expect(data.difference_hours).toBe(8);
    expect(data.ahead).toContain('Europe/Moscow');
    expect(data.ahead).toContain('ahead');
  });

  test('array: ranks N timezones west to east, no difference fields', () => {
    const result = handleGetTimezoneInfo({
      timezone: ['Asia/Tokyo', 'America/New_York', 'Europe/London'],
      at: '2026-01-15T12:00:00Z',
    });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezones).toHaveLength(3);
    // ranked west→east: NY (-05:00), London (+00:00), Tokyo (+09:00)
    expect(data.ahead).toContain('Asia/Tokyo');
    expect(data.timezones[0].timezone).toBe('America/New_York');
    expect(data.timezones[2].timezone).toBe('Asia/Tokyo');
    // no difference fields for N>2
    expect(data.difference_minutes).toBeUndefined();
    expect(data.difference_hours).toBeUndefined();
  });

  test('array: returns error if any timezone is invalid', () => {
    const result = handleGetTimezoneInfo({ timezone: ['Europe/Moscow', 'America/Blah'] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('America/Blah');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/services/ai/tool-handlers/meta.test.ts --grep handleGetTimezoneInfo
```
Expected: FAIL — not exported.

- [ ] **Step 3: Implement handleGetTimezoneInfo in meta.ts**

Add a private helper `resolveSingle` that builds the per-timezone object, then `handleGetTimezoneInfo` handles both single and array inputs:

```ts
function resolveSingle(
  timezone: string,
  dt: Date,
): { offsetStr: string; offsetMinutes: number; dstActive: boolean; localTime: string } {
  const { offsetStr, offsetMinutes } = validateAndGetOffset(timezone, dt); // throws if invalid
  const year = dt.getFullYear();
  const janOffset = getOffsetMinutes(timezone, new Date(Date.UTC(year, 0, 15)));
  const julOffset = getOffsetMinutes(timezone, new Date(Date.UTC(year, 6, 15)));
  const dstActive = janOffset !== julOffset && offsetMinutes === Math.max(janOffset, julOffset);
  const localMs = dt.getTime() + offsetMinutes * 60_000;
  const local = new Date(localMs);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const localTime =
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offsetStr}`;
  return { offsetStr, offsetMinutes, dstActive, localTime };
}

function invalidTimezoneError(tz: string): ToolResult {
  const suggestions = getTimezoneSuggestions(tz);
  const hint = suggestions.length > 0 ? `\nLargest cities in this region: ${suggestions.join(', ')}` : '';
  if (!tz.includes('/')) {
    return { success: false, error: `Invalid timezone "${tz}". Use IANA format, e.g. "America/New_York".${hint}` };
  }
  return { success: false, error: `Invalid timezone "${tz}". Check the region name.${hint}` };
}

export function handleGetTimezoneInfo(input: { timezone: string | string[]; at?: string }): ToolResult {
  const dt = input.at ? new Date(input.at) : new Date();
  if (Number.isNaN(dt.getTime())) {
    return { success: false, error: `Invalid datetime: ${input.at}` };
  }

  // Single timezone
  if (typeof input.timezone === 'string') {
    try {
      const { offsetStr, offsetMinutes, dstActive, localTime } = resolveSingle(input.timezone, dt);
      return {
        success: true,
        output: JSON.stringify({
          timezone: input.timezone,
          utc_offset: offsetStr,
          utc_offset_minutes: offsetMinutes,
          dst_active: dstActive,
          local_time: localTime,
        }),
      };
    } catch {
      return invalidTimezoneError(input.timezone);
    }
  }

  // Array of timezones
  const entries: Array<{ timezone: string; utc_offset: string; utc_offset_minutes: number; dst_active: boolean; local_time: string }> = [];
  for (const tz of input.timezone) {
    try {
      const { offsetStr, offsetMinutes, dstActive, localTime } = resolveSingle(tz, dt);
      entries.push({ timezone: tz, utc_offset: offsetStr, utc_offset_minutes: offsetMinutes, dst_active: dstActive, local_time: localTime });
    } catch {
      return invalidTimezoneError(tz);
    }
  }

  // Sort west→east by offset
  entries.sort((a, b) => a.utc_offset_minutes - b.utc_offset_minutes);

  const minOffset = entries[0]!.utc_offset_minutes;
  const maxOffset = entries[entries.length - 1]!.utc_offset_minutes;
  const diffMinutes = maxOffset - minOffset;
  const diffHours = Math.round(diffMinutes / 60 * 10) / 10;

  const mostWest = entries[0]!.timezone;
  const mostEast = entries[entries.length - 1]!.timezone;
  const isTwo = entries.length === 2;
  const ahead = isTwo
    ? `${mostEast} is ${diffHours}h ahead of ${mostWest}`
    : `Ranked west→east: ${entries.map((e) => `${e.timezone} (${e.utc_offset})`).join(', ')}. ${mostEast} is furthest ahead.`;

  const result: Record<string, unknown> = { timezones: entries, ahead };
  if (isTwo) {
    result.difference_minutes = diffMinutes;
    result.difference_hours = diffHours;
  }

  return { success: true, output: JSON.stringify(result) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/services/ai/tool-handlers/meta.test.ts --grep handleGetTimezoneInfo
```
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tool-handlers/meta.ts test/services/ai/tool-handlers/meta.test.ts
git commit -m "feat(timezone): add handleGetTimezoneInfo with array comparison support"
```

---

### Task 3: handleConvertToTimezone

**Files:**
- Modify: `src/services/ai/tool-handlers/meta.ts`
- Test: `test/services/ai/tool-handlers/meta.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { handleConvertToTimezone } from '../../../../src/services/ai/tool-handlers/meta.ts';

describe('handleConvertToTimezone', () => {
  test('converts UTC datetime to local time in target timezone', () => {
    const result = handleConvertToTimezone({ datetime: '2026-07-15T14:00:00Z', timezone: 'America/New_York' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezone).toBe('America/New_York');
    expect(data.local_datetime).toBe('2026-07-15T10:00:00-04:00'); // EDT = UTC-4
    expect(data.utc_offset).toBe('-04:00');
  });

  test('converts datetime with offset to another timezone', () => {
    const result = handleConvertToTimezone({ datetime: '2026-01-15T10:00:00+01:00', timezone: 'Asia/Tokyo' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.local_datetime).toBe('2026-01-15T18:00:00+09:00');
  });

  test('returns error for invalid timezone', () => {
    const result = handleConvertToTimezone({ datetime: '2026-01-15T10:00:00Z', timezone: 'Europe/Blah' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid timezone');
  });

  test('returns error for invalid datetime', () => {
    const result = handleConvertToTimezone({ datetime: 'not-a-date', timezone: 'Europe/London' });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/services/ai/tool-handlers/meta.test.ts --grep handleConvertToTimezone
```
Expected: FAIL — not exported.

- [ ] **Step 3: Implement handleConvertToTimezone in meta.ts**

Add after `handleGetTimezoneInfo`:

```ts
export function handleConvertToTimezone(input: { datetime: string; timezone: string }): ToolResult {
  const dt = new Date(input.datetime);
  if (Number.isNaN(dt.getTime())) {
    return { success: false, error: `Invalid datetime: ${input.datetime}` };
  }

  let offsetStr: string;
  let offsetMinutes: number;
  try {
    ({ offsetStr, offsetMinutes } = validateAndGetOffset(input.timezone, dt));
  } catch {
    const suggestions = getTimezoneSuggestions(input.timezone);
    const hint = suggestions.length > 0 ? `\nLargest cities in this region: ${suggestions.join(', ')}` : '';
    if (!input.timezone.includes('/')) {
      return {
        success: false,
        error: `Invalid timezone "${input.timezone}". Use IANA format, e.g. "America/New_York".${hint}`,
      };
    }
    return { success: false, error: `Invalid timezone "${input.timezone}".${hint}` };
  }

  const localMs = dt.getTime() + offsetMinutes * 60_000;
  const local = new Date(localMs);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const localDatetime =
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offsetStr}`;

  return {
    success: true,
    output: JSON.stringify({
      timezone: input.timezone,
      local_datetime: localDatetime,
      utc_offset: offsetStr,
    }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test test/services/ai/tool-handlers/meta.test.ts --grep handleConvertToTimezone
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tool-handlers/meta.ts test/services/ai/tool-handlers/meta.test.ts
git commit -m "feat(timezone): add handleConvertToTimezone tool handler"
```

---

### Task 4: Wire tools into tool-executor.ts and tools.ts

**Files:**
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/tools.ts`

No new tests needed — the handlers themselves are fully covered in Tasks 1–3. Note: `suggestions` in error responses are embedded in the `error` string (not a separate field) because `ToolResult` has no `suggestions` field — this intentionally deviates from the spec schema but is the correct adaptation.

- [ ] **Step 1: Add imports and cases to tool-executor.ts**

In the import from `./tool-handlers/meta.ts`, add `handleGetTimezoneInfo` and `handleConvertToTimezone`.

Before the `default:` case (around line 296), add:

```ts
case 'get_timezone_info':
  return handleGetTimezoneInfo(input as { timezone: string | string[]; at?: string });

case 'convert_to_timezone':
  return handleConvertToTimezone(input as { datetime: string; timezone: string });
```

- [ ] **Step 2: Add tool definitions to tools.ts**

After the `calculate` tool definition (around line 868), add:

```ts
{
  name: 'get_timezone_info',
  description:
    'Get accurate UTC offset, DST status, and local time for one or more IANA timezones. ' +
    'ALWAYS use this tool — never guess offsets from memory. Training data about timezones is stale: ' +
    'countries change DST rules, cancel DST, or shift permanently. ' +
    'Pass `at` when scheduling a future event — the offset may differ from today due to DST transitions. ' +
    'Example: scheduling a New York meeting in July while it is currently March — ' +
    'the offset changes from -05:00 (winter) to -04:00 (summer). Without `at` you get the wrong offset. ' +
    'Pass an ARRAY of timezones to compare them: the response includes each offset, which is ahead, ' +
    'and (for exactly 2) the difference in hours — all pre-computed, no extra calculate call needed.',
  input_schema: {
    type: 'object' as const,
    properties: {
      timezone: {
        oneOf: [
          { type: 'string', description: 'Single IANA timezone (e.g. "America/New_York")' },
          {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of IANA timezones to compare (e.g. ["Europe/Moscow", "America/New_York"])',
          },
        ],
        description: 'IANA timezone name(s). Use array to compare multiple zones in one call.',
      },
      at: {
        type: 'string',
        description:
          'ISO 8601 datetime to check offset at (default: now). ' +
          'IMPORTANT: always pass the event datetime here when scheduling — DST may differ from today.',
      },
    },
    required: ['timezone'],
  },
},
{
  name: 'convert_to_timezone',
  description:
    'Convert a UTC (or offset-aware) datetime to local time in any IANA timezone. ' +
    'DST is applied automatically based on the exact datetime. ' +
    'Use when the user gives a time in their timezone and you need the UTC equivalent, ' +
    'or when showing a foreign time in local terms.',
  input_schema: {
    type: 'object' as const,
    properties: {
      datetime: {
        type: 'string',
        description: 'ISO 8601 datetime — UTC (e.g. "2026-07-15T14:00:00Z") or with offset',
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone name (e.g. "America/New_York")',
      },
    },
    required: ['datetime', 'timezone'],
  },
},
```

- [ ] **Step 3: Run full test suite to check nothing broke**

```bash
bun test
```
Expected: all existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/tool-executor.ts src/services/ai/tools.ts
git commit -m "feat(timezone): wire get_timezone_info and convert_to_timezone into agent"
```

---

### Task 5: System prompt TIMEZONE RULE

**Files:**
- Modify: `src/services/ai/system-prompt.ts`
- Test: `test/services/ai/system-prompt.test.ts` (if exists, otherwise skip)

- [ ] **Step 1: Add rule to system-prompt.ts**

In the `## Rules` section, find the line containing `All dates/times in tool calls must use ISO 8601 UTC format` and add the new rule after it:

```ts
- TIMEZONE RULE: NEVER guess or hardcode UTC offsets for any timezone — not even well-known ones like Moscow, Tokyo, Paris, or New York. Your training data about offsets is stale and wrong when DST or legal changes occur. The ONLY exception is the user's own timezone offset shown in User Info above — it is computed fresh for every message and is correct; use it directly without calling any tool. For ANY other timezone, ALWAYS call get_timezone_info first. When scheduling a future event in another timezone, ALWAYS pass the event datetime as the \`at\` parameter — the offset may differ from today due to DST transitions (e.g. New York is UTC-5 in winter but UTC-4 in summer). When comparing two or more timezones: pass them as an array in a single get_timezone_info call — the response already includes \`difference_hours\` (for exactly 2 zones) and \`ahead\` (which timezone is furthest ahead). Never compute timezone differences manually or in your head.
```

- [ ] **Step 2: Run full test suite**

```bash
bun test
```
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/services/ai/system-prompt.ts
git commit -m "feat(timezone): add mandatory TIMEZONE RULE to system prompt"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite with coverage**

```bash
bun test --coverage
```
Expected: all tests pass, new handlers covered.

- [ ] **Step 2: Run linter**

```bash
bun run lint
```
Expected: zero warnings or errors. Fix any before continuing.

- [ ] **Step 3: Push**

```bash
git push
```
