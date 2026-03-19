import { computeEventColumns, escapeHtml, formatTime } from './helpers.ts';
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
  const containerHeight = totalMinutes;

  // Hour rows for left column labels
  const hourRows: string[] = [];
  for (let h = minHour; h < maxHour; h++) {
    const label = h === 0 ? '' : formatTime(h * 60);
    hourRows.push(`
      <div class="timeline__hour-row" style="top:${(h - minHour) * 60}px;">
        <div class="timeline__hour-label">${label}</div>
      </div>`);
  }

  // Event blocks
  const cols = computeEventColumns(timedEvents);
  const eventBlocks = timedEvents
    .map((ev, i) => {
      const top = ev.startMinutes - minHour * 60;
      const height = Math.max(ev.endMinutes - ev.startMinutes, 20);
      const col = cols[i];
      if (!col) return '';
      const widthPct = 100 / col.totalColumns;
      const leftPct = col.column * widthPct;
      const bg = `${ev.calendarColor}20`;
      const border = ev.calendarColor;
      const color = ev.calendarColor;

      const timeStr = `${formatTime(ev.startMinutes)} – ${formatTime(ev.endMinutes)}`;
      const locationStr = ev.location ? ` · ${escapeHtml(ev.location)}` : '';
      // Compact: time + location on one line; title adapts to available height
      const isShort = height <= 30;

      return `<div class="event-block${isShort ? ' event-block--compact' : ''}" style="top:${top}px;height:${height}px;left:calc(${leftPct}%);width:calc(${widthPct}% - 8px);background:${bg};border-left:4px solid ${border};color:${color};">
      <div class="event-block__title">${escapeHtml(ev.title)}</div>
      <div class="event-block__meta">${timeStr}${locationStr}</div>
    </div>`;
    })
    .join('');

  // Current time indicator — spans full width (hour labels + events area)
  let nowLine = '';
  if (currentTimeMinutes !== undefined && currentTimeMinutes >= minHour * 60 && currentTimeMinutes <= maxHour * 60) {
    const top = currentTimeMinutes - minHour * 60;
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
        ${eventBlocks}
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
      height: 60px;
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
<style>${css(data)}</style>
</head>
<body>
<div id="__root">
  <div class="header">
    <div class="header__date">${escapeHtml(dateFormatted)}</div>
    ${metaHtml}
  </div>
  ${bodyHtml}
  <div class="footer">HyperCalendar</div>
</div>
</body>
</html>`;
}

export const dailyAgendaTemplate: TemplateRenderer<DailyAgendaData> = { render };
