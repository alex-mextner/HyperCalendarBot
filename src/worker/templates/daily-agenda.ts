import { agendaDetailsCSS, renderAgendaDetails } from './agenda-details.ts';
import {
  COMPACT_PX,
  computeEventColumns,
  computeEventHeight,
  escapeHtml,
  formatTime,
  MAX_OVERFLOW_LABELS,
  MAX_OVERLAP_COLUMNS,
  MIN_EVENT_DURATION_MIN,
  PX_PER_MIN,
} from './helpers.ts';
import { getLabels, pluralizeEvents } from './labels.ts';
import { sharedCSS } from './shared-css.ts';
import type { AgendaEvent, DailyAgendaData, TemplateRenderer } from './types.ts';

function renderAllDaySection(events: AgendaEvent[], locale: string): string {
  if (events.length === 0) return '';
  const labels = getLabels(locale);
  const items = events
    .map(
      (ev) => `
    <div class="allday__item">
      <div class="allday__dot" style="background:${escapeHtml(ev.calendarColor)};"></div>
      <div class="allday__title">${escapeHtml(ev.title)}</div>
      <div class="allday__label">${labels.allDay}</div>
    </div>`,
    )
    .join('');
  return `<div class="allday">${items}</div>`;
}

function renderTimeline(data: DailyAgendaData): string {
  const { timedEvents, currentTimeMinutes } = data;

  let minHour = 8;
  let maxHour = 18;
  if (timedEvents.length > 0) {
    const firstStart = Math.min(...timedEvents.map((e) => e.startMinutes));
    const lastEnd = Math.max(...timedEvents.map((e) => e.endMinutes));
    minHour = Math.max(0, Math.floor(firstStart / 60) - 1);
    maxHour = Math.min(24, Math.ceil(lastEnd / 60) + 1);
  }

  const totalMinutes = (maxHour - minHour) * 60;
  const containerHeight = totalMinutes * PX_PER_MIN;
  const HOUR_PX = 60 * PX_PER_MIN;

  // Hour rows for left column labels
  const hourRows: string[] = [];
  for (let h = minHour; h < maxHour; h++) {
    const label = h === 0 ? '' : formatTime(h * 60);
    hourRows.push(`
      <div class="timeline__hour-row" style="top:${(h - minHour) * HOUR_PX}px;">
        <div class="timeline__hour-label">${label}</div>
      </div>`);
  }

  // Column assignment uses visual ranges (min-height applied) to prevent vertical overlap.
  // A 5-min event expanded to COMPACT_PX visually occupies MIN_EVENT_DURATION_MIN minutes,
  // so sequential short events land in separate columns instead of stacking.
  const visualRanges = timedEvents.map((ev) => ({
    startMinutes: ev.startMinutes,
    endMinutes: ev.startMinutes + Math.max(ev.endMinutes - ev.startMinutes, MIN_EVENT_DURATION_MIN),
  }));
  const cols = computeEventColumns(visualRanges);

  type OverflowItem = {
    top: number;
    endPx: number;
    height: number;
    title: string;
    calendarColor: string;
    startMinutes: number;
    endMinutes: number;
  };

  // Pass 1: collect overflow items and build blocks so main-event rendering knows column counts.
  // N+2 rule: 1-2 overflow events → individual equal-width cards; 3+ → group card.
  const overflowItems: OverflowItem[] = timedEvents.flatMap((ev, i) => {
    const col = cols[i];
    if (!col || !(col.totalColumns > MAX_OVERLAP_COLUMNS && col.column >= MAX_OVERLAP_COLUMNS)) return [];
    const top = (ev.startMinutes - minHour * 60) * PX_PER_MIN;
    const height = computeEventHeight(ev);
    return [
      {
        top,
        endPx: top + height,
        height,
        title: ev.title,
        calendarColor: ev.calendarColor,
        startMinutes: ev.startMinutes,
        endMinutes: ev.endMinutes,
      },
    ];
  });

  const sortedOverflow = [...overflowItems].sort((a, b) => a.top - b.top);
  const overflowBlocks: Array<{ top: number; endPx: number; items: OverflowItem[] }> = [];
  for (const item of sortedOverflow) {
    const last = overflowBlocks[overflowBlocks.length - 1];
    if (last && item.top < last.endPx) {
      last.endPx = Math.max(last.endPx, item.endPx);
      last.items.push(item);
    } else {
      overflowBlocks.push({ top: item.top, endPx: item.endPx, items: [item] });
    }
  }

  // Return the max individual overflow count among all ≤2-item blocks overlapping this event.
  // Using max (not first-match) prevents horizontal overlap when a long event spans multiple overflow windows.
  function individualOverflowCount(startMin: number, endMin: number): number {
    let max = 0;
    for (const b of overflowBlocks) {
      if (b.items.length <= 2 && b.items.some((it) => it.startMinutes < endMin && it.endMinutes > startMin)) {
        if (b.items.length > max) max = b.items.length;
      }
    }
    return max;
  }

  // Pass 2: render main events.
  // Individual overflow cards are equal-width extra columns, so effectiveCols = N + overflowCount.
  const eventBlocksHtml = timedEvents
    .map((ev, i) => {
      const col = cols[i];
      if (!col) return '';
      const top = (ev.startMinutes - minHour * 60) * PX_PER_MIN;
      const height = computeEventHeight(ev);

      if (col.totalColumns > MAX_OVERLAP_COLUMNS && col.column >= MAX_OVERLAP_COLUMNS) return '';

      const ovCount = individualOverflowCount(ev.startMinutes, ev.endMinutes);
      const effectiveCols =
        ovCount > 0
          ? MAX_OVERLAP_COLUMNS + ovCount
          : col.totalColumns > MAX_OVERLAP_COLUMNS
            ? MAX_OVERLAP_COLUMNS + 1
            : Math.min(col.totalColumns, MAX_OVERLAP_COLUMNS);
      const widthPct = 100 / effectiveCols;
      const leftPct = col.column * widthPct;
      const bg = `${ev.calendarColor}20`;
      const border = ev.calendarColor;
      const color = ev.calendarColor;

      const timeStr = `${formatTime(ev.startMinutes)} – ${formatTime(ev.endMinutes)}`;
      const locationStr = ev.location ? ` · ${escapeHtml(ev.location)}` : '';
      const isCompact = height <= COMPACT_PX;

      return `<div class="event-block${isCompact ? ' event-block--compact' : ''}" style="top:${top}px;height:${height}px;left:calc(${leftPct}%);width:calc(${widthPct}% - 8px);background:${bg};border-left:4px solid ${border};color:${color};">
      <div class="event-block__title">${escapeHtml(ev.title)}</div>
      <div class="event-block__meta">${timeStr}${locationStr}</div>
    </div>`;
    })
    .join('');

  // Group card overflow slot: (MAX_OVERLAP_COLUMNS + 1)th column, used only for 3+ overflow events.
  const ovfGroupWidthPct = 100 / (MAX_OVERLAP_COLUMNS + 1);
  const ovfGroupLeftPct = MAX_OVERLAP_COLUMNS * ovfGroupWidthPct;
  const overflowHtml = overflowBlocks
    .map(({ top, endPx, items }) => {
      if (items.length <= 2) {
        // Equal-width columns alongside main events: column N+0, N+1, …
        const totalCols = MAX_OVERLAP_COLUMNS + items.length;
        const widthPct = 100 / totalCols;
        return items
          .map((item, idx) => {
            const leftPct = (MAX_OVERLAP_COLUMNS + idx) * widthPct;
            const isCompact = item.height <= COMPACT_PX;
            const bg = `${item.calendarColor}20`;
            const timeStr = `${formatTime(item.startMinutes)} – ${formatTime(item.endMinutes)}`;
            return `<div class="event-block${isCompact ? ' event-block--compact' : ''}" style="top:${item.top}px;height:${item.height}px;left:calc(${leftPct}%);width:calc(${widthPct}% - 8px);background:${bg};border-left:4px solid ${item.calendarColor};color:${item.calendarColor};">
      <div class="event-block__title">${escapeHtml(item.title)}</div>
      <div class="event-block__meta">${timeStr}</div>
    </div>`;
          })
          .join('');
      }
      // 3+ events: group card in the fixed overflow slot
      const h = Math.max(endPx - top, COMPACT_PX);
      const isCompact = h <= COMPACT_PX;
      const visible = items.slice(0, MAX_OVERFLOW_LABELS);
      const remaining = items.length - visible.length;
      const labelsHtml = visible.map((it) => `<div class="overflow-item">${escapeHtml(it.title)}</div>`).join('');
      const moreHtml = remaining > 0 ? `<div class="overflow-more">+${remaining} more</div>` : '';
      return `<div class="event-block event-block--overflow${isCompact ? ' event-block--compact' : ''}" style="top:${top}px;height:${h}px;left:calc(${ovfGroupLeftPct}%);width:calc(${ovfGroupWidthPct}% - 8px);">${labelsHtml}${moreHtml}</div>`;
    })
    .join('');

  // Current time indicator — spans full width (hour labels + events area)
  let nowLine = '';
  if (currentTimeMinutes !== undefined && currentTimeMinutes >= minHour * 60 && currentTimeMinutes <= maxHour * 60) {
    const top = (currentTimeMinutes - minHour * 60) * PX_PER_MIN;
    const timeLabel = formatTime(currentTimeMinutes);
    nowLine = `
      <div class="now-line" style="top:${top}px;">
        <div class="now-line__label">${timeLabel}</div>
        <div class="now-line__connector"></div>
        <div class="now-line__dot"></div>
        <div class="now-line__rule"></div>
      </div>`;
  }

  return `
    <div class="timeline" style="height:${containerHeight}px;">
      <div class="timeline__hours" style="position:absolute;top:0;left:0;right:0;">
        ${hourRows.join('')}
      </div>
      <div class="timeline__events" style="position:absolute;top:0;left:80px;right:0;height:${containerHeight}px;">
        ${eventBlocksHtml}${overflowHtml}
      </div>
      ${nowLine}
    </div>`;
}

