export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

export interface TimeRange {
  startMinutes: number;
  endMinutes: number;
}

export interface EventColumn {
  column: number;
  totalColumns: number;
}

export function computeEventColumns(events: TimeRange[]): EventColumn[] {
  if (events.length === 0) return [];

  const indices = events.map((_, i) => i).sort((a, b) => events[a]!.startMinutes - events[b]!.startMinutes);

  const columns: EventColumn[] = new Array(events.length);
  const columnEnds: number[] = [];

  for (const i of indices) {
    const ev = events[i]!;
    let col = 0;
    while (col < columnEnds.length && columnEnds[col]! > ev.startMinutes) {
      col++;
    }
    columnEnds[col] = ev.endMinutes;
    columns[i] = { column: col, totalColumns: 0 };
  }

  for (let i = 0; i < events.length; i++) {
    let maxCol = columns[i]!.column;
    for (let j = 0; j < events.length; j++) {
      if (i === j) continue;
      if (events[j]!.startMinutes < events[i]!.endMinutes && events[j]!.endMinutes > events[i]!.startMinutes) {
        maxCol = Math.max(maxCol, columns[j]!.column);
      }
    }
    columns[i]!.totalColumns = maxCol + 1;
  }

  return columns;
}

// ── Timeline layout constants ──────────────────────────────────────────────

/** Pixels per minute on the daily timeline (1 hour = 60 * PX_PER_MIN px). */
export const PX_PER_MIN = 2;

/** Minimum visual event height in minutes; short events expand to this for readability. */
export const MIN_EVENT_DURATION_MIN = 15;

/** Max side-by-side columns for overlapping events; beyond this an overflow block renders. */
export const MAX_OVERLAP_COLUMNS = 4;

/** Minimum visual event height in px. CSS min-height guarantees events are always readable. */
export const COMPACT_PX = MIN_EVENT_DURATION_MIN * PX_PER_MIN;

/** Max event titles shown in the overflow block before "+N more" is appended. */
export const MAX_OVERFLOW_LABELS = 3;

// ── px ↔ minutes conversions ───────────────────────────────────────────────

export function minutesToPx(minutes: number): number {
  return minutes * PX_PER_MIN;
}

export function pxToMinutes(px: number): number {
  return px / PX_PER_MIN;
}

/**
 * Computed rendered height (px) for one event on the daily timeline.
 *
 * Expands short events to MIN_EVENT_DURATION_MIN for readability.
 * Visual overlap prevention is handled upstream by column assignment using
 * visual (min-height expanded) ranges — no gap-clamping needed here.
 */
export function computeEventHeight(event: TimeRange): number {
  return Math.max(event.endMinutes - event.startMinutes, MIN_EVENT_DURATION_MIN) * PX_PER_MIN;
}
