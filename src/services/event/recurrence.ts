import { TZDate } from '@date-fns/tz';
import type { RRule, RRuleSet } from 'rrule';
import { rrulestr } from 'rrule';
import type { CalendarEvent, EventOccurrence } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';
import { parseRecurrenceBlock, parseRecurrenceDateTokens, RecurrenceUnsupportedError } from './recurrence-block.ts';
import { resolveWallClock, toLocalDateKey, wallClockAt, wallClockFromFakeUtc } from './wall-clock.ts';

export { RecurrenceUnsupportedError } from './recurrence-block.ts';

const recurrenceLogger = logger.child({ module: 'recurrence' });

/** Pad range by ±3h to catch occurrences that shift across boundaries after DST adjustment
 * (used only by the legacy pre-583 rollback engine, `expandLegacy`). */
const DST_PAD_MS = 3 * 60 * 60_000;
/** Pad the coarse rrule fetch window by ±2 days in the DST-aware path so a query range
 * boundary can never lose an occurrence to the offset between "fake-local" rrule generation
 * space and the real UTC query range — every IANA zone's UTC offset plus its DST shift is
 * well under 24h, so 2 days is a generous, safe margin. Occurrences are re-filtered precisely
 * against the real [rangeStart, rangeEnd] after DST resolution, so over-fetching is harmless. */
const DST_FETCH_PAD_MS = 2 * 24 * 60 * 60_000;

export interface ExpandRecurrenceOptions {
  /**
   * Capability-gated rollout (spec §10). When true, expansion uses the pre-583 engine that
   * reads only the single `RRULE:` line, ignores EXDATE/RDATE and matches exceptions by local
   * calendar date — exactly today's production behavior. A series whose `recurrence_rule`
   * already carries EXDATE/RDATE (every Google-synced series with a deleted instance) keeps
   * displaying as it does today; hiding it would drop whole series from agenda, free/busy and
   * reminders while the new engine is off.
   */
  legacyEngine?: boolean;
}

export interface RecurrenceExpansionResult {
  occurrences: EventOccurrence[];
  /** Local dates (YYYY-MM-DD) where a fall-back DST repeat produced two candidate instants,
   * both included in `occurrences`, with no exception yet fixing which one is intended. */
  ambiguousLocalDates: string[];
  /** Local dates (YYYY-MM-DD) where the template's wall-clock time falls in a spring-forward
   * DST gap and no instant exists; the occurrence is omitted rather than silently shifted. */
  nonexistentLocalDates: string[];
  /** Exception rows flagged `identity_status = 'unresolved'` by the identity migration
   * (spec §10): their own current start_at is still shown if it falls in range, but they are
   * never guessed onto a specific template occurrence. */
  unresolvedExceptionIds: number[];
}

/**
 * Expand a recurring template into concrete occurrences within [rangeStartUtc, rangeEndUtc],
 * applying EXDATE/RDATE and exceptions. The single expansion service for calendar
 * preview/agenda, free/busy, Google/ICS round-trip checks and reminder materialization — see
 * docs/superpowers/specs/2026-09-28-recurrence-semantics-583.md.
 */
