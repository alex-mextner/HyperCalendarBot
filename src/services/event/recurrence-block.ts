// src/services/event/recurrence-block.ts
//
// Single source of truth for parsing, normalizing and validating the multi-line
// RRULE/EXDATE/RDATE block stored in `events.recurrence_rule`. Used by expandRecurrence, the
// ICS generator/parser and the Google event mapper — one parser for every consumer, per
// docs/superpowers/specs/2026-09-28-recurrence-semantics-583.md §2/§8.
//
// Historical bug (spec §1): three writers put three incompatible shapes into the same
// column — a bare RRULE body with no prefix (local /add, AI tool), Google's already-prefixed
// multi-line block (`RRULE:...\nEXDATE:...\nRDATE:...`), and ICS import's RRULE-only single
// line with EXDATE/RDATE dropped entirely. Every reader independently guessed at the shape by
// checking for an `RRULE:` prefix and kept only that one line, so EXDATE/RDATE were silently
// dropped end to end and a Google-synced rule double-prefixed on ICS export
// (`RRULE:RRULE:...`). This module reads the full block once, in one place.
import { resolveWallClock } from './wall-clock.ts';

export type RecurrenceValueKind = 'date' | 'date-time';

export type RecurrenceRejectReason =
  | 'missing_rrule'
  | 'multi_rrule_unsupported'
  | 'exrule_unsupported'
  | 'value_type_mismatch'
  | 'count_and_until_conflict'
  | 'count_out_of_range'
  | 'invalid_rrule_syntax';

/** Same cap the /add wizard already enforces on a typed COUNT (`add-event.scene.ts`) —
 * applied here too so ICS import, Google sync and the AI tool (none of which go through the
 * wizard's own check) can't hand expandRecurrence's COUNT-driven generation loop an
 * attacker-controlled iteration count (security review finding, #657). */
export const MAX_RECURRENCE_COUNT = 999;

/** Thrown instead of silently taking the first RRULE line or dropping EXDATE/RDATE — every
 * reject reason names an RFC 5545 construct this engine explicitly does not support. */
export class RecurrenceUnsupportedError extends Error {
  readonly reason: RecurrenceRejectReason;
  constructor(reason: RecurrenceRejectReason, message: string) {
    super(message);
    this.name = 'RecurrenceUnsupportedError';
    this.reason = reason;
  }
}

export interface ParsedRecurrenceBlock {
  /** Canonical prefixed lines: RRULE first, then EXDATE/RDATE lines in original order. */
  lines: string[];
  rruleLine: string;
  exdateLines: string[];
  rdateLines: string[];
  hasExceptionLines: boolean;
}

const RECOGNIZED_PROPS = new Set(['RRULE', 'EXRULE', 'EXDATE', 'RDATE']);

function propNameOf(line: string): string {
  const colonIdx = line.indexOf(':');
  const head = colonIdx >= 0 ? line.slice(0, colonIdx) : line;
  return (head.split(';')[0] ?? '').trim().toUpperCase();
}

/**
 * Normalize a raw stored `recurrence_rule` value into canonical prefixed lines. A value with
 * no recognized property prefix is the legacy bare-body shape (`"FREQ=WEEKLY;COUNT=6"`,
 * written by /add and the AI tool with no `RRULE:` prefix) and is wrapped as a single RRULE
 * line; a value that already carries prefixes (Google sync, ICS import, or this engine's own
 * canonical output) is split as-is, line by line.
 */
export function normalizeRecurrenceLines(raw: string): string[] {
  const rawLines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (rawLines.length === 0) return [];
  const anyRecognizedPrefix = rawLines.some((l) => RECOGNIZED_PROPS.has(propNameOf(l)));
  if (!anyRecognizedPrefix) return [`RRULE:${rawLines.join(';')}`];
  return rawLines;
}

function isDateOnlyToken(token: string): boolean {
  return /^\d{8}$/.test(token.trim());
}

function lineValueKind(line: string): RecurrenceValueKind {
  const colonIdx = line.indexOf(':');
  const head = colonIdx >= 0 ? line.slice(0, colonIdx) : '';
  const value = colonIdx >= 0 ? line.slice(colonIdx + 1) : '';
  // Read the VALUE parameter from the structured param list (split on `;`), not a regex over
  // the raw header: `/;VALUE=DATE\b/` also matches ";VALUE=DATE-TIME" because `\b` only needs
  // a word/non-word transition, and "-" right after "DATE" already satisfies that — see #657.
  const params = head.split(';').slice(1);
  const valueParam = params.find((p) => p.toUpperCase().startsWith('VALUE='));
  if (valueParam) {
    const kind = valueParam.slice('VALUE='.length).toUpperCase();
    if (kind === 'DATE') return 'date';
    if (kind === 'DATE-TIME') return 'date-time';
  }
  const firstToken = value.split(',')[0] ?? '';
  return isDateOnlyToken(firstToken) ? 'date' : 'date-time';
}

/**
 * Parse and validate a raw `recurrence_rule` value against the DTSTART value kind
 * (`'date'` for an all-day series, `'date-time'` otherwise). Throws `RecurrenceUnsupportedError`
 * rather than silently picking a line or coercing a mismatched value type — see spec §9.
 */
