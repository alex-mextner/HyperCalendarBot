import { t } from '../../config/constants.ts';
import type { CalendarEvent } from '../../database/types.ts';
import { formatDateShort, formatTime } from '../../utils/date.ts';
import { formatLocationPlain } from '../location/format-location.ts';

const DESC_MAX = 100;

interface InvitationTextInput {
  event: Pick<
    CalendarEvent,
    | 'title'
    | 'start_at'
    | 'description'
    | 'location'
    | 'resolved_address'
    | 'venue_name'
    | 'location_verified'
    | 'google_maps_url'
  >;
  inviterTimezone: string;
  deepLink: string;
  lang: 'en' | 'ru';
}

export function buildUserSessionInvitationText(input: InvitationTextInput): string {
  const { event, inviterTimezone, deepLink, lang } = input;
  const dateLine = `${formatDateShort(event.start_at, inviterTimezone, lang)}, ${formatTime(event.start_at, inviterTimezone)}`;
  const place = formatLocationPlain(event);
  // A map link only for a verified place: an unverified location stays exactly the typed text.
  const mapLine = place && event.location_verified === 1 && event.google_maps_url ? `\n${event.google_maps_url}` : '';
  const locationLine = place ? `\n📍 ${place}${mapLine}` : '';
  const descriptionLine = event.description ? `\n${truncate(event.description, DESC_MAX)}` : '';

  return t(lang).aiTools.sharing.userSessionInvitation({
    title: event.title,
    dateLine,
    locationLine,
    descriptionLine,
    deepLink,
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
