# Timezone Tools for AI Agent

**Date:** 2026-03-20

## Problem

The AI agent guesses UTC offsets from its training data, which is often wrong:
- Model thinks Belgrade is UTC+2 but it's actually UTC+1 in winter
- Countries change DST rules, cancel DST entirely, shift to permanent summer/winter time
- Even the user's own timezone offset in the system prompt can be ignored — model falls back to its own (stale) knowledge

## Solution

Two new AI tools backed by `Intl.DateTimeFormat` (always up-to-date, uses runtime TZ database):
- `get_timezone_info` — returns current or future offset + DST status for any IANA timezone
- `convert_to_timezone` — converts a UTC datetime to local time in any IANA timezone

A mandatory system prompt rule: **never guess offsets for any timezone**, including the user's own.

## Tools

### `get_timezone_info`

```
Input:
  timezone: string | string[]  — one IANA name or an array of them
  at?: string                  — ISO 8601 datetime (default: now)

Output — single timezone (success):
  timezone: string        — the IANA name
  utc_offset: string      — e.g. "-04:00"
  utc_offset_minutes: number
  dst_active: boolean
  local_time: string      — local time at `at` in that timezone

Output — multiple timezones (success):
  timezones: Array<{ timezone, utc_offset, utc_offset_minutes, dst_active, local_time }>
  difference_minutes: number   — spread between max and min offset
  difference_hours: number     — same, in hours (rounded to 1 decimal)
  ahead: string                — human-readable: "Europe/Moscow is 8h ahead of America/New_York"
                                 for N>2: "Ranked west→east: America/New_York (−05:00), …, Europe/Moscow (+03:00)"

Output (error):
  error: string   — includes top 30 IANA zones in same region by city population
```

The `at` parameter is critical for scheduling. Example: scheduling a meeting in New York
for July when it's currently March — the offset may differ due to DST. Without `at`, the
tool returns the current offset which would be wrong for the future event.

When comparing timezones, pass them as an array in a single call — the response includes
the difference and which is ahead, pre-computed. No extra `calculate` call needed.

### `convert_to_timezone`

```
Input:
  datetime: string   — ISO 8601 (UTC or with offset)
  timezone: string   — IANA name

Output (success):
  timezone: string
  local_datetime: string  — e.g. "2026-07-15T10:00:00-04:00"
  utc_offset: string      — e.g. "-04:00"

Output (error):
  error: string
  suggestions: string[]
```

Equivalent to `get_timezone_info` with `at = datetime`, but purpose-built for conversion.

## Error Handling

When the IANA name is invalid, `Intl.DateTimeFormat` throws. The tool handler:

1. Tries to validate via `new Intl.DateTimeFormat('en', { timeZone: input })`
2. If invalid and input contains `/`: extracts region prefix (e.g. `America` from `America/Blah`),
   queries `city-timezones` for cities in that region, sorts by population, returns top 30 IANA zones.
3. If invalid and no `/`: returns format error + example + top 30 globally by population.

## DST Detection

`dst_active` is computed by comparing the offset at `at` against both Jan 1 and Jul 1 of the
same year. If the offsets differ, DST is observed in this timezone. DST is currently active if
the offset at `at` matches the summer (larger absolute) offset.

## System Prompt Rule

Added to the Rules section:

```
- TIMEZONE RULE: NEVER guess or hardcode UTC offsets for any timezone — not even well-known ones
  like Moscow, Tokyo, or New York. Your training data about offsets is stale and wrong when DST
  or legal changes occur. The user's own offset in User Info above is the ONLY exception — use it
  directly. For any other timezone, ALWAYS call get_timezone_info first. When scheduling a future
  event in another timezone, pass the event's datetime as `at` — the offset may differ from today
  due to DST transitions. When comparing two or more timezones, pass them as an array in a single
  get_timezone_info call — the response includes the difference and which timezone is ahead,
  already computed. Never do timezone arithmetic manually.
```

## Implementation

- Tool definitions: `src/services/ai/tools.ts`
- Tool handlers: `src/services/ai/tool-handlers/meta.ts` (two new `handle*` functions)
- Tool executor: `src/services/ai/tool-executor.ts` (two new `case` entries)
- System prompt: `src/services/ai/system-prompt.ts` (add TIMEZONE RULE)
- Tests: `test/services/ai/tool-handlers/meta.test.ts`
