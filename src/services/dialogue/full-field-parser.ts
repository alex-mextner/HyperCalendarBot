// src/services/dialogue/full-field-parser.ts
//
// Deterministic, zero-LLM full-field extractor for GH-652: given one turn of raw text (a
// full /add command line, or a natural-language starter phrase), pulls out as many
// event.create fields (registry.ts) as the closed grammar below recognizes in a single pass —
// title, date+time (via the shared, GH-650-fixed wall-time parser), people, place, all-day —
// so a fully specified request never has to re-ask for information it already contained
// (design §21). Anything not recognized is left in the title rather than guessed.
//
// Scope boundary (deliberate, not an oversight — mirrors GH-650's own "date-phrase
// unification is a deferred finding" precedent): the date-phrase grammar here is a small
// closed set (today/tomorrow/day-after-tomorrow/ISO yyyy-mm-dd, RU+EN) — NOT the full
// weekday/month-name grammar duplicated across parseWizardDate/parseSimpleDate/
// parseAbsoluteDay. Unifying those three is a separate, larger slice (see wall-time-parser.ts's
// own header comment); this module only needs "what date is the time-of-day phrase relative
// to", not a general date parser, and a request whose date phrase this grammar doesn't cover
// keeps that phrase in the title rather than mis-parsing it.
//
// Recurrence is intentionally NOT extracted here: GH-657 owns recurrence-phrase parsing and
// full RRULE semantics; the registry (`recurrence` field) only carries the contract that the
// field exists, not a grammar for it.

import { resolveWizardWallTime, type WallTimeResolution } from '../calendar/wall-time-adapters.ts';
import type { Schedule } from '../calendar/wall-time-parser.ts';
import type { NativeLocationInput, PeopleResolver, PersonCandidate, PlaceResolver } from './resolvers.ts';
import type { DraftPatch, DraftPerson } from './v3-types.ts';

export interface ParseContext {
  readonly timezone: string;
  /** Caller-supplied "now" — this module never reads the system clock itself. */
  readonly now: Date;
  readonly actorId: number;
  readonly peopleResolver: PeopleResolver;
  readonly placeResolver: PlaceResolver;
}

export interface FuzzyPersonMention {
  readonly rawName: string;
  readonly candidates: readonly PersonCandidate[];
}

export interface ParseResult {
  /** Whatever this pass resolved — apply on top of the existing draft, never replacing it. */
  readonly patch: DraftPatch;
  /**
   * The raw time-of-day resolution this turn produced, INCLUDING an ambiguous one (bare hour
   * or DST fold) — `patch.schedule` only ever carries a fully resolved value, so a caller that
   * needs to render the exact "02:00 / 14:00" (or DST-fold offset) buttons reads this field,
   * never re-derives them from `remainderText`.
   */
  readonly timeResolution: WallTimeResolution | null;
  /** Names mentioned that matched no contact at all — surfaced to the caller, never silently dropped. */
  readonly unresolvedPeopleNames: readonly string[];
  /** Names whose contact match needs explicit confirmation before being added (design §23). */
  readonly fuzzyPeople: readonly FuzzyPersonMention[];
  /** Text left after every recognized clause was stripped — the title candidate. */
  readonly remainderText: string;
  /** A closed negation marker was seen ("не"/"not"/"don't") — caller should not blindly append remainderText as-is. */
  readonly negated: boolean;
}

