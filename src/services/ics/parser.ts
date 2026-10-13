// src/services/ics/parser.ts
import { TZDate } from '@date-fns/tz';
import { logger } from '../../utils/logger.ts';
import { parseRecurrenceBlock, RecurrenceUnsupportedError } from '../event/recurrence-block.ts';

const icsParserLogger = logger.child({ module: 'ics-parser' });

export interface IcsEvent {
  title: string;
  start_at: string;
  end_at?: string;
  description?: string;
  location?: string;
  recurrence_rule?: string;
  /** Set instead of `recurrence_rule` when the VEVENT's recurrence lines are explicitly
   * unsupported (multiple RRULE, EXRULE, or an EXDATE/RDATE value-type mismatch with DTSTART —
   * see spec §9) — the event still imports as a one-off rather than being silently dropped or
   * truncated to whichever RRULE line came first. */
  recurrenceUnsupportedReason?: string;
}

/**
 * Parse ICS (iCalendar) string into event objects.
 * Minimal parser — handles VEVENT blocks with basic properties.
 */
export function parseIcs(icsContent: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  const lines = unfoldIcsLines(icsContent);

  let inEvent = false;
  let current: Partial<IcsEvent> = {};
  let dtstartValueKind: 'date' | 'date-time' = 'date-time';
  let recurrenceLines: string[] = [];

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      current = {};
      dtstartValueKind = 'date-time';
      recurrenceLines = [];
      continue;
    }
    if (line === 'END:VEVENT') {
      inEvent = false;
      if (recurrenceLines.length > 0) {
        try {
          const parsed = parseRecurrenceBlock(recurrenceLines.join('\n'), dtstartValueKind);
          current.recurrence_rule = parsed.lines.join('\n');
        } catch (err) {
          const reason = err instanceof RecurrenceUnsupportedError ? err.reason : 'invalid_rrule_syntax';
          icsParserLogger.warn({ err, reason }, 'Skipping unsupported recurrence lines in ICS import');
          current.recurrenceUnsupportedReason = reason;
        }
      }
      if (current.title && current.start_at) {
        events.push(current as IcsEvent);
      }
      continue;
    }
    if (!inEvent) continue;

    const [key, ...valueParts] = line.split(':');
    const value = valueParts.join(':'); // Re-join in case value contains ':'
    const keyParts = key!.split(';');
    const propName = keyParts[0];

    // Extract TZID parameter if present (e.g. DTSTART;TZID=Europe/Berlin:20260312T150000)
    const tzidParam = keyParts.find((p) => p.startsWith('TZID='));
    const tzid = tzidParam ? tzidParam.slice(5) : undefined;

    switch (propName) {
      case 'SUMMARY':
        current.title = unescapeIcs(value);
        break;
      case 'DTSTART':
        current.start_at = icsDateToIso(value, tzid);
        dtstartValueKind = value.trim().length === 8 ? 'date' : 'date-time';
        break;
      case 'DTEND':
        current.end_at = icsDateToIso(value, tzid);
        break;
      case 'DESCRIPTION':
        current.description = unescapeIcs(value);
        break;
      case 'LOCATION':
        current.location = unescapeIcs(value);
        break;
      case 'RRULE':
      case 'EXRULE':
      case 'EXDATE':
      case 'RDATE':
        // Kept as the original line (property + params + value) — parseRecurrenceBlock reads
        // the full prefixed block once every VEVENT's lines are collected, at END:VEVENT.
        recurrenceLines.push(line);
        break;
    }
  }

  return events;
}

/** Unfold ICS line continuations (lines starting with space/tab) */
function unfoldIcsLines(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '') // Unfold continued lines
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Convert ICS date format to ISO 8601 UTC.
 * Handles: 20260312T150000Z (UTC), 20260312T150000 (with optional TZID), 20260312 (date-only)
 */
function icsDateToIso(icsDate: string, tzid?: string): string {
  const clean = icsDate.trim();
  if (clean.length === 8) {
    // Date only: YYYYMMDD — no timezone conversion needed
    return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T00:00:00Z`;
  }
  if (clean.length >= 15) {
    const d = `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}`;
    if (clean.endsWith('Z')) return `${d}Z`; // Already UTC
    if (tzid) {
      // Convert from local timezone to UTC using TZDate.tz factory
      // (string constructor interprets the string as UTC, which is wrong here)
      const [datePart, timePart] = d.split('T');
      const [y, mo, da] = datePart!.split('-').map(Number) as [number, number, number];
      const [h, mi, se] = timePart!.split(':').map(Number) as [number, number, number];
      const localDate = TZDate.tz(tzid, y, mo - 1, da, h, mi, se, 0);
      return new Date(localDate.getTime()).toISOString();
    }
    return `${d}Z`; // No timezone info — assume UTC as fallback
  }
  return clean;
}

function unescapeIcs(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
}
