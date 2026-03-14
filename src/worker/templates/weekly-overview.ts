import { escapeHtml } from './helpers.ts';
import { sharedCSS } from './shared-css.ts';
import type { MiniEvent, TemplateRenderer, WeeklyOverviewData } from './types.ts';

const VISIBLE_START = 480; // 08:00
const VISIBLE_END = 1320; // 22:00
const VISIBLE_RANGE = VISIBLE_END - VISIBLE_START;

function renderMiniEvent(ev: MiniEvent): string {
  if (ev.isAllDay) {
    return `<div class="mini-event" style="height:6px;background:${escapeHtml(ev.color)};"></div>`;
  }
  const heightPct = Math.max(0.5, ((ev.endMinutes - ev.startMinutes) / VISIBLE_RANGE) * 100);
  return `<div class="mini-event" style="height:${heightPct}%;background:${escapeHtml(ev.color)};"></div>`;
}

function renderDayColumn(
  day: WeeklyOverviewData['days'][number],
  isToday: boolean,
  theme: WeeklyOverviewData['theme'],
): string {
  const weekendBg = `${theme.border}33`;
  const columnClass = day.isWeekend ? 'day-column day-column--weekend' : 'day-column';
  const columnStyle = day.isWeekend ? `style="background:${weekendBg};"` : '';

  const numberHtml = isToday
    ? `<div class="day-column__number"><span class="today-highlight">${day.dayNumber}</span></div>`
    : `<div class="day-column__number">${day.dayNumber}</div>`;

  const eventsHtml = day.events.map(renderMiniEvent).join('');
  const countHtml = day.eventCount > 0 ? `<div class="day-column__count">${day.eventCount}</div>` : '';

  return `
    <div class="${columnClass}" ${columnStyle}>
      <div class="day-column__name">${escapeHtml(day.dayName)}</div>
      ${numberHtml}
      <div class="day-column__events">${eventsHtml}</div>
      ${countHtml}
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
      gap: 12px;
    }
    .day-column {
      background: ${t.cardBg};
      border-radius: 16px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      min-height: 600px;
    }
    .day-column--weekend {
      background: ${t.border}33;
    }
    .day-column__name {
      font-size: 16px;
      color: ${t.textSecondary};
      text-align: center;
      margin-bottom: 8px;
    }
    .day-column__number {
      font-size: 24px;
      font-weight: 700;
      text-align: center;
      margin-bottom: 16px;
      display: flex;
      justify-content: center;
    }
    .today-highlight {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: #EF4444;
      color: #FFFFFF;
      margin: 0 auto;
    }
    .day-column__events {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
      position: relative;
    }
    .mini-event {
      border-radius: 6px;
      min-height: 4px;
      opacity: 0.7;
    }
    .day-column__count {
      text-align: center;
      font-size: 14px;
      color: ${t.textSecondary};
      margin-top: 12px;
      font-weight: 600;
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

function render(data: WeeklyOverviewData): string {
  const columnsHtml = data.days.map((day, i) => renderDayColumn(day, i === data.todayIndex, data.theme)).join('');

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
