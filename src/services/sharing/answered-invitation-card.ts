// What an invitee's invitation message shows once they answered: the answer, then their view of the event.
import { type Lang, t } from '../../config/constants.ts';
import type { AgendaRepository } from '../../database/repositories/agenda.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import { botLogger } from '../../utils/logger.ts';
import { enrichAgendaEvents } from '../event/agenda-enrichment.ts';
import { appendInvitationRoster, formatEventDetail } from '../event/formatters.ts';
import type { WeatherService } from '../weather/weather-service.ts';
import type { InvitationRoster } from './invitation-roster.ts';

const logger = botLogger.child({ module: 'answered-invitation-card' });

export type InvitationAnswer = 'accepted' | 'declined' | 'maybe';

export interface AnsweredInvitationViewer {
  userId: number;
  language: Lang;
  /** Viewer's timezone — anchors the weather forecast lookup */
  timezone: string;
  groupId?: number;
}

export interface AnsweredInvitationCardDeps {
  agendaRepository?: AgendaRepository;
  weatherService?: Pick<WeatherService, 'getForecastAt'>;
}

export function invitationAnswerLabel(answer: InvitationAnswer, lang: Lang): string {
  const msgs = t(lang);
  if (answer === 'accepted') return msgs.invitation_accepted;
  return answer === 'declined' ? msgs.invitation_declined : msgs.invitation_maybe;
}

/**
 * Answer line plus the event card; an accepted card also carries the forecast for the event start.
 * With a roster the card lists everyone's answer, the reader's included, so the agenda's single
 * own-answer line is left out.
 */
export async function formatAnsweredInvitationCard(
  answer: InvitationAnswer,
  event: CalendarEvent | null,
  viewer: AnsweredInvitationViewer,
  deps: AnsweredInvitationCardDeps,
  roster: InvitationRoster | null = null,
): Promise<string> {
  const label = invitationAnswerLabel(answer, viewer.language);
  if (!event) return label;

  // Forecast anchored to event start (hourly when within 48h, daily within 7 days).
  // For all-day events the daily forecast is used regardless — no midnight temperature.
  const forecast =
    deps.weatherService && answer === 'accepted'
      ? await deps.weatherService
          .getForecastAt(viewer.timezone, new Date(event.start_at).getTime(), viewer.language, {
            allDay: event.all_day === 1,
          })
          .catch((err: unknown) => {
            logger.warn({ err, eventId: event.id }, 'Forecast unavailable for answered invitation card');
            return null;
          })
      : null;
  const shown = roster
    ? event
    : enrichAgendaEvents(
        [event],
        { userId: viewer.userId, language: viewer.language, groupId: viewer.groupId },
        deps.agendaRepository,
      )[0]!;
  const card = formatEventDetail(shown, event.timezone, viewer.language, { forecast });
  return appendInvitationRoster(`${label}\n\n${card}`, roster, viewer.language);
}
