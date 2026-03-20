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

/** Max side-by-side columns for overlapping events; beyond this an overflow indicator renders. */
export const MAX_OVERLAP_COLUMNS = 4;

/**
 * Computed rendered height (px) for one event on the daily timeline.
 *
 * Expands short events to MIN_EVENT_DURATION_MIN for readability, then caps the
 * expansion at the gap to the next sequential event in the same column so that
 * adjacent events never visually overlap. Never shrinks below the actual duration.
 */
export function computeEventHeight(
  event: TimeRange,
  eventIdx: number,
  allEvents: ReadonlyArray<TimeRange>,
  columns: ReadonlyArray<EventColumn>,
): number {
  const durationMin = event.endMinutes - event.startMinutes;
  const expandedDuration = Math.max(durationMin, MIN_EVENT_DURATION_MIN);

  // Nearest sequential event in the same column (starts at or after this event ends).
  const myColumn = columns[eventIdx]!.column;
  let nextSameColStart = Infinity;
  for (let j = 0; j < allEvents.length; j++) {
    if (j === eventIdx) continue;
    if (columns[j]?.column !== myColumn) continue;
    const other = allEvents[j]!;
    if (other.startMinutes < event.endMinutes) continue; // time-overlapping → different column
    if (other.startMinutes < nextSameColStart) nextSameColStart = other.startMinutes;
  }

  // Gap from THIS event's start to the next event's start limits visual height.
  // Visual tops are spaced by startMinutes*PX_PER_MIN, so height ≤ gap prevents overlap.
  const maxDuration = Number.isFinite(nextSameColStart) ? nextSameColStart - event.startMinutes : Infinity;
  const visualDuration = Number.isFinite(maxDuration) ? Math.min(expandedDuration, maxDuration) : expandedDuration;

  // Never shrink below actual duration (don't misrepresent time).
  return Math.max(visualDuration, durationMin) * PX_PER_MIN;
}
