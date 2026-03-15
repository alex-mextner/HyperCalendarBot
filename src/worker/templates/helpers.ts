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

interface TimeRange {
  startMinutes: number;
  endMinutes: number;
}

export interface EventColumn {
  column: number;
  totalColumns: number;
}

export function computeEventColumns(events: TimeRange[]): EventColumn[] {
  if (events.length === 0) return [];

  const indices = events.map((_, i) => i).sort((a, b) => events[a].startMinutes - events[b].startMinutes);

  const columns: EventColumn[] = new Array(events.length);
  const columnEnds: number[] = [];

  for (const i of indices) {
    const ev = events[i];
    let col = 0;
    while (col < columnEnds.length && columnEnds[col] > ev.startMinutes) {
      col++;
    }
    columnEnds[col] = ev.endMinutes;
    columns[i] = { column: col, totalColumns: 0 };
  }

  for (let i = 0; i < events.length; i++) {
    let maxCol = columns[i].column;
    for (let j = 0; j < events.length; j++) {
      if (i === j) continue;
      if (events[j].startMinutes < events[i].endMinutes && events[j].endMinutes > events[i].startMinutes) {
        maxCol = Math.max(maxCol, columns[j].column);
      }
    }
    columns[i].totalColumns = maxCol + 1;
  }

  return columns;
}
