// src/services/image/render-conflict.ts

import type { ConflictRow, ConflictScheduleData } from '../../worker/templates/conflict-schedule.ts';
import { getTheme } from '../../worker/templates/themes.ts';
import type { ConflictResult } from '../invite/conflict-service.ts';
import type { ImageRenderer } from './render-service.ts';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function toMinutes(iso: string): number {
  return Math.round(new Date(iso).getTime() / 60_000);
}

export async function renderConflictImage(
  renderService: ImageRenderer,
  organizerId: number,
  organizerLabel: string,
  organizerEvents: { startAt: string; endAt: string; title: string }[],
  inviteeConflicts: ConflictResult[],
  eventStart: string,
  eventEnd: string,
  locale: 'ru' | 'en',
): Promise<Buffer> {
  const startMs = new Date(eventStart).getTime();
  const endMs = new Date(eventEnd).getTime();
  const windowStartIso = new Date(startMs - TWO_HOURS_MS).toISOString();
  const windowEndIso = new Date(endMs + TWO_HOURS_MS).toISOString();
  const windowStartMin = toMinutes(windowStartIso);

  function buildSlots(
    events: { startAt: string; endAt: string; title?: string | null }[],
    isOrganizer: boolean,
  ): ConflictRow['slots'] {
    return events.map((ev) => {
      const startMin = toMinutes(ev.startAt);
      const endMin = toMinutes(ev.endAt);
      return {
        offsetMinutes: startMin - windowStartMin,
        durationMinutes: Math.max(endMin - startMin, 30),
        isBusy: true,
        label: isOrganizer ? (ev.title ?? null) : null,
      };
    });
  }

  const rows: ConflictRow[] = [];

  // Organizer row
  rows.push({
    label: locale === 'ru' ? `Вы (${organizerLabel})` : `You (${organizerLabel})`,
    isOrganizer: true,
    slots: buildSlots(organizerEvents, true),
  });

  // Invitee rows
  for (const conflict of inviteeConflicts) {
    const user = { telegram_id: conflict.userId, username: conflict.username };
    const label = user.username ? `@${user.username}` : `#${user.telegram_id}`;
    rows.push({
      label,
      isOrganizer: false,
      slots: buildSlots(
        conflict.conflictingEvents.map((e) => ({ startAt: e.startAt, endAt: e.endAt, title: e.title })),
        false,
      ),
    });
  }

  const data: ConflictScheduleData = {
    eventStartIso: eventStart,
    eventEndIso: eventEnd,
    windowStartIso,
    windowEndIso,
    rows,
    theme: getTheme(),
    locale,
  };

  return renderService.renderDirect({
    type: 'conflict-schedule',
    data,
    userId: organizerId,
  });
}