export function expandRecurrence(
  template: CalendarEvent,
  exceptions: CalendarEvent[],
  rangeStartUtc: string,
  rangeEndUtc: string,
  options: ExpandRecurrenceOptions = {},
): RecurrenceExpansionResult {
  if (!template.recurrence_rule) {
    return { occurrences: [], ambiguousLocalDates: [], nonexistentLocalDates: [], unresolvedExceptionIds: [] };
  }

  const dtstart = new Date(template.start_at);
  if (Number.isNaN(dtstart.getTime())) {
    recurrenceLogger.warn(
      { eventId: template.id, startAt: template.start_at },
      'Skipping event with invalid start_at date',
    );
    return { occurrences: [], ambiguousLocalDates: [], nonexistentLocalDates: [], unresolvedExceptionIds: [] };
  }

  if (options.legacyEngine) {
    return {
      occurrences: expandLegacy(template, exceptions, rangeStartUtc, rangeEndUtc),
      ambiguousLocalDates: [],
      nonexistentLocalDates: [],
      unresolvedExceptionIds: [],
    };
  }

  const dtstartValueKind = template.all_day ? 'date' : 'date-time';
  const parsed = parseRecurrenceBlock(template.recurrence_rule, dtstartValueKind);

  const rangeStart = new Date(rangeStartUtc);
  const rangeEnd = new Date(rangeEndUtc);
  const adjustDst = !template.all_day && !!template.timezone;

  const durationMs = template.end_at ? new Date(template.end_at).getTime() - dtstart.getTime() : 0;

  const ambiguousLocalDates = new Set<string>();
  const nonexistentLocalDates = new Set<string>();
  const resolvedInstants: Date[] = [];

  if (adjustDst) {
    // rrule expands in pure UTC — its TZID output is system-timezone-dependent. DTSTART is fed
    // the template's TRUE local wall-clock reading (fake-UTC — see wallClockFromFakeUtc), so
    // FREQ/BYDAY/BYHOUR arithmetic runs in local-time space (matching "every day at 10:00 and
    // 14:00 local"), and resolveWallClock() converts each generated occurrence back to a real
    // UTC instant, handling DST gaps/repeats itself. EXDATE/RDATE are different: they store the
    // exact original occurrence *instant* (spec §5), i.e. real UTC values — rrule's own
    // exdate/rdate matching would compare them against fake-local dates and never line up, so
    // they are applied below, against the resolved real instant, instead of handed to rrule.
    //
    // A repeated wall-clock reading (fall-back) denotes its first occurrence by default —
    // COUNT counts it once, not twice; an explicit RDATE or exception targeting the exact
    // second instant is the only way to also surface it. `ambiguousLocalDates` still records
    // every collision for a caller that wants to offer disambiguation.
    const dtstartWall = wallClockAt(dtstart, template.timezone);
    const dtstartFakeUtc = new Date(
      Date.UTC(dtstartWall.y, dtstartWall.mo - 1, dtstartWall.d, dtstartWall.h, dtstartWall.mi, dtstartWall.s),
    );

    // COUNT is an exact target the user configured; RFC 5545 leaves DST handling to the
    // implementation, and a wall-clock gap must not silently consume one of them (spec §3 /
    // #657 acceptance criteria: "skip the nonexistent time without consuming a repetition").
    // COUNT is stripped from the rule text fed to rrule — its own internal cutoff would count
    // the (invalid) gap occurrence — and generation instead continues, driven by this
    // function, until exactly COUNT *valid* instants are collected. UNTIL-bounded and
    // unbounded rules have no such "exact target"; they use the simpler windowed fetch below,
    // where a gap is simply omitted.
    const rruleBodyForCount = parsed.rruleLine.slice(parsed.rruleLine.indexOf(':') + 1);
    const countMatch = /(?:^|;)COUNT=(\d+)/i.exec(rruleBodyForCount);
    const targetCount = countMatch ? Number(countMatch[1]) : null;
    const rruleLineForGeneration = targetCount === null ? parsed.rruleLine : stripCount(parsed.rruleLine);

    let rule: RRule;
    try {
      rule = rrulestr(`DTSTART:${formatRRuleDate(dtstartFakeUtc)}\n${rruleLineForGeneration}`) as RRule;
    } catch (err) {
      throw new RecurrenceUnsupportedError(
        'invalid_rrule_syntax',
        `Failed to parse recurrence rule: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (targetCount !== null) {
      const maxIterations = targetCount * 20 + 200; // generous safety cap, never unbounded
      let iterations = 0;
      rule.all((raw) => {
        iterations++;
        if (resolvedInstants.length >= targetCount || iterations > maxIterations) return false;
        const wall = wallClockFromFakeUtc(raw);
        const localKey = `${wall.y}-${String(wall.mo).padStart(2, '0')}-${String(wall.d).padStart(2, '0')}`;
        const resolution = resolveWallClock(wall, template.timezone);
        if (resolution.kind === 'gap') {
          nonexistentLocalDates.add(localKey);
          return true; // does not consume a place in COUNT
        }
        if (resolution.kind === 'ambiguous') {
          ambiguousLocalDates.add(localKey);
          resolvedInstants.push(resolution.first);
          return resolvedInstants.length < targetCount;
        }
        resolvedInstants.push(resolution.instant);
        return resolvedInstants.length < targetCount;
      });
    } else {
      // Query range boundaries, reinterpreted in the same fake-local space as DTSTART. Padded
      // generously — any single IANA zone's UTC offset plus DST shift is well under 24h — so
      // the coarse rrule fetch can never lose a boundary occurrence; results are re-filtered
      // precisely against the real [rangeStart, rangeEnd] after DST resolution, below.
      const paddedStartWall = wallClockAt(new Date(rangeStart.getTime() - DST_FETCH_PAD_MS), template.timezone);
      const paddedEndWall = wallClockAt(new Date(rangeEnd.getTime() + DST_FETCH_PAD_MS), template.timezone);
      const paddedStartFake = new Date(
        Date.UTC(
          paddedStartWall.y,
          paddedStartWall.mo - 1,
          paddedStartWall.d,
          paddedStartWall.h,
          paddedStartWall.mi,
          paddedStartWall.s,
        ),
      );
      const paddedEndFake = new Date(
        Date.UTC(
          paddedEndWall.y,
          paddedEndWall.mo - 1,
          paddedEndWall.d,
          paddedEndWall.h,
          paddedEndWall.mi,
          paddedEndWall.s,
        ),
      );
      const rawDates = rule.between(paddedStartFake, paddedEndFake, true);

      for (const raw of rawDates) {
        const wall = wallClockFromFakeUtc(raw);
        const localKey = `${wall.y}-${String(wall.mo).padStart(2, '0')}-${String(wall.d).padStart(2, '0')}`;
        const resolution = resolveWallClock(wall, template.timezone);
        if (resolution.kind === 'gap') {
          nonexistentLocalDates.add(localKey);
          continue;
        }
        if (resolution.kind === 'ambiguous') {
          ambiguousLocalDates.add(localKey);
          resolvedInstants.push(resolution.first);
          continue;
        }
        resolvedInstants.push(resolution.instant);
      }
    }

    const excludeMs = new Set<number>();
    for (const line of parsed.exdateLines) {
      for (const instant of parseRecurrenceDateTokens(line)) excludeMs.add(instant.getTime());
    }
    const filtered = resolvedInstants.filter((instant) => !excludeMs.has(instant.getTime()));
    const seenMs = new Set(filtered.map((d) => d.getTime()));
    for (const line of parsed.rdateLines) {
      for (const instant of parseRecurrenceDateTokens(line)) {
        if (seenMs.has(instant.getTime())) continue;
        filtered.push(instant);
        seenMs.add(instant.getTime());
      }
    }
    resolvedInstants.length = 0;
    resolvedInstants.push(...filtered);
  } else {
    const ruleSetString = [`DTSTART:${formatRRuleDate(dtstart)}`, ...parsed.lines].join('\n');
    let ruleSet: RRuleSet;
    try {
      ruleSet = rrulestr(ruleSetString, { forceset: true }) as RRuleSet;
    } catch (err) {
      throw new RecurrenceUnsupportedError(
        'invalid_rrule_syntax',
        `Failed to parse recurrence rule: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    resolvedInstants.push(...ruleSet.between(rangeStart, rangeEnd, true));
  }

  // Index resolvable exceptions by their exact original instant (spec §5: exception identity
  // is the exact original instant, not a calendar day). Exceptions the identity migration
  // could not resolve unambiguously (`identity_status === 'unresolved'`) are never matched
  // here — conservative per spec §10, they fall through to the "own start_at" pass below.
  const exactMap = new Map<number, CalendarEvent>();
  const unresolvedExceptionIds: number[] = [];
  for (const exc of exceptions) {
    if (!exc.original_start_at) continue;
    if (exc.identity_status === 'unresolved') {
      unresolvedExceptionIds.push(exc.id);
      continue;
    }
    const ms = Date.parse(exc.original_start_at);
    if (!Number.isNaN(ms)) exactMap.set(ms, exc);
  }

  const occurrences: EventOccurrence[] = [];
  const matchedExceptionIds = new Set<number>();

  for (const instant of resolvedInstants) {
    if (instant.getTime() < rangeStart.getTime() || instant.getTime() > rangeEnd.getTime()) continue;

    const exception = exactMap.get(instant.getTime());
    if (exception) {
      matchedExceptionIds.add(exception.id);
      if (exception.is_cancelled) continue;
      const excStartMs = Date.parse(exception.start_at);
      // Moved out of the requested range (spec §5): the occurrence no longer belongs here —
      // show it only at its new position, not still parked at the template's old slot.
      if (Number.isNaN(excStartMs) || excStartMs < rangeStart.getTime() || excStartMs > rangeEnd.getTime()) continue;
      occurrences.push({
        event: exception,
        occurrence_start: exception.start_at,
        occurrence_end: exception.end_at ?? (durationMs ? new Date(excStartMs + durationMs).toISOString() : null),
        is_exception: true,
      });
      continue;
    }

    const occEnd = durationMs ? new Date(instant.getTime() + durationMs).toISOString() : null;
    occurrences.push({
      event: template,
      occurrence_start: instant.toISOString(),
      occurrence_end: occEnd,
      is_exception: false,
    });
  }

  // Exceptions not matched to a generated occurrence in this call: either their original
  // instant sits outside [rangeStart, rangeEnd] (moved in/out of range — spec §5) or their
  // identity is unresolved (legacy ambiguous match — spec §10). Either way, the exception is a
  // real row the user created or Google/ICS sent; show it at its own current start_at when
  // that falls in range instead of silently dropping it, and never attach it to a guessed
  // occurrence.
  for (const exc of exceptions) {
    if (matchedExceptionIds.has(exc.id) || exc.is_cancelled) continue;
    const excStartMs = Date.parse(exc.start_at);
    if (Number.isNaN(excStartMs) || excStartMs < rangeStart.getTime() || excStartMs > rangeEnd.getTime()) continue;
    occurrences.push({
      event: exc,
      occurrence_start: exc.start_at,
      occurrence_end: exc.end_at ?? (durationMs ? new Date(excStartMs + durationMs).toISOString() : null),
      is_exception: true,
    });
  }

  return {
    occurrences: occurrences.sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start)),
    ambiguousLocalDates: [...ambiguousLocalDates],
    nonexistentLocalDates: [...nonexistentLocalDates],
    unresolvedExceptionIds,
  };
}

