import { escapeHtml } from './helpers.ts';
import { sharedCSS } from './shared-css.ts';
import type { EventCardData, TemplateRenderer } from './types.ts';

function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

function renderAttendees(attendees: string[], overflow: number): string {
  const avatars = attendees
    .map((name) => `<div class="card__avatar" title="${escapeHtml(name)}">${escapeHtml(initials(name))}</div>`)
    .join('');
  const overflowBadge = overflow > 0 ? `<span class="card__overflow">+${overflow}</span>` : '';
  return `<div class="card__attendees">${avatars}${overflowBadge}</div>`;
}

function css(data: EventCardData): string {
  const { theme, calendarColor } = data;
  return `
    ${sharedCSS({ bg: theme.bg, textPrimary: theme.textPrimary })}
    #__root {
      padding: 48px;
      display: flex;
      flex-direction: column;
    }
    .card {
      background: ${theme.cardBg};
      border-radius: 20px;
      border-left: 8px solid ${escapeHtml(calendarColor)};
      padding: 40px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .card__title {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 20px;
      line-height: 1.3;
      color: ${theme.textPrimary};
    }
    .card__row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 18px;
      color: ${theme.textSecondary};
      margin-bottom: 12px;
    }
    .card__icon {
      font-size: 20px;
      width: 28px;
      flex-shrink: 0;
    }
    .card__description {
      font-size: 16px;
      color: ${theme.textSecondary};
      line-height: 1.6;
      margin: 16px 0;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .card__attendees {
      display: flex;
      gap: 8px;
      align-items: center;
      margin: 16px 0;
    }
    .card__avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: ${theme.accent};
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 600;
    }
    .card__overflow {
      font-size: 14px;
      color: ${theme.textSecondary};
      font-weight: 600;
    }
    .card__calendar {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: ${theme.textSecondary};
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid ${theme.border};
    }
    .card__calendar-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .footer {
      margin-top: 32px;
      text-align: right;
      font-size: 14px;
      color: ${theme.textSecondary};
      opacity: 0.6;
    }
  `;
}

function render(data: EventCardData): string {
  const {
    title,
    dateFormatted,
    timeFormatted,
    duration,
    location,
    description,
    attendees,
    attendeeOverflow,
    conferenceLink,
    calendarName,
    calendarColor,
  } = data;

  const locationRow =
    location !== undefined
      ? `<div class="card__row"><span class="card__icon">📍</span><span>${escapeHtml(location)}</span></div>`
      : '';

  const descriptionBlock =
    description !== undefined ? `<div class="card__description">${escapeHtml(description)}</div>` : '';

  const attendeesBlock =
    attendees !== undefined && attendees.length > 0 ? renderAttendees(attendees, attendeeOverflow ?? 0) : '';

  const conferenceRow =
    conferenceLink !== undefined
      ? `<div class="card__row"><span class="card__icon">🔗</span><span>${escapeHtml(conferenceLink)}</span></div>`
      : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>${css(data)}</style>
</head>
<body>
<div id="__root">
  <div class="card">
    <div class="card__title">${escapeHtml(title)}</div>
    <div class="card__row"><span class="card__icon">📅</span><span>${escapeHtml(dateFormatted)}</span></div>
    <div class="card__row"><span class="card__icon">🕐</span><span>${escapeHtml(timeFormatted)} · ${escapeHtml(duration)}</span></div>
    ${locationRow}
    ${descriptionBlock}
    ${attendeesBlock}
    ${conferenceRow}
    <div class="card__calendar">
      <div class="card__calendar-dot" style="background:${escapeHtml(calendarColor)};"></div>
      <span>${escapeHtml(calendarName)}</span>
    </div>
  </div>
  <div class="footer">HyperCalendar</div>
</div>
</body>
</html>`;
}

export const eventCardTemplate: TemplateRenderer<EventCardData> = { render };