function css(data: DailyAgendaData): string {
  const t = data.theme;
  return `
    ${sharedCSS({ bg: t.bg, textPrimary: t.textPrimary })}

    .header {
      padding-bottom: 24px;
      border-bottom: 2px solid ${t.border};
    }
    .header__date {
      font-size: 42px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .header__meta {
      font-size: 20px;
      color: ${t.textSecondary};
      margin-top: 8px;
    }
    .header__badge {
      display: inline-block;
      padding: 6px 16px;
      border-radius: 20px;
      background: ${t.accent};
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      margin-right: 12px;
    }
    .holiday-badge {
      display: inline-block;
      padding: 6px 16px;
      border-radius: 20px;
      background: #FEF3C7;
      color: #92400E;
      font-size: 16px;
      font-weight: 600;
      margin-right: 12px;
    }
    .allday {
      margin: 24px 0;
    }
    .allday__item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px;
      border-radius: 12px;
      background: ${t.cardBg};
      margin-bottom: 8px;
    }
    .allday__dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .allday__label {
      font-size: 14px;
      color: ${t.textSecondary};
      margin-left: auto;
    }
    .timeline {
      position: relative;
      margin-top: 24px;
    }
    .timeline__hour-row {
      position: absolute;
      left: 0;
      right: 0;
      height: ${60 * PX_PER_MIN}px;
      display: flex;
      align-items: flex-start;
      border-top: 1px solid ${t.border};
    }
    .timeline__hour-label {
      width: 80px;
      font-size: 16px;
      color: ${t.textSecondary};
      padding-top: 4px;
    }
    .timeline__events {
      position: relative;
      flex: 1;
    }
    .event-block {
      position: absolute;
      border-radius: 10px;
      padding: 10px 14px;
      overflow: hidden;
      font-size: 14px;
      min-height: ${COMPACT_PX}px;
    }
    .event-block__title {
      font-weight: 600;
      font-size: 16px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .event-block__meta {
      font-size: 13px;
      opacity: 0.8;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .event-block--compact {
      padding: 4px 10px;
    }
    .event-block--compact .event-block__title {
      font-size: 13px;
    }
    .event-block--compact .event-block__meta {
      display: none;
    }
    .event-block--overflow {
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      border-left: 4px solid ${t.textSecondary}40;
      background: ${t.cardBg};
      color: ${t.textSecondary};
      padding: 6px 8px;
      z-index: 5;
    }
    .overflow-item {
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.4;
    }
    .overflow-more {
      font-size: 11px;
      opacity: 0.6;
      margin-top: 2px;
    }
    .now-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 0;
      z-index: 10;
      display: flex;
      align-items: center;
    }
    .now-line__label {
      display: inline-flex;
      align-items: center;
      height: 26px;
      border-radius: 8px;
      background: #EF4444;
      color: #FFFFFF;
      font-size: 16px;
      font-weight: 600;
      flex-shrink: 0;
      padding: 0 8px;
      margin-left: -8px;
    }
    .now-line__connector {
      flex: 1;
      height: 2px;
      background: #EF444440;
      max-width: 20px;
    }
    .now-line__dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #EF4444;
      flex-shrink: 0;
    }
    .now-line__rule {
      flex: 1;
      height: 2px;
      background: #EF4444;
    }
    .empty-state {
      text-align: center;
      padding: 80px 0;
      font-size: 24px;
      color: ${t.textSecondary};
    }
    .footer {
      margin-top: 32px;
      text-align: right;
      font-size: 14px;
      color: ${t.textSecondary};
      opacity: 0.6;
    }
  `;
}