/**
 * Pre-583 engine, preserved verbatim for the capability-gated rollback (spec §10). Reads only
 * the first `RRULE:` line, ignores EXDATE/RDATE, and matches exceptions by local calendar date
 * — every limitation this file's docstring and the spec describe as the bug being fixed.
 * Callers only reach this path with `options.legacyEngine: true`.
 */
function expandLegacy(
  template: CalendarEvent,
  exceptions: CalendarEvent[],
  rangeStartUtc: string,
  rangeEndUtc: string,
): EventOccurrence[] {
  const dtstart = new Date(template.start_at);
  const rruleLine =
    template.recurrence_rule!.split('\n').find((line) => line.startsWith('RRULE:')) ?? template.recurrence_rule!;
  const rruleString = `DTSTART:${formatRRuleDate(dtstart)}\n${rruleLine}`;
  const rule = rrulestr(rruleString);

  const adjustDst = !template.all_day && !!template.timezone;
  let localH = 0;
  let localM = 0;
  let localS = 0;
  if (adjustDst) {
    const tz = new TZDate(dtstart, template.timezone);
    localH = tz.getHours();
    localM = tz.getMinutes();
    localS = tz.getSeconds();
  }

  const durationMs = template.end_at ? new Date(template.end_at).getTime() - dtstart.getTime() : 0;

  const exceptionMap = new Map<string, CalendarEvent>();
  for (const exc of exceptions) {
    if (exc.original_start_at) {
      const key = adjustDst
        ? toLocalDateKey(new Date(exc.original_start_at), template.timezone)
        : new Date(exc.original_start_at).toISOString();
      exceptionMap.set(key, exc);
    }
  }

  const rangeStart = new Date(rangeStartUtc);
  const rangeEnd = new Date(rangeEndUtc);
  const paddedStart = adjustDst ? new Date(rangeStart.getTime() - DST_PAD_MS) : rangeStart;
  const paddedEnd = adjustDst ? new Date(rangeEnd.getTime() + DST_PAD_MS) : rangeEnd;
  const dates = rule.between(paddedStart, paddedEnd, true);

  const occurrences: EventOccurrence[] = [];
  for (const date of dates) {
    const utcDate = adjustDst ? legacyAdjustForDst(date, template.timezone, localH, localM, localS) : date;
    if (utcDate.getTime() < rangeStart.getTime() || utcDate.getTime() > rangeEnd.getTime()) continue;

    const occStart = utcDate.toISOString();
    const occKey = adjustDst ? toLocalDateKey(utcDate, template.timezone) : occStart;
    const exception = exceptionMap.get(occKey);

    if (exception) {
      if (exception.is_cancelled) continue;
      const occEnd =
        exception.end_at ??
        (durationMs ? new Date(new Date(exception.start_at).getTime() + durationMs).toISOString() : null);
      occurrences.push({
        event: exception,
        occurrence_start: exception.start_at,
        occurrence_end: occEnd,
        is_exception: true,
      });
    } else {
      const occEnd = durationMs ? new Date(utcDate.getTime() + durationMs).toISOString() : null;
      occurrences.push({ event: template, occurrence_start: occStart, occurrence_end: occEnd, is_exception: false });
    }
  }

  return occurrences.sort((a, b) => a.occurrence_start.localeCompare(b.occurrence_start));
}

/** Format a UTC Date for rrule DTSTART (e.g. `20260301T090000Z`) */
function formatRRuleDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Remove the COUNT= parameter from a prefixed RRULE line, keeping every other parameter.
 * Case-insensitive to match the COUNT detection above — RFC 5545 property/parameter names
 * are case-insensitive (§3.1). */
function stripCount(rruleLine: string): string {
  const colonIdx = rruleLine.indexOf(':');
  const prefix = rruleLine.slice(0, colonIdx + 1);
  const body = rruleLine.slice(colonIdx + 1);
  return (
    prefix +
    body
      .split(';')
      .filter((p) => !/^count=/i.test(p))
      .join(';')
  );
}

/** Legacy fixed-time DST adjustment (pre-583 `adjustOccurrenceForDst`) — see `expandLegacy`.
 * Builds the wall-clock date in its own zone: seeding with midnight UTC first would move
 * negative-offset zones onto the previous local calendar day. */
function legacyAdjustForDst(date: Date, timezone: string, h: number, m: number, s: number): Date {
  const occTz = new TZDate(date, timezone);
  const local = new TZDate(occTz.getFullYear(), occTz.getMonth(), occTz.getDate(), h, m, s, 0, timezone);
  return new Date(local.getTime());
}
