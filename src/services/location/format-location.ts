// src/services/location/format-location.ts
import type { CalendarEvent } from '../../database/types.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { buildGoogleMapsSearchUrl } from './geocoding-service.ts';

/**
 * Format event location as an HTML link to Google Maps when possible.
 * If event has resolved coordinates/url, uses those.
 * Otherwise, generates a Google Maps search URL from the raw location text.
 */
export function formatLocationHtml(
  event: Pick<CalendarEvent, 'location' | 'google_maps_url' | 'resolved_address'>,
): string {
  if (!event.location) return '';

  const displayText = event.resolved_address ? escapeHtml(event.resolved_address) : escapeHtml(event.location);

  const url = event.google_maps_url ?? buildGoogleMapsSearchUrl(event.location);

  return `<a href="${escapeHtml(url)}">${displayText}</a>`;
}

/** Format location as plain text (for contexts where HTML links aren't supported) */
export function formatLocationPlain(event: Pick<CalendarEvent, 'location' | 'resolved_address'>): string {
  if (!event.location) return '';
  return event.resolved_address ?? event.location;
}
