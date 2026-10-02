// Full-size image details remain readable when agenda cells overlap or truncate.
import type { EventDisplayMetadata } from '../../database/types.ts';
import { escapeHtml } from './helpers.ts';

export const agendaDetailsCSS = `
  .agenda-details { margin-top: 28px; font-size: 16px; line-height: 1.35; }
  .agenda-details__grid { display: grid; grid-template-columns: repeat(var(--agenda-details-columns, 2), minmax(0, 1fr)); gap: 0 18px; }
  .agenda-details__heading { font-size: 22px; margin-bottom: 12px; }
  .agenda-details__item { min-width: 0; padding: 9px 0; border-top: 1px solid currentColor; overflow-wrap: anywhere; white-space: normal; }
  .agenda-details__title { font-weight: 600; }
`;

export function renderAgendaDetails(
  events: { title: string; location?: string; displayMetadata?: EventDisplayMetadata; context?: string }[],
  locale: string,
  columns = 2,
): string {
  const items = events.filter((event) => event.location?.trim() || event.displayMetadata?.invitationStatus?.trim());
  if (!items.length) return '';
  return `<section class="agenda-details" style="--agenda-details-columns:${Math.max(1, Math.min(4, columns))}"><h2 class="agenda-details__heading">${locale === 'ru' ? 'Детали событий' : 'Event details'}</h2><div class="agenda-details__grid">${items
    .map((event) => {
      const status = event.displayMetadata?.invitationStatus;
      return `<div class="agenda-details__item"><div class="agenda-details__title">${escapeHtml(event.context ? `${event.context} · ${event.title}` : event.title)}</div>${event.location?.trim() ? `<div>📍 ${escapeHtml(event.location)}</div>` : ''}${status?.trim() ? `<div>✉️ ${escapeHtml(status)}</div>` : ''}</div>`;
    })
    .join('')}</div></section>`;
}