function isoDate(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`;
}

const DATE_PHRASE = /(?:^|\s)(послезавтра|day after tomorrow|завтра|tomorrow|сегодня|today|\d{4}-\d{2}-\d{2})(?=\s|$)/i;

/** Removes a recognized date phrase and returns the resolved selectedDate; defaults to today. */
function extractDate(text: string, ctx: ParseContext): { text: string; selectedDate: string } {
  const today = isoDate(ctx.now, ctx.timezone);
  const match = DATE_PHRASE.exec(text);
  if (!match) return { text, selectedDate: today };
  const token = match[1]!.toLowerCase();
  const isoMatch = /^\d{4}-\d{2}-\d{2}$/.exec(token);
  const selectedDate = isoMatch
    ? token
    : token === 'завтра' || token === 'tomorrow'
      ? addDaysIso(today, 1)
      : token === 'послезавтра' || token === 'day after tomorrow'
        ? addDaysIso(today, 2)
        : today; // сегодня/today
  const stripped = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/\s+/g, ' ').trim();
  return { text: stripped, selectedDate };
}

const ALL_DAY_PHRASE = /(?:^|\s)(весь день|на весь день|all day)(?=\s|$)/i;

function extractAllDay(text: string): { text: string; allDay: boolean } {
  const match = ALL_DAY_PHRASE.exec(text);
  if (!match) return { text, allDay: false };
  const stripped = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/\s+/g, ' ').trim();
  return { text: stripped, allDay: true };
}

interface Clause {
  readonly marker: string;
  readonly content: string;
  readonly start: number;
  readonly end: number;
}

/** Every "at X"/"в X" clause in left-to-right order, each running until the next such marker or end of string. */
function findMarkerClauses(text: string): Clause[] {
  const pattern = /(?:^|\s)(at|в)\s+(.+?)(?=\s+(?:at|в)\s+|$)/gi;
  const clauses: Clause[] = [];
  for (const match of text.matchAll(pattern)) {
    const content = match[2]!.trim();
    if (!content) continue;
    clauses.push({ marker: match[1]!, content, start: match.index, end: match.index + match[0].length });
  }
  return clauses;
}

function isTimeShaped(content: string, ctx: ParseContext, selectedDate: string): WallTimeResolution | null {
  const resolution = resolveWizardWallTime(content, { selectedDate, timezone: ctx.timezone });
  return resolution.kind === 'complete' ||
    resolution.kind === 'ambiguous_number' ||
    resolution.kind === 'ambiguous_instant'
    ? resolution
    : null;
}

function removeRange(text: string, start: number, end: number): string {
  return (text.slice(0, start) + text.slice(end)).replace(/\s+/g, ' ').trim();
}

/**
 * "at"/"в" introduces both a time clause ("at 14:00") and a place clause ("at the office") —
 * disambiguated by trying each clause, in order, as a time first; the first one that parses as
 * a time (accepted or still-ambiguous) IS the time clause, regardless of position, so a
 * trailing place clause after it is never swallowed into the time suffix scan. Any other
 * marker clause found (there is normally at most one) becomes the place. A bare time with no
 * "at"/"в" prefix at all (rare without a marker) falls back to a trailing-suffix scan, same
 * idea add.ts already uses for the legacy wizard.
 */
function extractTimeAndPlace(
  text: string,
  ctx: ParseContext,
  selectedDate: string,
): { text: string; resolution: WallTimeResolution | null; place: DraftPatch['place'] } {
  const clauses = findMarkerClauses(text);
  const timeClause = clauses.find((clause) => isTimeShaped(clause.content, ctx, selectedDate) !== null);
  const placeClause = clauses.find((clause) => clause !== timeClause);

  let resolution: WallTimeResolution | null = null;
  let remaining = text;
  const removals: Array<{ start: number; end: number }> = [];

  if (timeClause) {
    resolution = isTimeShaped(timeClause.content, ctx, selectedDate);
    removals.push(timeClause);
  }

  let place: DraftPatch['place'];
  if (placeClause) {
    const placeResolution = ctx.placeResolver.resolveManual(placeClause.content);
    if (placeResolution.kind !== 'unresolved') place = { kind: placeResolution.kind, label: placeResolution.label };
    removals.push(placeClause);
  }

  if (removals.length > 0) {
    for (const range of removals.sort((a, b) => b.start - a.start)) {
      remaining = removeRange(remaining, range.start, range.end);
    }
  } else {
    // No "at"/"в"-prefixed clause parsed as a time — fall back to a trailing-suffix scan
    // (same idea add.ts already uses for the legacy wizard) for a bare time with no marker.
    const boundaries = [0, ...[...text].map((c, i) => (c === ' ' ? i + 1 : -1)).filter((i) => i >= 0)].sort(
      (a, b) => a - b,
    );
    for (const start of boundaries) {
      const candidate = text.slice(start).trim();
      if (!candidate) continue;
      const candidateResolution = isTimeShaped(candidate, ctx, selectedDate);
      if (candidateResolution) {
        resolution = candidateResolution;
        remaining = text.slice(0, start).trim();
        break;
      }
    }
  }

  return { text: remaining, resolution, place };
}

const NEGATION_MARKERS = /(?:^|\s)(не|not|don'?t)(?=\s|$)/i;

const PEOPLE_MARKER = /(?:^|\s)(with|с)\s+(.+?)(?=\s+(?:at|в)\s|$)/i;

// `\b` is ASCII-\w-only in JS regex — it never fires around a Cyrillic letter surrounded by
// spaces (space and "и" are both non-\w, so there is no \w/non-\w transition to anchor on).
// Anchoring on whitespace/string-edges directly, same fix as the CLOCK_SHAPE prefix elsewhere.
function splitNames(raw: string): string[] {
  return raw
    .split(/\s*(?:,|(?:^|\s)and(?=\s|$)|(?:^|\s)и(?=\s|$))\s*/i)
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

function extractPeople(
  text: string,
  ctx: ParseContext,
): { text: string; resolved: DraftPerson[]; unresolved: string[]; fuzzy: FuzzyPersonMention[] } {
  const match = PEOPLE_MARKER.exec(text);
  if (!match) return { text, resolved: [], unresolved: [], fuzzy: [] };
  const names = splitNames(match[2]!);
  const resolved: DraftPerson[] = [];
  const unresolved: string[] = [];
  const fuzzy: FuzzyPersonMention[] = [];
  for (const rawName of names) {
    const resolution = ctx.peopleResolver.resolve(ctx.actorId, rawName);
    if (resolution.kind === 'exact') {
      resolved.push({
        contactId: resolution.contactId,
        telegramId: resolution.telegramId,
        displayName: resolution.displayName,
        confirmed: true,
      });
    } else if (resolution.kind === 'fuzzy') {
      fuzzy.push({ rawName, candidates: resolution.candidates });
    } else {
      unresolved.push(rawName);
    }
  }
  const stripped = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/\s+/g, ' ').trim();
  return { text: stripped, resolved, unresolved, fuzzy };
}

export function parseFullField(rawText: string, ctx: ParseContext): ParseResult {
  const negated = NEGATION_MARKERS.test(rawText);
  let text = rawText.trim();

  const dateResult = extractDate(text, ctx);
  text = dateResult.text;

  const allDayResult = extractAllDay(text);
  text = allDayResult.text;

  const peopleResult = extractPeople(text, ctx);
  text = peopleResult.text;

  let schedule: Schedule | undefined;
  let place: DraftPatch['place'];
  let timeResolution: WallTimeResolution | null = null;
  if (allDayResult.allDay) {
    const timed = resolveWizardWallTime('весь день', { selectedDate: dateResult.selectedDate, timezone: ctx.timezone });
    timeResolution = timed;
    if (timed.kind === 'complete') schedule = timed.schedule;
  } else {
    const result = extractTimeAndPlace(text, ctx, dateResult.selectedDate);
    text = result.text;
    place = result.place;
    timeResolution = result.resolution;
    if (result.resolution?.kind === 'complete') schedule = result.resolution.schedule;
  }

  const remainderText = text.trim();

  const patch: DraftPatch = {};
  if (remainderText.length > 0) patch.title = remainderText;
  if (schedule) patch.schedule = schedule;
  if (peopleResult.resolved.length > 0) patch.people = peopleResult.resolved;
  if (place) patch.place = place;

  return {
    patch,
    timeResolution,
    unresolvedPeopleNames: peopleResult.unresolved,
    fuzzyPeople: peopleResult.fuzzy,
    remainderText,
    negated,
  };
}

/** Re-exported so callers building an AddEventParams-style entry point never import wall-time-adapters twice. */
export type { NativeLocationInput };
