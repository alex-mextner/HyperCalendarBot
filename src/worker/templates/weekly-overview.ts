import { escapeHtml, formatTime } from './helpers.ts';
import { sharedCSS } from './shared-css.ts';
import type { MiniEvent, TemplateRenderer, WeeklyOverviewData } from './types.ts';

function renderEvent(ev: MiniEvent): string {
  const bg = `${ev.color}18`;
  const timeStr = ev.isAllDay ? '' : formatTime(ev.startMinutes);
  const timeHtml = timeStr ? `<span class="event-pill__time">${timeStr}</span>` : '';
  return `<div class="event-pill" style="background:${bg};border-left:3px solid ${ev.color};color:${ev.color};">
    ${timeHtml}<span class="event-pill__title">${escapeHtml(ev.title)}</span>
  </div>`;
}

function renderDayColumn(day: WeeklyOverviewData['days'][number], isToday: boolean): string {
  const columnClass = day.isWeekend ? 'day-column day-column--weekend' : 'day-column';

  const numberHtml = isToday
    ? `<div class="day-column__number"><span class="today-highlight">${day.dayNumber}</span></div>`
    : `<div class="day-column__number">${day.dayNumber}</div>`;

  const eventsHtml =
    day.events.length > 0 ? day.events.map(renderEvent).join('') : `<div class="day-column__empty"></div>`;

  return `
    <div class="${columnClass}">
      <div class="day-column__name">${escapeHtml(day.dayName)}</div>
      ${numberHtml}
      <div class="day-column__events">${eventsHtml}</div>
    </div>`;
}

function css(data: WeeklyOverviewData): string {
  const t = data.theme;
  return `
    ${sharedCSS({ bg: t.bg, textPrimary: t.textPrimary })}

    .week-header {
      margin-bottom: 24px;
    }
    .week-header__label {
      font-size: 36px;
      font-weight: 700;
    }
    .week-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 8px;
    }
    .day-column {
      background: ${t.cardBg};
      border-radius: 14px;
      padding: 12px 8px;
      display: flex;
      flex-direction: column;
      min-height: 500px;
    }
    .day-column--weekend {
      background: ${t.border}15;
    }
    .day-column__name {
      font-size: 13px;
      color: ${t.textSecondary};
      text-align: center;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .day-column__number {
      font-size: 22px;
      font-weight: 700;
      text-align: center;
      margin-bottom: 12px;
      display: flex;
      justify-content: center;
    }
    .today-highlight {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #EF4444;
      color: #FFFFFF;
    }
    .day-column__events {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .day-column__empty {
      flex: 1;
    }
    .event-pill {
      border-radius: 6px;
      padding: 5px 6px;
      font-size: 11px;
      line-height: 1.3;
      display: flex;
      align-items: baseline;
      gap: 3px;
      overflow: hidden;
    }
    .event-pill__time {
      font-weight: 600;
      flex-shrink: 0;
      font-size: 10px;
      opacity: 0.8;
    }
    .event-pill__title {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 500;
    }
    .footer {
      margin-top: 24px;
      text-align: right;
      font-size: 14px;
      color: ${t.textSecondary};
      opacity: 0.6;
    }
  `;
}

function render(data: WeeklyOverviewData): string {
  const columnsHtml = data.days.map((day, i) => renderDayColumn(day, i === data.todayIndex)).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>${css(data)}</style>
</head>
<body>
<div id="__root">
  <div class="week-header">
    <div class="week-header__label">${escapeHtml(data.weekLabel)}</div>
  </div>
  <div class="week-grid">
    ${columnsHtml}
  </div>
  <div class="footer">HyperCalendar</div>
</div>
</body>
</html>`;
}

export const weeklyOverviewTemplate: TemplateRenderer<WeeklyOverviewData> = { render };
