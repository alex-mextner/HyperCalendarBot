import { t } from '../../config/constants.ts';
import { formatDateShort, formatTime } from '../../utils/date.ts';

const DESC_MAX = 100;

interface InvitationTextInput {
  event: {
    title: string;
    start_utc: string;
    location?: string | null;
    description?: string | null;
  };
  inviterTimezone: string;
  deepLink: string;
  lang: 'en' | 'ru';
}

export function buildUserSessionInvitationText(input: InvitationTextInput): string {
  const { event, inviterTimezone, deepLink, lang } = input;
  const dateLine = `${formatDateShort(event.start_utc, inviterTimezone, lang)}, ${formatTime(event.start_utc, inviterTimezone)}`;
  const locationLine = event.location ? `\n📍 ${event.location}` : '';
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
