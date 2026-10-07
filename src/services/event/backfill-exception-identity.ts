// src/services/event/backfill-exception-identity.ts
//
// One-time migration backfill (migration 066) for the exception-identity change in
// docs/superpowers/specs/2026-09-28-recurrence-semantics-583.md §5/§10: exception identity is
// now the exact original occurrence instant, not a local calendar date. Every existing
// exception row (`events.parent_event_id IS NOT NULL`) is checked against its parent
// template's own occurrence set on the exception's local calendar date:
//   - exactly one matching template occurrence → `original_start_at` is rewritten to that
//     occurrence's exact instant (a no-op if it already matches);
//   - zero or more than one matching occurrence → `identity_status` is flagged 'unresolved'
//     instead of guessing; `expandRecurrence` never attaches an unresolved exception to a
//     specific occurrence (conservative per spec §10), though the exception row itself is
//     still shown at its own current start_at.
// No row is deleted; `original_start_at` is only ever replaced with a value that resolves to
// the same local calendar date it already pointed at.
import type { Database } from 'bun:sqlite';
import type { CalendarEvent } from '../../database/types.ts';
import { dbLogger } from '../../utils/logger.ts';
import { expandRecurrence } from './recurrence.ts';
import { toLocalDateKey } from './wall-clock.ts';

/** Generous pad around the exception's original local date so the parent's DST-shifted
 * occurrence (which can land a few hours either side of the naive UTC day boundary) is still
 * inside the expansion window. */
const WINDOW_PAD_MS = 3 * 24 * 60 * 60_000;

export function backfillExceptionIdentity(db: Database): void {
  const exceptions = db
    .prepare(
      'SELECT * FROM events WHERE parent_event_id IS NOT NULL AND is_deleted = 0 AND original_start_at IS NOT NULL',
    )
    .all() as CalendarEvent[];

  let migrated = 0;
  let unresolved = 0;
  let skippedNoParent = 0;

  for (const exception of exceptions) {
    const parent = db.prepare('SELECT * FROM events WHERE id = ?').get(exception.parent_event_id) as
      | CalendarEvent
      | undefined;
    if (!parent || !parent.recurrence_rule) {
      // Can't validate a candidate occurrence set without a live parent rule — leave the row
      // exactly as it is rather than guess.
      skippedNoParent++;
      continue;
    }

    const originalMs = Date.parse(exception.original_start_at!);
    if (Number.isNaN(originalMs)) {
      skippedNoParent++;
      continue;
    }

    let candidates: string[] | null;
    try {
      // Inside the try: Intl throws RangeError on an invalid stored timezone; such a row is
      // left untouched like any other unvalidatable parent, not allowed to abort the migration.
      const localKey = parent.all_day
        ? exception.original_start_at!.slice(0, 10)
        : toLocalDateKey(new Date(originalMs), parent.timezone);
      const windowStart = new Date(originalMs - WINDOW_PAD_MS).toISOString();
      const windowEnd = new Date(originalMs + WINDOW_PAD_MS).toISOString();
      const result = expandRecurrence(parent, [], windowStart, windowEnd);
      candidates = result.occurrences
        .filter((occ) => {
          const key = parent.all_day
            ? occ.occurrence_start.slice(0, 10)
            : toLocalDateKey(new Date(occ.occurrence_start), parent.timezone);
          return key === localKey;
        })
        .map((occ) => occ.occurrence_start);
    } catch {
      // Parent rule is itself unsupported (multi-RRULE, EXRULE, …) — same as no live parent:
      // can't validate, so the row is left completely untouched rather than flagged.
      candidates = null;
    }

    if (candidates === null) {
      skippedNoParent++;
    } else if (candidates.length === 1) {
      const resolvedInstant = candidates[0]!;
      if (resolvedInstant !== exception.original_start_at) {
        db.prepare('UPDATE events SET original_start_at = ? WHERE id = ?').run(resolvedInstant, exception.id);
      }
      migrated++;
    } else {
      db.prepare("UPDATE events SET identity_status = 'unresolved' WHERE id = ?").run(exception.id);
      unresolved++;
    }
  }

  dbLogger.info(
    { total: exceptions.length, migrated, unresolved, skippedNoParent },
    'Backfilled recurrence exception identity (migration 066)',
  );
}