function render(data: DailyAgendaData): string {
  const {
    dateFormatted,
    dayOfWeek,
    eventCount,
    relativeDay,
    isHoliday,
    holidayName,
    allDayEvents,
    timedEvents,
    locale,
  } = data;
  const labels = getLabels(locale);

  const badgesHtml = [
    relativeDay ? `<span class="header__badge">${escapeHtml(relativeDay)}</span>` : '',
    isHoliday && holidayName ? `<span class="holiday-badge">${escapeHtml(holidayName)}</span>` : '',
  ]
    .filter(Boolean)
    .join('');

  const metaHtml = badgesHtml
    ? `<div class="header__meta">${badgesHtml}</div><div class="header__meta">${escapeHtml(dayOfWeek)} · ${eventCount} ${pluralizeEvents(eventCount, locale)}</div>`
    : `<div class="header__meta">${escapeHtml(dayOfWeek)} · ${eventCount} ${pluralizeEvents(eventCount, locale)}</div>`;

  const hasEvents = allDayEvents.length > 0 || timedEvents.length > 0;
  const bodyHtml = hasEvents
    ? `${renderAllDaySection(allDayEvents, locale)}${renderTimeline(data)}`
    : `<div class="empty-state">${labels.noEvents}</div>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>${css(data)}${agendaDetailsCSS}</style>
</head>
<body>
<div id="__root">
  <div class="header">
    <div class="header__date">${escapeHtml(dateFormatted)}</div>
    ${metaHtml}
  </div>
  ${bodyHtml}
  ${renderAgendaDetails([...allDayEvents, ...timedEvents], data.locale)}
  <div class="footer">HyperCalendar</div>
</div>
</body>
</html>`;
}

export const dailyAgendaTemplate: TemplateRenderer<DailyAgendaData> = { render };
