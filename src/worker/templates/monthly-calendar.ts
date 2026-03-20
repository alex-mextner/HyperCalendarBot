import { escapeHtml, formatTime } from './helpers.ts';
import { sharedCSS } from './shared-css.ts';
import type { MiniEvent, MonthDay, MonthlyCalendarData, TemplateRenderer } from './types.ts';

function renderEventDot(ev: MiniEvent): string {
  const timeStr = ev.isAllDay ? '' : formatTime(ev.startMinutes);
  const timeHtml = timeStr ? `<span class="ev-time">${timeStr}</span>` : '';
  return `<div class="ev-dot" style="background:${ev.color}18;border-left:2px solid ${ev.color};color:${ev.color};">
    <span class="ev-inner">${timeHtml}<span class="ev-title">${escapeHtml(ev.title)}</span></span>
  </div>`;
}

function renderDay(day: MonthDay): string {
  const classes = ['cell'];
  if (day.isOtherMonth) classes.push('cell--other');
  if (day.isWeekend) classes.push('cell--weekend');

  const numberHtml = day.isToday
    ? `<span class="cell__num cell__num--today">${day.dayNumber}</span>`
    : `<span class="cell__num">${day.dayNumber}</span>`;

  const maxShow = 3;
  const shown = day.events.slice(0, maxShow);
  const overflow = day.eventCount - maxShow;
  const eventsHtml = shown.map(renderEventDot).join('');
  const overflowHtml = overflow > 0 ? `<div class="ev-overflow">+${overflow}</div>` : '';

  return `<div class="${classes.join(' ')}">
    ${numberHtml}
    <div class="cell__events">${eventsHtml}${overflowHtml}</div>
  </div>`;
}

function css(data: MonthlyCalendarData): string {
  const t = data.theme;
  return `
    ${sharedCSS({ bg: t.bg, textPrimary: t.textPrimary })}

    .month-header {
      margin-bottom: 24px;
    }
    .month-header__label {
      font-size: 36px;
      font-weight: 700;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 6px;
    }
    .dow {
      font-size: 13px;
      color: ${t.textSecondary};
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding-bottom: 8px;
    }
    .dow--weekend { color: ${t.accent}; opacity: 0.7; }
    .cell {
      background: ${t.cardBg};
      border-radius: 12px;
      padding: 8px 6px;
      min-height: 110px;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .cell--other { opacity: 0.35; }
    .cell--weekend { background: ${t.border}10; }
    .cell__num {
      font-size: 18px;
      font-weight: 600;
      text-align: center;
      display: block;
      margin-bottom: 4px;
    }
    .cell__num--today {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: #EF4444;
      color: #FFFFFF;
      margin: 0 auto 4px;
    }
    .cell__events {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ev-dot {
      border-radius: 4px;
      padding: 2px 4px;
      font-size: 10px;
      line-height: 1.3;
      display: block;
      overflow: hidden;
    }
    .ev-inner {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      overflow-wrap: break-word;
    }
    .ev-time {
      font-weight: 600;
      font-size: 9px;
      opacity: 0.8;
      margin-right: 2px;
    }
    .ev-title {
      font-weight: 500;
    }
    .ev-overflow {
      font-size: 10px;
      color: ${t.textSecondary};
      padding-left: 4px;
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

function render(data: MonthlyCalendarData): string {
  const dowHtml = data.weekDays
    .map((d, i) => `<div class="dow${i >= 5 ? ' dow--weekend' : ''}">${escapeHtml(d)}</div>`)
    .join('');

  const weeksHtml = data.weeks.map((week) => week.map(renderDay).join('')).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>${css(data)}</style>
</head>
<body>
<div id="__root">
  <div class="month-header">
    <div class="month-header__label">${escapeHtml(data.monthLabel)}</div>
  </div>
  <div class="grid">
    ${dowHtml}
    ${weeksHtml}
  </div>
  <div class="footer">HyperCalendar</div>
</div>
</body>
</html>`;
}

export const monthlyCalendarTemplate: TemplateRenderer<MonthlyCalendarData> = { render };
