// src/services/location/format-location.ts
import type { CalendarEvent } from '../../database/types.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { buildGoogleMapsSearchUrl } from './geocoding-service.ts';

type LocationFields = Pick<CalendarEvent, 'location' | 'google_maps_url' | 'resolved_address'> & {
  venue_name?: string | null;
};

/**
 * Format event location as an HTML link to Google Maps.
 * Display text priority:
 *   1. venue_name + resolved_address ("Кофемания — ул. Большая Никитская, 12")
 *   2. venue_name alone
 *   3. resolved_address
 *   4. raw location
 */
export function formatLocationHtml(event: LocationFields): string {
  if (!event.location) return '';

  let displayText: string;
  if (event.venue_name) {
    displayText = event.resolved_address
      ? `${escapeHtml(event.venue_name)} — ${escapeHtml(event.resolved_address)}`
      : escapeHtml(event.venue_name);
  } else if (event.resolved_address) {
    displayText = escapeHtml(event.resolved_address);
  } else {
    displayText = escapeHtml(event.location);
  }

  const url = event.google_maps_url ?? buildGoogleMapsSearchUrl(event.location);

  return `<a href="${escapeHtml(url)}">${displayText}</a>`;
}

/** Format location as plain text (for contexts where HTML links aren't supported) */
export function formatLocationPlain(
  event: Pick<CalendarEvent, 'location' | 'resolved_address'> & { venue_name?: string | null },
): string {
  if (!event.location) return '';
  if (event.venue_name) {
    return event.resolved_address ? `${event.venue_name} — ${event.resolved_address}` : event.venue_name;
  }
  return event.resolved_address ?? event.location;
}
