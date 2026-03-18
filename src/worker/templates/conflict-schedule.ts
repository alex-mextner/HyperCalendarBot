// src/worker/templates/conflict-schedule.ts

import { escapeHtml } from './helpers.ts';
import { sharedCSS } from './shared-css.ts';
import type { TemplateRenderer, Theme } from './types.ts';

export interface ConflictRow {
  label: string; // "Вы" or "@username" or display name
  isOrganizer: boolean;
  slots: ConflictSlot[];
}

export interface ConflictSlot {
  // minutes from window start
  offsetMinutes: number;
  durationMinutes: number;
  isBusy: boolean;
  label: string | null; // event title for organizer, "занято" for invitees
}

export interface ConflictScheduleData {
  eventStartIso: string;
  eventEndIso: string;
  windowStartIso: string;
  windowEndIso: string;
  rows: ConflictRow[];
  theme: Theme;
  locale: 'ru' | 'en';
}

const SLOT_WIDTH_PX = 60; // px per 30-min slot
const ROW_HEIGHT_PX = 56;
const LABEL_WIDTH_PX = 160;

function toMinutes(iso: string): number {
  return Math.round(new Date(iso).getTime() / 60_000);
}

function formatHM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function css(theme: Theme): string {
  const t = theme;
  return `
    ${sharedCSS({ bg: t.bg, textPrimary: t.textPrimary })}
    .grid-wrap {
      overflow-x: auto;
    }
    .header {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 32px;
      color: ${t.textPrimary};
    }
    .grid {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .time-labels {
      display: flex;
      margin-left: ${LABEL_WIDTH_PX}px;
      margin-bottom: 4px;
    }
    .time-label {
      width: ${SLOT_WIDTH_PX}px;
      font-size: 13px;
      color: ${t.textSecondary};
      text-align: center;
      flex-shrink: 0;
    }
    .row {
      display: flex;
      align-items: center;
      height: ${ROW_HEIGHT_PX}px;
    }
    .row-label {
      width: ${LABEL_WIDTH_PX}px;
      font-size: 15px;
      font-weight: 600;
      color: ${t.textPrimary};
      flex-shrink: 0;
      padding-right: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .slots {
      display: flex;
      flex: 1;
      position: relative;
      height: ${ROW_HEIGHT_PX - 8}px;
      background: ${t.cardBg};
      border-radius: 8px;
      overflow: hidden;
    }
    .slot {
      flex-shrink: 0;
      height: 100%;
      position: relative;
      border-right: 1px solid ${t.border};
    }
    .slot--free {
      background: #22C55E20;
    }
    .slot--busy {
      background: #EF444480;
    }
    .slot-text {
      font-size: 12px;
      font-weight: 600;
      color: #fff;
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .proposed-overlay {
      position: absolute;
      top: -1px;
      bottom: -1px;
      border: 3px solid #F59E0B;
      border-radius: 6px;
      pointer-events: none;
      z-index: 10;
    }
    .legend {
      display: flex;
      gap: 24px;
      margin-top: 24px;
      font-size: 14px;
      color: ${t.textSecondary};
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .legend-dot {
      width: 16px;
      height: 16px;
      border-radius: 4px;
      flex-shrink: 0;
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

export function renderConflictSchedule(data: ConflictScheduleData): string {
  const { eventStartIso, eventEndIso, windowStartIso, windowEndIso, rows, theme, locale } = data;

  const windowStartMin = toMinutes(windowStartIso);
  const windowEndMin = toMinutes(windowEndIso);
  const totalWindowMin = windowEndMin - windowStartMin;
  const slotCount = totalWindowMin / 30;

  const eventStartMin = toMinutes(eventStartIso);
  const eventEndMin = toMinutes(eventEndIso);

  // Time axis labels
  const timeLabels: string[] = [];
  for (let i = 0; i <= slotCount; i++) {
    const absoluteMin = windowStartMin + i * 30;
    timeLabels.push(formatHM(absoluteMin));
  }

  const timeLabelsHtml = timeLabels
    .slice(0, slotCount)
    .map((label) => `<div class="time-label">${escapeHtml(label)}</div>`)
    .join('');

  const busyLabel = locale === 'ru' ? 'занято' : 'busy';

  const rowsHtml = rows
    .map((row) => {
      // Build slot map: for each 30-min slot, is it busy?
      const busySlots = new Map<number, string | null>();
      for (const slot of row.slots) {
        const slotIndex = Math.floor(slot.offsetMinutes / 30);
        const endSlot = Math.ceil((slot.offsetMinutes + slot.durationMinutes) / 30);
        for (let s = slotIndex; s < endSlot; s++) {
          busySlots.set(s, slot.label);
        }
      }

      const slotsHtml: string[] = [];
      for (let i = 0; i < slotCount; i++) {
        const isBusy = busySlots.has(i);
        const label = isBusy ? (row.isOrganizer ? (busySlots.get(i) ?? busyLabel) : busyLabel) : '';
        const cls = isBusy ? 'slot slot--busy' : 'slot slot--free';
        const textHtml = label ? `<div class="slot-text">${escapeHtml(label)}</div>` : '';
        slotsHtml.push(`<div class="${cls}" style="width:${SLOT_WIDTH_PX}px;">${textHtml}</div>`);
      }

      // Proposed time overlay
      const propLeft = ((eventStartMin - windowStartMin) / 30) * SLOT_WIDTH_PX;
      const propWidth = ((eventEndMin - eventStartMin) / 30) * SLOT_WIDTH_PX;
      const proposedOverlay = `<div class="proposed-overlay" style="left:${propLeft}px;width:${propWidth}px;"></div>`;

      return `
        <div class="row">
          <div class="row-label">${escapeHtml(row.label)}</div>
          <div class="slots" style="width:${slotCount * SLOT_WIDTH_PX}px;">
            ${slotsHtml.join('')}
            ${proposedOverlay}
          </div>
        </div>`;
    })
    .join('');

  const title = locale === 'ru' ? 'Расписание участников' : 'Schedule Overview';
  const freeLegend = locale === 'ru' ? 'Свободно' : 'Free';
  const busyLegend = locale === 'ru' ? 'Занято' : 'Busy';
  const proposedLegend = locale === 'ru' ? 'Предлагаемое время' : 'Proposed time';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>${css(theme)}</style>
</head>
<body>
<div id="__root">
  <div class="header">${escapeHtml(title)}</div>
  <div class="grid-wrap">
    <div class="grid">
      <div class="time-labels">${timeLabelsHtml}</div>
      ${rowsHtml}
    </div>
  </div>
  <div class="legend">
    <div class="legend-item">
      <div class="legend-dot" style="background:#22C55E40;border:2px solid #22C55E;"></div>
      <span>${escapeHtml(freeLegend)}</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background:#EF444480;"></div>
      <span>${escapeHtml(busyLegend)}</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background:transparent;border:3px solid #F59E0B;border-radius:4px;"></div>
      <span>${escapeHtml(proposedLegend)}</span>
    </div>
  </div>
  <div class="footer">HyperCalendar</div>
</div>
</body>
</html>`;
}

export const conflictScheduleTemplate: TemplateRenderer<ConflictScheduleData> = {
  render: renderConflictSchedule,
};
