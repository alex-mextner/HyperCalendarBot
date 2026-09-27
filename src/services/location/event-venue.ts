// src/services/location/event-venue.ts
// An event's confirmed place as a native Telegram venue: the Map button on event and invitation cards
// and the venue message it sends, so the point is shown on Telegram's own map.
import type { InlineKeyboard } from 'gramio';
import { CB, type Lang, t } from '../../config/constants.ts';
import type { CalendarEvent } from '../../database/types.ts';

/** The event fields a venue is built from. */
export type EventPlace = Pick<
  CalendarEvent,
  'id' | 'title' | 'location' | 'venue_name' | 'resolved_address' | 'latitude' | 'longitude'
>;

/** The `sendVenue` fields of an event's place. */
export interface EventVenue {
  latitude: number;
  longitude: number;
  title: string;
  address: string;
}

/**
 * The event's confirmed place as a venue, or null when it has no coordinates (the place was never
 * confirmed or was dropped). Titled with the venue name, else the typed text, else the event title;
 * addressed with the resolved address, else the coordinates (Telegram requires both).
 */
export function eventVenue(event: EventPlace): EventVenue | null {
  if (typeof event.latitude !== 'number' || typeof event.longitude !== 'number') return null;
  return {
    latitude: event.latitude,
    longitude: event.longitude,
    title: event.venue_name ?? event.location ?? event.title,
    address: event.resolved_address ?? `${event.latitude}, ${event.longitude}`,
  };
}

/** Append the Map button to `keyboard` when the event has a confirmed place. */
export function withMapButton(keyboard: InlineKeyboard, event: EventPlace | null, lang: Lang): InlineKeyboard {
  if (!event || !eventVenue(event)) return keyboard;
  return keyboard.row().text(t(lang).event_map_btn, `${CB.EVENT_MAP}:${event.id}`);
}
