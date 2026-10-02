// Full-size image details remain readable when agenda cells overlap or truncate.
import type { EventDisplayMetadata } from '../../database/types.ts';
import { escapeHtml } from './helpers.ts';

export const agendaDetailsCSS = `
  .agenda-details { margin-top: 28px; font-size: 18px; line-height: 1.5; }
  .agenda-details__heading { font-size: 22px; margin-bottom: 12px; }
  .agenda-details__item { padding: 12px 0; border-top: 1px solid currentColor; overflow-wrap: anywhere; white-space: pre-wrap; }
  .agenda-details__title { font-weight: 600; }
`;

export function renderAgendaDetails(
  events: { title: string; location?: string; displayMetadata?: EventDisplayMetadata; context?: string }[],
  locale: string,
): string {
  const items = events.filter((event) => event.location?.trim() || event.displayMetadata?.invitationStatus?.trim());
  if (!items.length) return '';
  return `<section class="agenda-details"><h2 class="agenda-details__heading">${locale === 'ru' ? 'Детали событий' : 'Event details'}</h2>${items
    .map((event) => {
      const status = event.displayMetadata?.invitationStatus;
      return `<div class="agenda-details__item"><div class="agenda-details__title">${escapeHtml(event.context ? `${event.context} · ${event.title}` : event.title)}</div>${event.location?.trim() ? `<div>📍 ${escapeHtml(event.location)}</div>` : ''}${status?.trim() ? `<div>✉️ ${escapeHtml(status)}</div>` : ''}</div>`;
    })
    .join('')}</section>`;
}
