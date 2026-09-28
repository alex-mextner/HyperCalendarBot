// src/services/calendar/wall-time-parser.ts
//
// Shared, pure time-of-day / all-day resolver for a calendar day that has already been
// selected (GH-650, slice 1 of the #554 dialogue redesign). Extracted from the divergent
// behavior of `parseWizardDateTime` (src/bot/scenes/add-event.scene.ts) and `parseTime`
// (src/services/intent/workflow-bindings.ts): PR562 documented that the add wizard
// accepted a bare "2" as an implicit 02:00 while the intent path rejected the identical
// input outright, on the same commit. Both legacy functions are left untouched by this
// slice and keep serving live traffic; this module is not wired into either call site yet
// (that wiring, and preserving the legacy wrapper for active sessions until it is flag-
// gated, is GH-652). See wall-time-adapters.ts for the two future call-site shapes.
//
// Scope: this parser resolves TIME OF DAY and the all-day/timed axis against an already-
// resolved `selectedDate`. It does not parse free-text dates (weekdays, month names,
// relative words) — that grammar already exists in three separate places
// (src/utils/date.ts:parseSimpleDate, add-event.scene.ts:parseWizardDate,
// workflow-bindings.ts:parseAbsoluteDay) and unifying it is a larger, separate slice not
// required by GH-650's acceptance criteria or its required synthetic cases. See
// docs/specs/2026-09-28-shared-wall-time-parser-650.md for the full scope writeup,
// including which declarative-corpus families these tests reproduce and where that
// corpus actually lives (it is not checked into this repo — see that doc).
//
// Invariants:
// - No network/DB/Telegram access, no reads of the system clock (`Date.now()`/`new
//   Date()` with no argument never appear below) — every input is explicit.
// - A bare hour 1-12 is always ambiguous (never guessed) when a time is actually pending;
//   the same digit with no pending time field is `unhandled`, not a time guess, so
//   pickers/ordinals/durations that happen to look like a clock hour are never hijacked.
// - Colon-separated input is always literal 24h, regardless of magnitude.
// - Impossible clock values (24:00, 25:00, minute 75, ...) and impossible calendar days
//   are rejected outright, never silently normalized/rolled over.
// - A clock change that skips a local time (DST gap) is `invalid`; one that repeats a
//   local time (DST fold) is `ambiguous` with both offset-qualified instants — neither is
//   ever silently picked.
// - Only a closed, corpus-grounded vocabulary is recognized for all-day and "time
//   unknown" phrases; unrecognized/negated input abstains (returns `invalid`/`unhandled`)
//   rather than stripping a prefix or guessing from a substring.

import {
  addOneDay,
  type CalendarDay,
  formatOffsetInstant,
  isoDay,
  resolveWallInstant,
  validCalendarDay,
} from './wall-clock.ts';

export type Schedule =
  | { kind: 'timed'; startAt: string }
  | { kind: 'all_day'; startDate: string; endDateExclusive: string };

export type WallTimeOutcome =
  | { decision: 'accepted'; schedule: Schedule }
  | { decision: 'ambiguous'; reason: 'bare_hour' | 'repeated_local_time'; candidates: readonly [string, string] }
  | {
      decision: 'invalid';
      reason:
        | 'unparseable'
        // Matches unified-dialogue-contract-cases.jsonl's own `expected.reason` string for
        // this exact family (see the spec doc) — not literally a "repair" action here, kept
        // for 1:1 corpus fidelity rather than renamed to a locally-nicer label.
        | 'explicit_date_or_time_repair'
        | 'nonexistent_local_time'
        | 'calendar_date_does_not_exist'
        | 'invalid_timezone';
    }
  | { decision: 'clarify'; reason: 'unknown_time_is_not_all_day' }
  | { decision: 'unhandled'; reason: 'not_pending_time' };