export function parseRecurrenceBlock(raw: string, dtstartValueKind: RecurrenceValueKind): ParsedRecurrenceBlock {
  const lines = normalizeRecurrenceLines(raw);

  const rruleLines = lines.filter((l) => propNameOf(l) === 'RRULE');
  const exruleLines = lines.filter((l) => propNameOf(l) === 'EXRULE');
  const exdateLines = lines.filter((l) => propNameOf(l) === 'EXDATE');
  const rdateLines = lines.filter((l) => propNameOf(l) === 'RDATE');

  if (exruleLines.length > 0) {
    throw new RecurrenceUnsupportedError(
      'exrule_unsupported',
      'EXRULE is deprecated by RFC 5545 Appendix A.3.1 and is not applied.',
    );
  }
  if (rruleLines.length === 0) {
    throw new RecurrenceUnsupportedError('missing_rrule', 'recurrence_rule has no RRULE line.');
  }
  if (rruleLines.length > 1) {
    throw new RecurrenceUnsupportedError(
      'multi_rrule_unsupported',
      `RFC 5545 Appendix A.1.2 does not define semantics for multiple RRULE lines on one series (found ${rruleLines.length}); rejected, not first-line-wins.`,
    );
  }
  const rruleLine = rruleLines[0]!;
  const rruleBody = rruleLine.slice(rruleLine.indexOf(':') + 1);
  if (/(^|;)COUNT=/.test(rruleBody) && /(^|;)UNTIL=/.test(rruleBody)) {
    throw new RecurrenceUnsupportedError('count_and_until_conflict', 'RRULE cannot set both COUNT and UNTIL.');
  }
  const countMatch = /(?:^|;)COUNT=(\d+)/i.exec(rruleBody);
  if (countMatch) {
    const count = Number(countMatch[1]);
    if (!Number.isFinite(count) || count < 1 || count > MAX_RECURRENCE_COUNT) {
      throw new RecurrenceUnsupportedError(
        'count_out_of_range',
        `COUNT must be between 1 and ${MAX_RECURRENCE_COUNT} (found ${countMatch[1]}).`,
      );
    }
  }

  for (const line of [...exdateLines, ...rdateLines]) {
    const kind = lineValueKind(line);
    if (kind !== dtstartValueKind) {
      throw new RecurrenceUnsupportedError(
        'value_type_mismatch',
        `${propNameOf(line)} value type (${kind}) does not match the series DTSTART value type (${dtstartValueKind}).`,
      );
    }
  }

  return {
    lines: [rruleLine, ...exdateLines, ...rdateLines],
    rruleLine,
    exdateLines,
    rdateLines,
    hasExceptionLines: exdateLines.length > 0 || rdateLines.length > 0,
  };
}

/**
 * Parse one EXDATE/RDATE line's comma-separated value list into real UTC instants — used by
 * `expandRecurrence`'s DST-aware path, which applies EXDATE/RDATE itself against the resolved
 * (post-DST) occurrence instant rather than handing them to rrule's own exdate/rdate matching
 * (rrule's DTSTART is fed a "fake-UTC" *local* wall-clock reading there — see recurrence.ts —
 * so its internal instant comparisons would never line up with these real-instant values).
 * DATE-only tokens (all-day `VALUE=DATE`) resolve to UTC midnight of that calendar date.
 */
export function parseRecurrenceDateTokens(line: string): Date[] {
  const colonIdx = line.indexOf(':');
  const head = colonIdx >= 0 ? line.slice(0, colonIdx) : '';
  const valuePart = colonIdx >= 0 ? line.slice(colonIdx + 1) : '';
  const params = head.split(';').slice(1);
  const tzidParam = params.find((p) => p.toUpperCase().startsWith('TZID='));
  const tzid = tzidParam ? tzidParam.slice(5) : undefined;
  const isDateValue = params.some((p) => p.toUpperCase() === 'VALUE=DATE');

  return valuePart
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => parseOneRecurrenceDateToken(token, tzid, isDateValue));
}

function parseOneRecurrenceDateToken(token: string, tzid: string | undefined, isDateValue: boolean): Date {
  if (isDateValue || token.length === 8) {
    const y = Number(token.slice(0, 4));
    const mo = Number(token.slice(4, 6));
    const d = Number(token.slice(6, 8));
    return new Date(Date.UTC(y, mo - 1, d));
  }
  const y = Number(token.slice(0, 4));
  const mo = Number(token.slice(4, 6));
  const d = Number(token.slice(6, 8));
  const h = Number(token.slice(9, 11));
  const mi = Number(token.slice(11, 13));
  const s = Number(token.slice(13, 15));
  if (token.endsWith('Z')) return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (tzid) {
    const resolution = resolveWallClock({ y, mo, d, h, mi, s }, tzid);
    if (resolution.kind === 'unique') return resolution.instant;
    if (resolution.kind === 'ambiguous') return resolution.first;
    // Gap: no real instant exists for this reading — fall back to the naive UTC interpretation
    // rather than fail the whole expansion over one malformed exception date.
    return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  }
  // No Z, no TZID — floating local time with no declared zone: treat as UTC, the same
  // fallback convention ics/parser.ts uses for DTSTART/DTEND without timezone info.
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}
