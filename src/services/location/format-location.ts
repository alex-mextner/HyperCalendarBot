// src/services/location/format-location.ts
import type { CalendarEvent } from '../../database/types.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { buildGoogleMapsSearchUrl } from './geocoding-service.ts';

type LocationFields = Pick<CalendarEvent, 'location' | 'google_maps_url' | 'resolved_address' | 'location_verified'> & {
  venue_name?: string | null;
};

/**
 * Format event location as an HTML link to Google Maps.
 * A verified location shows the resolved place (see formatLocationPlain) linked to its map URL, also
 * on an event with no typed text that a pin resolved; an unverified one shows exactly the typed text
 * linked to a map search for it, so an unconfirmed geocode never reaches the bot's cards, agendas or
 * reminders. Returns '' when there is nothing to show.
 */
export function formatLocationHtml(event: LocationFields): string {
  const place = formatLocationPlain(event);
  if (!place.trim()) return '';

  const displayText = escapeHtml(place);
  const verifiedUrl = event.location_verified === 1 ? event.google_maps_url : null;
  const url = verifiedUrl ?? buildGoogleMapsSearchUrl(event.location ?? place);
  // Encoded Unicode queries can exceed the HTML transport's indivisible tag budget.
  if (escapeHtml(url).length > 2000) return displayText;

  return `<a href="${escapeHtml(url)}">${displayText}</a>`;
}

/**
 * Format location as plain text (for contexts where HTML links aren't supported).
 * A verified location shows the resolved place ("Venue — Address"), also on an event with no typed
 * text that a pin resolved; an unverified one shows exactly the typed text, so an unconfirmed
 * geocode never leaves the bot.
 */
export function formatLocationPlain(
  event: Pick<CalendarEvent, 'location' | 'resolved_address' | 'location_verified'> & { venue_name?: string | null },
): string {
  if (event.location_verified !== 1) return event.location ?? '';
  if (event.venue_name) {
    return event.resolved_address ? `${event.venue_name} — ${event.resolved_address}` : event.venue_name;
  }
  return event.resolved_address ?? event.location ?? '';
}
