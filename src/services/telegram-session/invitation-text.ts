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
  botUsername: string;
  lang: 'en' | 'ru';
}

/** Telegram entity positions are UTF-16 code units, matching JavaScript string.length. */
export interface ItalicFooter {
  offset: number;
  length: number;
}

export function buildUserSessionInvitationText(input: InvitationTextInput): {
  text: string;
  italicFooter?: ItalicFooter;
} {
  const { event, inviterTimezone, deepLink, botUsername, lang } = input;
  const dateLine = `${formatDateShort(event.start_at, inviterTimezone, lang)}, ${formatTime(event.start_at, inviterTimezone)}`;
  const place = formatLocationPlain(event);
  // A map link only for a verified place: an unverified location stays exactly the typed text.
  const mapLine = place && event.location_verified === 1 && event.google_maps_url ? `\n${event.google_maps_url}` : '';
  const locationLine = place ? `\n📍 ${place}${mapLine}` : '';
  const descriptionLine = event.description ? `\n${truncate(event.description, DESC_MAX)}` : '';

  const body = t(lang).aiTools.sharing.userSessionInvitation({
    title: event.title,
    dateLine,
    locationLine,
    descriptionLine,
    deepLink,
  });
  const footer = t(lang).aiTools.sharing.userSessionInvitationFooter(botUsername);
  const text = `${body}\n\n${footer}`;
  // Count UTF-16 units conservatively: a cosmetic footer must not make an invitation too long.
  if (text.length > 4096) return { text: body };
  return {
    text,
    italicFooter: { offset: body.length + 2, length: footer.length },
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