export interface WallTimeContext {
  /** Local calendar day already selected/pending, YYYY-MM-DD. Never recomputed from a clock here. */
  selectedDate: string;
  /** IANA timezone, e.g. "Europe/Belgrade". */
  timezone: string;
  /** Only 'time' enables resolution; anything else means this input isn't a time turn. */
  pendingField: 'time' | null;
}

const ALL_DAY_PHRASES: ReadonlySet<string> = new Set(['весь день', 'на весь день', 'all day']);
const UNKNOWN_TIME_PHRASES: ReadonlySet<string> = new Set([
  'время пока не знаю',
  'пока без времени',
  'time not decided',
]);

const WORD_TIMES: Record<string, { hour: number; minute: number }> = {
  полдень: { hour: 12, minute: 0 },
  noon: { hour: 12, minute: 0 },
  полночь: { hour: 0, minute: 0 },
  midnight: { hour: 0, minute: 0 },
};

// Closed lexicon (GH-650 follow-up): spelled-out Russian hour words 1-12 only, exactly the
// bare-hour ambiguity window. Not a general numeral parser — an hour above this range (or any
// other spelled-out number) stays unparseable rather than guessed.
const RUSSIAN_HOUR_WORDS: Readonly<Record<string, number>> = {
  один: 1,
  два: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
};

const PREFIX_SHAPE = /^(?:в|at)\s+/;

const CLOCK_SHAPE = /^(?:(?:в|at)\s+)?(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm|утра|дня|вечера|ночи))?$/;

type ClockShape =
  | { kind: 'literal'; hour: number; minute: number }
  | { kind: 'ambiguous_bare_hour'; hour: number }
  | { kind: 'out_of_range' }
  | { kind: 'unparseable' };

/** A day-part suffix pins the meaning; out-of-range hours for that suffix are rejected, not wrapped. */
function hourFromSuffix(hour: number, suffix: string): number | 'invalid' {
  if (suffix === 'am') return hour >= 1 && hour <= 12 ? hour % 12 : 'invalid';
  if (suffix === 'pm') return hour >= 1 && hour <= 12 ? (hour % 12) + 12 : 'invalid';
  // 1-11 covers the whole stated morning period, including the early "2 утра"/"3 утра" hours
  // that are grammatically identical to "2/3 ночи" — both forms are accepted, never rejected
  // just because a hand-picked "typical" sub-range excluded them (GH-650 follow-up).
  if (suffix === 'утра') return hour >= 1 && hour <= 11 ? hour : 'invalid';
  if (suffix === 'дня') return hour === 12 ? 12 : hour >= 1 && hour <= 6 ? hour + 12 : 'invalid';
  if (suffix === 'вечера') return hour >= 4 && hour <= 11 ? hour + 12 : 'invalid';
  if (suffix === 'ночи')
    return hour === 12 ? 0 : hour >= 1 && hour <= 5 ? hour : hour >= 9 && hour <= 11 ? hour + 12 : 'invalid';
  return 'invalid';
}

/** Replaces a bare Russian hour-word token ("два") with its digit ("2"); every other token is untouched. */
function substituteRussianHourWords(normalized: string): string {
  return normalized
    .split(' ')
    .map((token) => (Object.hasOwn(RUSSIAN_HOUR_WORDS, token) ? String(RUSSIAN_HOUR_WORDS[token]) : token))
    .join(' ');
}

function parseClockShape(normalized: string): ClockShape {
  // Word-times (полдень/noon/полночь/midnight) are looked up with the "в"/"at" prefix already
  // stripped — WORD_TIMES only stores the bare word, so "в полдень"/"at midnight" must be
  // stripped first or the lookup always misses (GH-650 follow-up). `Object.hasOwn` (not a
  // truthy/`in` check) guards against inherited Object.prototype members: an input that happens
  // to equal "constructor"/"__proto__"/"toString" must stay unparseable, never resolve to a
  // function value that then produces a false DST-gap result downstream.
  const stripped = normalized.replace(PREFIX_SHAPE, '');
  if (Object.hasOwn(WORD_TIMES, stripped)) {
    const word = WORD_TIMES[stripped]!;
    return { kind: 'literal', hour: word.hour, minute: word.minute };
  }

  const match = CLOCK_SHAPE.exec(substituteRussianHourWords(normalized));
  if (!match) return { kind: 'unparseable' };
  const hour = Number(match[1]);
  const minuteText = match[2];
  const suffix = match[3];

  if (suffix) {
    if (minuteText !== undefined && Number(minuteText) > 59) return { kind: 'out_of_range' };
    const resolved = hourFromSuffix(hour, suffix);
    return resolved === 'invalid'
      ? { kind: 'out_of_range' }
      : { kind: 'literal', hour: resolved, minute: Number(minuteText ?? 0) };
  }

  if (minuteText !== undefined) {
    const minute = Number(minuteText);
    return hour > 23 || minute > 59 ? { kind: 'out_of_range' } : { kind: 'literal', hour, minute };
  }

  // Bare digits, no colon, no suffix.
  if (hour > 23) return { kind: 'out_of_range' };
  if (hour === 0 || hour >= 13) return { kind: 'literal', hour, minute: 0 };
  return { kind: 'ambiguous_bare_hour', hour };
}

function parseSelectedDate(text: string): CalendarDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

function bareHourCandidates(hour: number): readonly [string, string] {
  const base = hour % 12;
  return [`${String(base).padStart(2, '0')}:00`, `${String(base + 12).padStart(2, '0')}:00`];
}
/** Whether `Intl` can resolve this as a real IANA zone; guards `resolveWallInstant` against throwing. */
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function parseWallTimeInput(rawInput: string, ctx: WallTimeContext): WallTimeOutcome {
  if (ctx.pendingField !== 'time') return { decision: 'unhandled', reason: 'not_pending_time' };

  const day = parseSelectedDate(ctx.selectedDate);
  if (!day || !validCalendarDay(day)) return { decision: 'invalid', reason: 'calendar_date_does_not_exist' };
  if (!isValidTimezone(ctx.timezone)) return { decision: 'invalid', reason: 'invalid_timezone' };

  const normalized = rawInput.trim().toLowerCase().replace(/\s+/g, ' ');

  if (ALL_DAY_PHRASES.has(normalized)) {
    const schedule: Schedule = { kind: 'all_day', startDate: isoDay(day), endDateExclusive: isoDay(addOneDay(day)) };
    return { decision: 'accepted', schedule };
  }
  if (UNKNOWN_TIME_PHRASES.has(normalized)) return { decision: 'clarify', reason: 'unknown_time_is_not_all_day' };

  const clock = parseClockShape(normalized);
  if (clock.kind === 'unparseable') return { decision: 'invalid', reason: 'unparseable' };
  if (clock.kind === 'out_of_range') return { decision: 'invalid', reason: 'explicit_date_or_time_repair' };
  if (clock.kind === 'ambiguous_bare_hour')
    return { decision: 'ambiguous', reason: 'bare_hour', candidates: bareHourCandidates(clock.hour) };

  const resolved = resolveWallInstant(day, clock.hour, clock.minute, ctx.timezone);
  if (resolved.kind === 'gap') return { decision: 'invalid', reason: 'nonexistent_local_time' };
  if (resolved.kind === 'fold') {
    const candidates: readonly [string, string] = [
      formatOffsetInstant(day, clock.hour, clock.minute, resolved.instants[0].offsetMinutes),
      formatOffsetInstant(day, clock.hour, clock.minute, resolved.instants[1].offsetMinutes),
    ];
    return { decision: 'ambiguous', reason: 'repeated_local_time', candidates };
  }
  return { decision: 'accepted', schedule: { kind: 'timed', startAt: new Date(resolved.ms).toISOString() } };
}
